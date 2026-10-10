/**
 * 这个文件是干什么的：
 * AI 调用的失败熔断账（data/ai-failures.json）。**同一句话连着失败若干次，就不再发它。**
 *
 * 你需要知道的：
 *
 * 1. **为什么需要它**：改之前 `callAI` 失败就抛，一轮进化白跑。今天下午就撞上一次
 *    连续两次一样的调用把整轮掐掉——不是模型不行，是同一个请求重复付钱、重复超时。
 *    自动进化是收盘后无人值守跑的，白跑一趟没有人在场发现。
 *
 * 2. **规则照抄 Vibe-Trading 的 Research Workflow**（README:556-566），原文：
 *      - "one retry after a transient failure (a rate limit, a network blip, a tool
 *        timeout) still runs" → **瞬时失败允许重试一次**
 *      - "An identical call is refused from its SECOND failure onward" → **第二次起拒绝**
 *      - "changed arguments can always execute" → **改了参数就放行**（指纹变了就是新调用）
 *    前两条在这里体现为 `AI_MAX_SAME_FAILURE = 2`：失败 1 次还能发，失败 2 次拒绝。
 *
 * 3. **指纹怎么算**：model + prompt 的 sha256。**不含 baseUrl 和 key**——
 *    换了模型算新调用（值得试），换了档案算同一句话（问题在 key，换档案也没用，
 *    而且会让熔断失效）。prompt 逐字进 hash，所以改一个字就是新指纹。
 *
 * 4. **成功即清零，而且带 TTL**：超过 24 小时的失败记录直接当没有。
 *    否则一次网络事故会把某个 prompt 永久封死，再也没机会自愈——
 *    而模型侧的问题（401、欠费）应该在当天暴露，不是永久拉黑。
 *
 * 5. **纯判定函数不碰 fs**（book 进 book 出），所以能单测。fs 部分照 `ai-usage.ts`
 *    的范式：读不到/坏了就当空账，写失败只打日志不影响调用结果。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** 同一指纹连续失败多少次后拒绝再发。2 = 允许重试 1 次，之后拒绝。 */
export const AI_MAX_SAME_FAILURE = 2;

/** 失败记录多久算过期（毫秒）。从**最后一次失败**算起，不是第一次。超时的当没失败过
 *  ——模型侧的问题（401、欠费）应该在当天暴露，不是永久拉黑。 */
export const AI_FAILURE_TTL_MS = 24 * 60 * 60 * 1000;

export type AIFailure = {
  /** 连续失败次数。达上限后封顶不再累加（数字继续涨没有信息量）。 */
  count: number;
  /** 这次失败的时间（ISO）。 */
  at: string;
  /** 上次的失败原因，截断到 200 字。 */
  reason: string;
};

/** 账本：指纹 → 失败记录。 */
export type AIFailureBook = Record<string, AIFailure>;

/** 指纹：model + prompt 的 sha256 前 16 位。不含 baseUrl / key，理由见文件头第 3 条。 */
export function fingerprint(model: string, prompt: string): string {
  return createHash("sha256").update(`${model}\n${prompt}`).digest("hex").slice(0, 16);
}

function expired(entry: AIFailure | undefined, now: number, ttlMs: number): boolean {
  if (!entry) return true;
  const at = Date.parse(entry.at);
  // 时间戳坏了也当过期——宁可多发一次，也不要因为一条脏数据把 prompt 永久封死。
  if (!Number.isFinite(at)) return true;
  return now - at > ttlMs;
}

export type AttemptVerdict = {
  /** 能不能发这一枪。false 时 reason 是给人看的中文说明。 */
  ok: boolean;
  reason: string;
};

/**
 * 这一枪能不能发。
 *
 * 判定顺序刻意写成「先看新鲜度，再看次数」：过期的失败记录优先被忽略，
 * 否则一条三天前的 401 会把今天本该能跑的一轮掐掉。
 */
export function canAttempt(
  book: AIFailureBook,
  fp: string,
  opts: { now?: number; max?: number; ttlMs?: number } = {},
): AttemptVerdict {
  const now = opts.now ?? Date.now();
  const max = opts.max ?? AI_MAX_SAME_FAILURE;
  const ttlMs = opts.ttlMs ?? AI_FAILURE_TTL_MS;
  const entry = book[fp];
  if (expired(entry, now, ttlMs)) return { ok: true, reason: "" };
  const count = entry?.count ?? 0;
  if (count >= max) {
    return {
      ok: false,
      reason: `同一句话已连续失败 ${count} 次（上次：${entry?.reason ?? "未知"}），不再重发。改了 prompt 或换模型会自动放行。`,
    };
  }
  return { ok: true, reason: "" };
}

/** 记一次失败，返回**新账**（不改入参）。到上限后封顶。 */
export function recordFailure(
  book: AIFailureBook,
  fp: string,
  reason: string,
  opts: { now?: number; max?: number } = {},
): AIFailureBook {
  const now = opts.now ?? Date.now();
  const max = opts.max ?? AI_MAX_SAME_FAILURE;
  const prev = book[fp];
  const count = Math.min(prev?.count ?? 0, max - 1) + 1;
  return { ...book, [fp]: { count, at: new Date(now).toISOString(), reason: reason.slice(0, 200) } };
}

/** 成功即清零，返回新账。成功过就说明这通话是通的，旧失败不该再影响它。 */
export function clearFailure(book: AIFailureBook, fp: string): AIFailureBook {
  if (!(fp in book)) return book;
  const next = { ...book };
  delete next[fp];
  return next;
}

// ── 落盘（照 ai-usage.ts 的范式）────────────────────────────────────

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

const failuresPath = () => join(dataDir(), "ai-failures.json");

/** 读熔断账。文件不存在或坏了 → 空账，绝不抛错。 */
export async function readAIFailures(): Promise<AIFailureBook> {
  try {
    const parsed = JSON.parse(await readFile(failuresPath(), "utf8")) as Record<string, unknown>;
    const out: AIFailureBook = {};
    for (const [key, value] of Object.entries(parsed)) {
      const entry = value as Partial<AIFailure>;
      if (typeof entry?.count !== "number" || typeof entry?.at !== "string") continue;
      out[key] = { count: entry.count, at: entry.at, reason: typeof entry.reason === "string" ? entry.reason : "" };
    }
    return out;
  } catch {
    return {};
  }
}

/** 写熔断账。写失败只打日志——它是护栏，护栏自己不能把主流程带崩。 */
export async function writeAIFailures(book: AIFailureBook): Promise<void> {
  try {
    await mkdir(dataDir(), { recursive: true });
    await writeFile(failuresPath(), JSON.stringify(book, null, 2));
  } catch (error) {
    console.error("ai-failures 写入失败（不影响调用结果）:", (error as Error).message);
  }
}
