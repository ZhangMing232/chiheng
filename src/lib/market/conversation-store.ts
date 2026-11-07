/**
 * 这个文件是干什么的：
 * 「大管家」对话的落盘。AI 答过的、用户问过的，要能事后查，而且刷新不能丢。
 *
 * 为什么单独一套、不复用 report-store：
 * 报告是「一次性研判产物」（七阶段 + AI 综合），对话是「流式多轮问答」，两种
 * 形态读写节奏不同——报告一次写一份、从不追加；对话每次问答追加两行。硬塞进
 * report-store 只会把它的语义搅浑。这里只管对话，模式照搬它的安全与落盘纪律：
 *
 * 纪律（和 report-store 对齐）：
 * 1. 用户 id 白名单与 book-file.ts safeUserId 同规则（不 import，避免 fs 链路进客户端）。
 * 2. 数据落在 `data/conversations/<userId>/history.jsonl`，不在 git 里——换机器读不到是预期。
 * 3. 索引是 JSONL 追加，不覆盖；半行（写一半断电）解析时静默跳过，不算一条。
 * 4. **每人一份**（开放注册后别人的对话不能串到「我的」里）。dev-user 是未开登录时
 *    的本机主人，新注册用户从空对话开始。
 * 5. 落盘只追加、不回写整文件（避开并发重写把另一进程的追加冲掉）。上下文窗口由
 *    读取方按 MAX_CONTEXT_TURNS 切片，存盘保留全量，方便以后翻旧账。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

/** 用户 id 只允许字母、数字、下划线和减号（与 book-file.ts safeUserId 同规则）。 */
function safeUserId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("无效的用户");
  return id;
}

/** 某人的对话目录。data 不在 git，换机器必然读不到——这是预期不是错误。 */
export function conversationDir(userId: string, root = process.cwd()): string {
  return join(root, "data", "conversations", safeUserId(userId));
}

export type ChatRole = "user" | "butler";

/** 一条对话消息（落盘形态）。at 是 ISO 时间，读取方按它排序/切片。 */
export type ChatMessage = { role: ChatRole; text: string; at: string };

/** 客户端传上来的历史项：只有角色和文本，时间由服务端落盘时补。 */
export type ChatTurn = { role: ChatRole; text: string };

/**
 * 上下文窗口上限（轮数）。一问一答算一轮，所以消息数上限是 2 倍。
 * 超出部分不进 prompt，但全量仍留在磁盘，以后要翻旧账也翻得到。
 */
export const MAX_CONTEXT_TURNS = 16;

function isChatTurn(x: unknown): x is ChatTurn {
  if (typeof x !== "object" || x === null) return false;
  const r = (x as ChatTurn).role;
  const t = (x as ChatTurn).text;
  return (r === "user" || r === "butler") && typeof t === "string";
}

/** 读某人的全量对话。文件不在（没聊过 / 换了机器）= 空数组，不报错。 */
export async function loadHistory(userId: string, root = process.cwd()): Promise<ChatMessage[]> {
  const id = safeUserId(userId);
  try {
    const raw = await readFile(join(conversationDir(id, root), "history.jsonl"), "utf-8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          const m = JSON.parse(line) as ChatMessage;
          return isChatTurn(m) && typeof m.at === "string" ? m : null;
        } catch {
          return null; // 半行（写一半断电）不算一条，静默跳过
        }
      })
      .filter((m): m is ChatMessage => m != null);
  } catch {
    return [];
  }
}

/** 追加一批消息（通常是一轮：用户一条 + 大管家一条）。落盘时补上当前时间。 */
export async function appendMessages(
  userId: string,
  turns: ChatTurn[],
  root = process.cwd(),
): Promise<void> {
  const id = safeUserId(userId);
  const clean = turns.filter(isChatTurn);
  if (clean.length === 0) return;
  const at = new Date().toISOString();
  const lines = clean.map((t) => `${JSON.stringify({ role: t.role, text: t.text, at })}\n`).join("");
  const dir = conversationDir(id, root);
  await mkdir(dir, { recursive: true });
  // O_APPEND 在 posix 上对短写入是原子的；不重写整文件，避免并发追加互相覆盖。
  await appendFile(join(dir, "history.jsonl"), lines, "utf-8");
}

/** 清空某人的对话。文件不存在也不报错（本来就是空的）。 */
export async function clearHistory(userId: string, root = process.cwd()): Promise<void> {
  const id = safeUserId(userId);
  try {
    await mkdir(conversationDir(id, root), { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(conversationDir(id, root), "history.jsonl"), "", "utf-8");
  } catch {
    /* 没有可清的 */
  }
}
