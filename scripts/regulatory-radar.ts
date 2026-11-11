/**
 * 监管异动雷达——从 K 线算「异常波动」认定进度（对标连板网 /yidong.html）。
 *
 * 原理（纯计算，零新数据源）：
 *   3 日偏离值 = Σ_{近3日} (个股日涨幅 − 基准指数日涨幅)
 *   阈值：沪深主板 ±20%、创业板/科创板 ±30%（ST ±12%，回测无 ST 标记先不做）。
 *   分档：已达（偏离 ≥ 阈值）/ 临近（≥ 0.8×阈值）/ 正常。
 *
 * 基准指数：sh60→上证指数、sz00→深证成指、sz30→创业板指、sh68→科创50。
 * 个股日涨幅用 K 线缓存（已到当日），指数用腾讯非复权接口（指数无复权）。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/regulatory-radar.ts
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";

const UA = "Mozilla/5.0";
const OUT = "data/history/regulatory";

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };

/** 基准指数映射。 */
function benchmarkFor(code: string): string {
  if (code.startsWith("sh68")) return "sh000688"; // 科创50
  if (code.startsWith("sz30")) return "sz399006"; // 创业板指
  if (code.startsWith("sz00")) return "sz399001"; // 深证成指
  return "sh000001"; // 上证指数
}

function thresholdFor(code: string): number {
  return code.startsWith("sh68") || code.startsWith("sz30") ? 0.3 : 0.2;
}

async function fetchIndex(id: string): Promise<Row[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${id},day,,,40`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(12000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Record<string, { day?: string[][] }> };
    const rows = body.data?.[id]?.day ?? [];
    return rows
      .filter((r) => r.length >= 3)
      .map((r) => ({ date: r[0], o: Number(r[1]), c: Number(r[2]), h: Number(r[3]), l: Number(r[4]), v: Number(r[5]) }));
  } catch {
    return [];
  }
}

/** 近 N 日累计偏离值 = Σ (个股日涨幅 − 指数日涨幅)。 */
function deviation(stock: Row[], index: Row[], n = 3): number | null {
  if (stock.length < n + 1 || index.length < n + 1) return null;
  const idxByDate = new Map(index.map((r) => [r.date, r.c]));
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    const s0 = stock[stock.length - 1 - i];
    const s1 = stock[stock.length - 2 - i];
    const i0 = idxByDate.get(s0.date);
    const i1 = idxByDate.get(s1.date);
    if (!(s0.c > 0 && s1.c > 0 && i0 != null && i1 != null && i1 > 0)) return null;
    acc += s0.c / s1.c - 1 - (i0 / i1 - 1);
  }
  return acc;
}

async function main() {
  // 1. 读涨停池
  let snap: { date: string; limitUp: { id?: string; code?: string; name?: string; streak?: number | null; stat?: string | null }[] } | null = null;
  try {
    snap = JSON.parse(await readFile("data/signals/limit-pools-today.json", "utf8"));
  } catch {
    console.error("没有涨停池快照，先跑 capture-market-snapshot.ts");
    process.exit(1);
  }
  if (!snap) process.exit(1);
  const date = snap.date;

  // 2. 拉 4 个基准指数（近 40 日，够算 3 日 + 顺便看 10 日）
  const indexIds = ["sh000001", "sz399001", "sz399006", "sh000688"];
  const indices = new Map<string, Row[]>();
  for (const id of indexIds) {
    indices.set(id, await fetchIndex(id));
    await new Promise((r) => setTimeout(r, 150));
  }

  // 3. 逐只算偏离值
  const rows: { code: string; name: string; streak: string; dev: number; threshold: number; level: "已达" | "临近" | "正常" }[] = [];
  for (const s of snap.limitUp) {
    const id = s.id;
    if (!id) continue;
    let kl: Row[] = [];
    try {
      kl = JSON.parse(await readFile(`data/backtest/kline/${id}.json`, "utf8"));
    } catch {
      continue; // 无缓存跳过（不编）
    }
    if (!Array.isArray(kl) || kl.length < 4) continue;
    const idx = indices.get(benchmarkFor(id)) ?? [];
    const dev = deviation(kl, idx, 3);
    if (dev == null) continue;
    const thr = thresholdFor(id);
    const level = Math.abs(dev) >= thr ? "已达" : Math.abs(dev) >= thr * 0.8 ? "临近" : "正常";
    rows.push({
      code: id,
      name: s.name ?? "",
      streak: s.stat ?? (s.streak && s.streak >= 2 ? `${s.streak}连板` : "首板"),
      dev,
      threshold: thr * 100,
      level,
    });
  }

  // 4. 排序：已达在前，偏离值降序
  rows.sort((a, b) => (a.level === "已达" ? 0 : a.level === "临近" ? 1 : 2) - (b.level === "已达" ? 0 : b.level === "临近" ? 1 : 2) || Math.abs(b.dev) - Math.abs(a.dev));

  await mkdir(OUT, { recursive: true });
  const out = { date, computedAt: new Date().toISOString(), rows };
  await writeFile(`${OUT}/${date}.json`, JSON.stringify(out, null, 2));

  console.log(`监管异动雷达 ${date}（涨停 ${snap.limitUp.length} 只，算得 ${rows.length} 只）\n`);
  const levelNames = { 已达: "🟧 已达异动线", 临近: "🟡 临近异动线", 正常: "—" } as const;
  for (const r of rows.filter((x) => x.level !== "正常").slice(0, 30)) {
    console.log(`  ${levelNames[r.level]} ${r.name}(${r.code}) ${r.streak} · 3日偏离 ${(r.dev * 100).toFixed(1)}%/${r.threshold.toFixed(0)}%`);
  }
  const reached = rows.filter((r) => r.level === "已达").length;
  const near = rows.filter((r) => r.level === "临近").length;
  console.log(`\n已达 ${reached} 只 · 临近 ${near} 只 · 已落盘 ${OUT}/${date}.json`);
}

main().catch((e) => {
  console.error("监管异动雷达失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
