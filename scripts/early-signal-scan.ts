/**
 * 这个文件是干什么的：
 * 「启动前兆扫描」——找那些**还没大涨、但有启动迹象**的票（2026-11-18 用户要求）。
 *
 * 为什么要有它（用户原话）：「盛合晶微、摩尔线程、九阳股份都在涨，你为什么不提前知道」。
 * 现有五个策略只会「跌深买反弹」或「低估值买」，没有一条找「即将启动」的。
 * 本脚本补这个探针：组合资金流 + 题材热度 + 涨幅位置，输出**观察名单**。
 *
 * 三条硬边界（写死，不许松）：
 * 1. **未经回测验证**——输出必须标 `verified: false`，页面/推送都要显示。
 *    不冒充「推荐」，只叫「观察名单」。经判决流程转正前不进账本、不建仓。
 * 2. **不碰冻结的两个解冻变体**（D-RESUME 判决期纪律），本脚本只产数据。
 * 3. **缺数据给 null 原因，不补 0**（本仓铁律）——某个信号读不到就写 why，
 *    不假装它是 0 参与打分。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/early-signal-scan.ts
 * 输出：data/early-signals.json
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** 一条观察记录。所有信号字段允许 null（读不到就是读不到）。 */
type WatchRow = {
  code: string;
  name: string;
  price: number;
  chg: number;
  /** 60 日涨幅：用来判断「还没大涨」 */
  d60: number | null;
  /** 20 日涨幅 */
  d20: number | null;
  /** 主力净流入（万元） */
  inflow: number | null;
  /** 量比：今天比平时活跃多少 */
  volRatio: number | null;
  /** 换手率 */
  turnover: number | null;
  /** 所属题材里最热的那几个（题材名 + 该题材涨停数） */
  hotThemes: { name: string; limitUp: number }[];
  /** 命中了几条前兆条件 */
  hits: string[];
  /** 为什么进榜——一句话，可追溯 */
  why: string;
  // 明确不是投资建议
  verified: false;
};

async function main() {
  // ── 输入 1：全市场行情 ──
  const { loadUniverse } = await import("../src/lib/market/quotes.functions.ts");
  const uni = await loadUniverse();
  if (!uni?.quotes?.length) {
    console.error("[early-signal] 行情读不到，本轮不产名单（不拿空冒充）");
    process.exit(0);
  }

  // ── 输入 2：题材热度 ──
  let themeHeat: { name: string; limitUp: number }[] = [];
  try {
    const raw = JSON.parse(await readFile(join(process.cwd(), "data", "theme-heat.json"), "utf8")) as {
      hot?: { name: string; limitUp: number }[];
    };
    themeHeat = raw.hot ?? [];
  } catch {
    console.warn("[early-signal] theme-heat 读不到——题材维度本轮缺失（不补 0）");
  }
  const heatByName = new Map(themeHeat.map((t) => [t.name, t.limitUp]));

  // ── 输入 3：题材成员映射 ──
  let bySymbol: Record<string, { name: string }[]> = {};
  try {
    const raw = JSON.parse(await readFile(join(process.cwd(), "data", "backtest", "concepts.json"), "utf8")) as {
      bySymbol?: Record<string, { name: string }[]>;
    };
    bySymbol = raw.bySymbol ?? {};
  } catch {
    console.warn("[early-signal] concepts.json 读不到——题材归属本轮缺失");
  }

  const rows: WatchRow[] = [];
  for (const q of uni.quotes) {
    if (q.st) continue; // ST 不碰
    if (!(q.price >= 4)) continue; // 低价股风险高
    if (q.amount < 8000) continue; // 成交额 8000 万以下太冷
    // 已经涨停/接近涨停的不算「前兆」——那是已经启动了
    if (q.chg != null && q.chg >= 9.5) continue;

    const hits: string[] = [];

    // ① 资金流入：主力净买为正且够大（万元）
    const inflowOk = q.inflow != null && q.inflow > 2000;
    if (inflowOk) hits.push(`主力净流入 ${(q.inflow! / 10000).toFixed(2)}亿`);

    // ② 放量：量比 1.5 以上，说明有人在动
    const volOk = q.volRatio != null && q.volRatio >= 1.5;
    if (volOk) hits.push(`量比 ${q.volRatio!.toFixed(2)}`);

    // ③ 位置低：60 日涨幅 < 30%（还没大涨），20 日 < 15%（近期没冲过）
    const posOk = q.d60 != null && q.d60 < 30 && (q.d20 == null || q.d20 < 15);
    if (posOk) hits.push(`60日仅 ${q.d60!.toFixed(1)}%`);

    // ④ 题材升温：所属题材里有涨停家数 ≥ 5 的
    const themes = bySymbol[q.id] ?? [];
    const hotThemes = themes
      .map((t) => ({ name: t.name, limitUp: heatByName.get(t.name) ?? 0 }))
      .filter((t) => t.limitUp >= 5)
      .sort((a, b) => b.limitUp - a.limitUp)
      .slice(0, 2);
    if (hotThemes.length > 0) hits.push(`题材升温：${hotThemes.map((t) => `${t.name}(${t.limitUp}涨停)`).join("、")}`);

    // 至少要命中 3 条才算前兆（2 条太宽，会把一大堆筛进来）
    if (hits.length < 3) continue;

    rows.push({
      code: q.id,
      name: q.name,
      price: q.price,
      chg: q.chg ?? 0,
      d60: q.d60 ?? null,
      d20: q.d20 ?? null,
      inflow: q.inflow ?? null,
      volRatio: q.volRatio ?? null,
      turnover: q.turnover ?? null,
      hotThemes,
      hits,
      why: hits.join(" · "),
      verified: false,
    });
  }

  // 排序：命中信号多的在前，同分按资金流入大的在前
  rows.sort((a, b) => b.hits.length - a.hits.length || (b.inflow ?? 0) - (a.inflow ?? 0));

  const out = {
    at: new Date().toISOString(),
    date: new Date().toLocaleDateString("sv-SE"),
    /** 本轮扫描范围（可追溯） */
    scanned: uni.quotes.length,
    /** 命中前兆条件的只数 */
    matched: rows.length,
    /** 明确标注：未经回测验证 */
    verified: false,
    disclaimer:
      "观察名单，**未经回测验证**：这是「资金+量能+位置+题材」四条前兆的组合筛选，不是投资建议，也没被判决流程承认。" +
      "用途是提前发现值得盯的票，准不准要跑一段时间才知道。不建仓、不进账本。",
    rows: rows.slice(0, 20),
  };
  await writeFile(join(process.cwd(), "data", "early-signals.json"), JSON.stringify(out, null, 2));
  console.log(
    `[early-signal] 扫描 ${out.scanned} 只 → 命中 ${out.matched} 只（前 20 已落盘，未验证）`,
  );
  for (const r of out.rows.slice(0, 5)) console.log(`  ${r.name} ${r.code} @${r.price} | ${r.why}`);
}

await main();
