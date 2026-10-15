/**
 * 这个文件是干什么的：
 * 因子「死因画像」——把死因档案（factor-tombstones.ts）聚合成几行中文，
 * 注入 AI 提议因子的 prompt，让闭环「长记性」。
 *
 * 你需要知道的：
 * 1. 纯函数不碰 fs，单测钉口径。聚合分两层：**面的统计**（什么死因最高发、
 *    哪个类别全军覆没——AI 每次只看到单个判决，看不到这个）+ **点的名单**
 *    （每个死因子一行：败在哪几关、原表达式、当初为什么信它）。
 * 2. 名单按死亡时间倒序、截断到 maxList 条——prompt 不能无限长，
 *    老的死法聚合进「面的统计」就够了，名单给最近的。
 * 3. 关名用 GATE_LEGEND 的中文标签（单调/显著/两段/换样本/多重检验/可交易），
 *    不给 AI 只看 g1/g2 代号——它每次都要重新猜 g3 是什么。
 * 4. 衰减退役（failedGates 为空）和 6 关打死分开写，别读成「全过」。
 */

import { GATE_KEYS, GATE_LEGEND } from "./factors-view.ts";
import type { TombstoneRecord } from "./factor-tombstones.ts";

const GATE_LABEL = new Map(GATE_LEGEND.map((gate) => [gate.key, gate.label]));

function failedLabel(record: TombstoneRecord): string {
  if (record.failedGates.length === 0) return "衰减退役（不是 6 关打死）";
  return `败于 ${record.failedGates.map((key) => GATE_LABEL.get(key as never) ?? key).join("/")}`;
}

/** 截断自由文本，prompt 里一行别太长。 */
function clip(text: string, max: number): string {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * 死因档案 → prompt 段落（string[]，直接展开拼进 prompt）。
 * 空档案返回空数组（调用方不拼这一段）。
 */
export function necropsyLines(records: TombstoneRecord[], maxList = 20): string[] {
  if (records.length === 0) return [];

  // 面的统计：按死因模式和类别各数一遍。模式键是败关集合的排序拼接，
  // 衰减退役（空数组）单独成键——空串做键容易和脏数据混，给它个明确名字。
  const byPattern = new Map<string, number>();
  const byCategory = new Map<string, number>();
  let decayed = 0;
  for (const record of records) {
    if (record.failedGates.length === 0) {
      decayed += 1;
      continue;
    }
    const pattern = [...record.failedGates].sort().map((key) => GATE_LABEL.get(key as never) ?? key).join("+");
    byPattern.set(pattern, (byPattern.get(pattern) ?? 0) + 1);
    byCategory.set(record.category, (byCategory.get(record.category) ?? 0) + 1);
  }
  const patternText = [...byPattern.entries()].sort((a, b) => b[1] - a[1]).map(([pattern, count]) => `「${pattern}」×${count}`).join("、");
  const categoryText = [...byCategory.entries()].sort((a, b) => b[1] - a[1]).map(([category, count]) => `${category}×${count}`).join("、");

  const header =
    `死因档案共 ${records.length} 条：${patternText}${decayed > 0 ? `、衰减退役×${decayed}` : ""}。` +
    `按类别：${categoryText || "—"}。` +
    (patternText.includes("单调")
      ? "「单调也挂」说明信号形状不对或太弱，别再提同形状的微调变体。"
      : "");

  // 点的名单：新死在前。AI 最新提议最容易撞上的就是最近的死法。
  const listed = [...records].sort((a, b) => b.diedAt.localeCompare(a.diedAt)).slice(0, maxList);
  const lines = listed.map(
    (record) =>
      `- ${record.name}（${record.category}）：${failedLabel(record)}；` +
      `expr=${clip(record.expr, 40)}；当初逻辑：${clip(record.rationale, 60)}`,
  );

  return [header, ...lines];
}

/** 供单测和调用方核对：关名表必须覆盖全部 6 关，缺一个标签就退回代号。 */
export function gateLabelCoverage(): boolean {
  return GATE_KEYS.every((key) => GATE_LABEL.has(key));
}
