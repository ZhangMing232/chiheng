/**
 * 这个文件是干什么的：
 * 把 `AI-BOUNDARY.md` 从「给人看的文档」变成「**代码也认的常量**」。
 *
 * ## 为什么要有它（这是赤轨比 Vibe 强的一招）
 *
 * Vibe-Research 把宪法 `methodology/constitution.md` 的 **sha256 记进 manifest**，
 * 那是**事后**可查：跑完一次研究，能查出当时用的是哪版纪律。
 *
 * 赤轨再加一层：**文档与代码的一致性由 `npm test` 事前钉住**。
 * `boundary.test.ts` 会去解析 `AI-BOUNDARY.md`，断言
 *
 *   文档里「禁止清单」的条数 === `PROHIBITIONS.length`
 *   文档里「§0 不可越线」的条数 === `IMMUTABLE_LINES.length`
 *
 * 于是**改了文档没改常量（或反之）会直接测试失败**，而不是等到出事才发现两处对不上。
 * 这符合 `AI-BOUNDARY.md` 自己的改动纪律（L49-52）：新增条目必须同时给闸门函数位置 + 测试文件。
 *
 * ## 注意
 *
 * 这里只放**清单本身**（id + 标题 + 对应的硬闸门位置），不复制正文。
 * 正文解释仍以 `AI-BOUNDARY.md` 为准 —— 两处都写解释必然漂移。
 * `boundaryHash()` 用于把「当时用哪版边界」记进运行产物（P0-6 的 manifest.json）。
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** 边界文档的路径（相对仓库根）。cwd 陷阱见 preflight.ts 文件头第 4 条。 */
export const BOUNDARY_PATH = "AI-BOUNDARY.md";

/** 版本号。改了就要同步改 `AI-BOUNDARY.md`，否则测试红。 */
export const BOUNDARY_VERSION = "2.0.0";

export type Rule = {
  id: string;
  /** 标题，与文档里那一条的开头一致（测试据此对账）。 */
  title: string;
  /** 对应的硬闸门实现位置。**没有闸门的位置就不许加条目** —— AI-BOUNDARY.md 的纪律。 */
  gate: string;
};

/** §0 三条不可越线。 */
export const IMMUTABLE_LINES: Rule[] = [
  {
    id: "no-advice",
    title: "不给投资动作建议",
    gate: "red-line.ts:screenAdvice + RED_LINE_PROMPT",
  },
  {
    id: "no-fabricate",
    title: "不编造没取到的数",
    gate: "registry.ts:critical（失败→incomplete）+ evidence.ts",
  },
  {
    id: "verdict-only-by-fn",
    title: "判决只由预登记函数给，AI 只提议",
    gate: "factors.ts / challenger.ts / strategy-gate.ts 的判决函数",
  },
];

/** 禁止清单六条（对应文档 `## ❌ 禁止清单`）。 */
export const PROHIBITIONS: Rule[] = [
  {
    id: "no-verdict",
    title: "碰判决函数",
    gate: "factors.ts（6关）/ challenger.ts（Welch）/ strategy-gate.ts（策略闸）",
  },
  {
    id: "no-book",
    title: "碰账本和持仓",
    gate: "book-file.ts + record-journal.ts",
  },
  {
    id: "no-threshold",
    title: "碰开关和阈值",
    gate: "system-rules.ts + CHALLENGER_RULE + DECAY_RULE",
  },
  {
    id: "no-breaker-reset",
    title: "绕过熔断",
    gate: "evolve-breaker.ts（恢复只走 /ai 页人工重开）",
  },
  {
    id: "no-expr-bypass",
    title: "绕过校验进表达式",
    gate: "factor-expr.ts:validateFactorExpr（无 eval、无第二条入口）",
  },
  {
    id: "no-retune",
    title: "调参过关",
    gate: "factor-queue.ts:updateQueueAfterRun（进队列后 direction/expr 不改）",
  },
];

/**
 * 边界文档的 sha256。记进运行产物的 manifest，用于事后回答
 * 「这批判决是照着哪一版纪律跑的」。
 *
 * 读不到返回 null（不抛错）—— 它只是留档用，不该因为一个文档读取失败就把主流程带崩。
 */
export async function boundaryHash(root = process.cwd()): Promise<string | null> {
  try {
    const text = await readFile(join(root, BOUNDARY_PATH), "utf8");
    return sha256(text);
  } catch {
    return null;
  }
}

/** sha256，前 16 位。与 ai-retry.ts 的 fingerprint 同一套约定。 */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}

/**
 * 解析边界文档，返回各段条目数。给测试对账用。
 *
 * 只数**编号条目**（`1. ` 开头），不数正文——避免正文里出现 "1." 就误判。
 */
export type BoundaryCounts = { immutable: number; prohibitions: number };

export function countBoundaryRules(md: string): BoundaryCounts {
  return {
    immutable: countNumberedUnder(md, "§0 三条不可越线"),
    prohibitions: countNumberedUnder(md, "❌ 禁止清单"),
  };
}

/** 数某个 `## ` 标题下、到下一个 `## ` 之前，有多少条 `N. ` 开头的条目。 */
function countNumberedUnder(md: string, heading: string): number {
  const lines = md.split("\n");
  let inside = false;
  let n = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("## ")) {
      inside = line.includes(heading);
      continue;
    }
    if (!inside) continue;
    if (/^\d+\.\s/.test(line)) n += 1;
  }
  return n;
}
