/**
 * 题材热度榜（2026-11-09 补上「系统对题材一无所知」的真空，用户点名）：
 * 东财概念板块 × 当日行情 → 每个题材的涨停家数、平均涨幅、龙头——
 * 「今天什么题材在烧」一张榜说清。每天 15:10 由 launchd 推微信。
 *
 * 口径（预登记）：热度 = 涨停家数优先、均涨幅次之；龙头 = 板内涨幅最高的非涨停股
 * （涨停的是花，龙头看谁在领跑梯队）。只报事实不报推荐——热榜是视野不是信号：
 * 连板阶梯已判死（板越高追入越亏，t=-10.2），看热榜是为了知道市场在干什么。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/theme-heat.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { sendPushPlus } from "@/lib/market/push";

type Quote = { id: string; code?: string; name?: string; price: number; chg: number | null; st?: boolean };
type Concepts = { boards: { code: string; name: string; members: string[] }[] };

const concepts: Concepts = JSON.parse(readFileSync("data/backtest/concepts.json", "utf8"));
const quotes: Quote[] = JSON.parse(readFileSync("data/universe-cache.json", "utf8")).payload.quotes;
const byId = new Map(quotes.map((q) => [q.id, q]));

const rows = concepts.boards.map((b) => {
  let up = 0, down = 0, limitUp = 0, chgSum = 0, n = 0;
  let leader: { name: string; chg: number } | null = null;
  for (const id of b.members) {
    const q = byId.get(id);
    if (!q || q.st || q.chg == null) continue;
    n += 1;
    chgSum += q.chg;
    if (q.chg > 0.001) up += 1;
    else if (q.chg < -0.001) down += 1;
    if (q.chg >= 9.7) limitUp += 1;
    else if (!leader || q.chg > leader.chg) leader = { name: q.name ?? id, chg: q.chg };
  }
  return { name: b.name, n, limitUp, avg: n ? chgSum / n : 0, up, down, leader };
});
// 口径修正（2026-11-09 首跑发现）：融资融券/深股通这类「标签板」（几千成员）
// 霸榜无信息量——只留真题材板（成分 10~300 只），热度 = 涨停家数优先、均涨幅次之。
// 标签板拉黑：东财概念里混着「昨日涨停/高换手/重仓/股通」这类统计标签，
  // 不是题材故事；按名字模式剔掉。大题材（机器人等 500+ 成员）放宽到 800。
  const TAG_BOARD = /(热股|高换手|高振幅|多板|涨停|跌停|首亏|预增|预亏|重仓|减仓|增仓|融资|股通|QFII|亏损|题材股|破净|高价|低价|百元|次新|AH|同股)/;
  const themed = rows.filter((r) => r.n >= 10 && r.n <= 800 && !TAG_BOARD.test(r.name));
themed.sort((a, b) => b.limitUp - a.limitUp || b.avg - a.avg);
const hot = themed.filter((r) => r.limitUp > 0).slice(0, 12);

// 玄学/名字梯队（2026-11-09 用户点名「东方概念」）：东方系今天 8 只集体涨停，
// 但东财概念板里没有「东方」——命名玄学炒作天生躲开概念榜。这里按名字
// 聚类（名首/名中两字为键），任何一族 ≥3 只涨停就上榜：题材之外的市场语言。
const surname = new Map<string, { total: number; limitUp: number; names: string[] }>();
for (const q of quotes) {
  const nm = q.name ?? "";
  if (nm.length < 4 || q.chg == null || q.st) continue;
  for (const key of [nm.slice(0, 2), nm.slice(-2)]) {
    const g = surname.get(key) ?? { total: 0, limitUp: 0, names: [] };
    g.total += 1;
    if (q.chg >= 9.7) {
      g.limitUp += 1;
      if (g.names.length < 6) g.names.push(nm);
    }
    surname.set(key, g);
  }
}
const families = [...surname.entries()]
  .filter(([k, g]) => g.total >= 5 && g.limitUp >= 3 && k.length === 2)
  .sort((a, b) => b[1].limitUp - a[1].limitUp)
  .slice(0, 6);

const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
writeFileSync("data/theme-heat.json", JSON.stringify({ date: today, hot, total: rows.length }, null, 2));

const lines = hot.map((r) => {
  const li = r.leader ? `｜龙头 ${r.leader.name} ${r.leader.chg > 0 ? "+" : ""}${r.leader.chg.toFixed(1)}%` : "";
  return `🔥 ${r.name}｜涨停 ${r.limitUp} 只｜均 ${r.avg >= 0 ? "+" : ""}${r.avg.toFixed(1)}%｜涨 ${r.up} 跌 ${r.down}${li}`;
});
const sent = await sendPushPlus(`题材热度榜 ${today}`, [
  `概念 ${rows.length} 个（题材板 ${themed.length}，标签板已滤），今日有涨停的题材 ${themed.filter((r) => r.limitUp > 0).length} 个`,
  "──────────────────",
  ...(lines.length ? lines : ["今日无题材涨停。"]),
  "──────────────────",
  ...(families.length
    ? ["名字梯队（玄学炒作，概念榜看不见的市场语言）：", ...families.map(([k, g]) => `🪄 ${k}系｜涨停 ${g.limitUp} 只/${g.total}｜${g.names.join("、")}`)]
    : ["今日无名字梯队异动。"]),
  "──────────────────",
  "看热榜是知道市场在干什么，不是买入信号——连板追入已被判死（板越高次日越亏）。",
].join("\n"), "txt");
console.log(sent ? "热榜已推送微信" : "推送未发出");
for (const r of hot) console.log(`  ${r.name} 涨停${r.limitUp} 均${r.avg.toFixed(1)}% ${r.leader ? "龙头 " + r.leader.name : ""}`);
