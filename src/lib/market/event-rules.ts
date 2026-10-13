/**
 * 这个文件是干什么的：
 * 从公告标题识别事件类型（A2 事件研究的数据入口，对标它的 event_study.py KINDS 表）。
 *
 * 它的 8 类事件（A 股 7 类）：业绩预告 / 重要股东增持 / 重要股东减持 / 回购方案 /
 * 机构调研 / 龙虎榜上榜 / 限售解禁。赤轨的数据源是巨潮公告（news.ts 的 StockArticle，
 * kind === "ann"），所以这里做的是**标题关键词 → 事件类型**的映射。
 *
 * 你需要知道的（纪律）：
 * 1. **识别不了的不猜**：标题对不上任何一类就丢掉，不进事件列表。把普通公告
 *    硬塞进某一类，算出来的「历史超额」就是假的（它 _forecast_events 同条纪律：
 *    宁可少一类，不可错一类）。
 * 2. **一条公告只归一类**（按下面的顺序取第一个命中的），避免同一条被算两次
 *    把样本数灌水。
 * 3. 事件日期用公告日（time 的日期部分），和 K 线对齐——PIT 纪律一致。
 */

import type { StudyEvent } from "./event-study.ts";

export type EventKind = "earnings_forecast" | "holder_increase" | "holder_decrease" | "buyback" | "survey" | "dragon_tiger" | "lockup";

/** 关键词表：按顺序取第一个命中的类（顺序即优先级）。 */
const RULES: { kind: EventKind; label: string; direction?: string; words: readonly string[] }[] = [
  { kind: "earnings_forecast", label: "业绩预告", words: ["业绩预告", "业绩预增", "业绩预减", "业绩快报"] },
  { kind: "holder_increase", label: "重要股东增持", direction: "增持", words: ["增持"] },
  { kind: "holder_decrease", label: "重要股东减持", direction: "减持", words: ["减持", "集中竞价减持"] },
  { kind: "buyback", label: "回购方案", words: ["回购", "回购股份"] },
  { kind: "survey", label: "机构调研", words: ["投资者关系", "机构调研", "调研活动"] },
  { kind: "dragon_tiger", label: "龙虎榜上榜", words: ["龙虎榜", "异常波动"] },
  { kind: "lockup", label: "限售解禁", words: ["限售股", "解禁", "上市流通"] },
];

/** 一条公告 → 事件（识别不了返回 null）。 */
export function classifyArticle(title: string, date: string): StudyEvent | null {
  const day = date.slice(0, 10); // 容忍带时分秒的 time（统一截到日）
  for (const rule of RULES) {
    if (rule.words.some((w) => title.includes(w))) {
      return { date: day, label: rule.label, ...(rule.direction ? { direction: rule.direction } : {}) };
    }
  }
  return null;
}

/** 一批公告 → 事件列表（识别不了的丢掉，一条只归一类）。 */
export function classifyArticles(articles: readonly { time: string; title: string; kind?: string }[]): StudyEvent[] {
  const out: StudyEvent[] = [];
  for (const a of articles) {
    if (a.kind && a.kind !== "ann") continue; // 只认公告（kind 缺省时按公告算，兼容旧数据）
    const date = a.time.slice(0, 10);
    const ev = classifyArticle(a.title, date);
    if (ev) out.push(ev);
  }
  return out;
}

/** 全部事件类型（给页面做筛选器用）。 */
export const EVENT_KINDS: { kind: EventKind; label: string }[] = RULES.map((r) => ({ kind: r.kind, label: r.label }));
