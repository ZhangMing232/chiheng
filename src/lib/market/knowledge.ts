/**
 * 这个文件是干什么的：
 * 公司知识档案（A5，对标 Vibe-Research 的 `knowledge/companies/`）。
 *
 * 它的机制：公司研究沉淀成档案 + manifest 索引，catalyst-risk SOP §4 要求
 * 「旧结论与实时数据冲突时用实时数据反证，逐条裁决」。
 *
 * 赤轨版的做法（比它更进一步，代码可判）：
 * 档案不只存结论，**存「待验证的预言」**——上次研判的裁决点。下次研判同一只票时，
 * 自动核对：上次说「盯近 20 日涨幅方向」，这次回答「它已经掉头了 / 还没」。
 * 这样档案是活的——不是一堆过期的结论，是一组持续被验证或推翻的预警。
 *
 * 你需要知道的（纪律）：
 * 1. **旧结论不许当事实引用**（它 §4 同条）。旧结论只能作为「待验证项」，
 *    与实时数据冲突时以实时数据为准，并在报告里逐条裁决。
 * 2. 核对不了的要明说（缺数据就说「待人工核对」），不许猜。
 * 3. 档案是快照不是流水账：一只票一份，新的覆盖旧的，被覆盖的结论进入「已裁决」列表。
 */

import type { DecisionPoint } from "./catalyst-sop.ts";
import type { ValuationPosition } from "./pe-history.ts";
import type { Quote } from "./types.ts";

/** 一只票的知识档案（一只一份，快照式）。 */
export type KnowledgeFile = {
  symbol: string;
  name: string;
  /** 归档时间 */
  savedAt: string;
  /** 来源报告 id（可回溯到 data/reports/） */
  reportId: string;
  /** 上次的强结论（「有依据的推断」及以上） */
  conclusions: string[];
  /** 上次的裁决点（待验证的预言） */
  points: DecisionPoint[];
  /** 上次归档时的关键快照：d20 与分位档位（核对裁决点要用） */
  snapshot: { d20: number | null; peRank: number | null; pbRank: number | null };
};

export type PointCheck = {
  point: DecisionPoint;
  /** triggered = 上次的预警应验了；watching = 还没触发，继续盯；cannot-check = 缺数据 */
  status: "triggered" | "watching" | "cannot-check";
  detail: string;
};

/** 分位档位：低分位 / 中段 / 高分位。 */
function rankBand(rank: number | null): string {
  if (rank == null) return "unknown";
  if (rank < 20) return "low";
  if (rank >= 80) return "high";
  return "mid";
}

/**
 * 核对旧裁决点。
 *
 * 能自动核对的（代码判）：近 20 日涨幅方向穿越 0、分位档位切换。
 * 不能自动核对的（缺历史序列等）：标 cannot-check，说清缺什么。
 */
export function checkOldPoints(old: KnowledgeFile, quote: Quote | null, valuation: ValuationPosition | null): PointCheck[] {
  return old.points.map((p) => {
    // 裁决点 1：近 20 日涨幅方向掉头（可核对 d20 变号）
    if (p.from === "price" && p.object.includes("近 20 日涨幅")) {
      const before = old.snapshot.d20;
      const now = quote?.d20 ?? null;
      if (before == null || now == null) {
        return { point: p, status: "cannot-check", detail: "上次或这次的近 20 日涨幅缺失，核对不了" };
      }
      const flipped = before * now < 0 || (before === 0) !== (now === 0);
      return {
        point: p,
        status: flipped ? "triggered" : "watching",
        detail: flipped ? `上次是 ${before.toFixed(2)}%，这次 ${now.toFixed(2)}%，方向确实变了` : `上次 ${before.toFixed(2)}%，这次 ${now.toFixed(2)}%，还没掉头`,
      };
    }

    // 裁决点 2：PE/PB 分位档位切换（可核对档位变化）
    if (p.from === "valuation" && p.object.includes("分位")) {
      const before = rankBand(old.snapshot.peRank);
      const now = rankBand(valuation?.peRank ?? null);
      if (before === "unknown" || now === "unknown") {
        return { point: p, status: "cannot-check", detail: "上次或这次的分位缺失，核对不了" };
      }
      const changed = before !== now;
      return {
        point: p,
        status: changed ? "triggered" : "watching",
        detail: changed ? `上次在 ${before} 档，这次在 ${now} 档，档位确实切换了` : `上次和这次都在 ${now} 档，还没切换`,
      };
    }

    // 其余（资金同向、否决性公告、补数据）：缺历史序列，人工核对
    return { point: p, status: "cannot-check", detail: `「${p.object}」需要逐日核对（赤轨缺这个历史序列），标记为待人工核对` };
  });
}

/** 档案摘要（manifest 索引用，一行一只票）。 */
export function knowledgeSummary(file: KnowledgeFile): string {
  return `${file.name}（${file.symbol}）· ${file.points.length} 个待验证预警 · 归档于 ${file.savedAt.slice(0, 10)}`;
}

/** 给 AI prompt 的「旧结论反证」段。没有旧档案返回空串。 */
export function knowledgePrompt(file: KnowledgeFile, checks: readonly PointCheck[]): string {
  const lines = [
    "## 旧结论反证（知识档案，只作待验证项，不是事实）",
    `这是 ${file.name} 上次研判（${file.savedAt.slice(0, 10)}）留下的预警。**旧结论不许当事实引用**，冲突时以本次实时数据为准。`,
    "",
    "已核对的预警：",
  ];
  for (const c of checks) {
    const tag = c.status === "triggered" ? "✅ 已应验" : c.status === "watching" ? "⏳ 未触发" : "❓ 待人工核对";
    lines.push(`- ${tag}：${c.point.object} —— ${c.detail}`);
  }
  lines.push("");
  lines.push("要求：本次研判先回答这些预警的现状（应验/未触发/待核对），再给新结论。不要把旧结论直接复述成事实。");
  return lines.join("\n");
}
