/**
 * 短线形态台账：扫 K 线缓存，给涨停池打形态标签，并如实记录每种形态事后怎么走。
 *
 * 用户 2026-11-10 拍板「按建议来」的第一步：不买数据、不上新策略，先把日线
 * OHLC 里已经能认出来的六类形态攒成可查的证据。
 *
 * 产出两份（都不给买卖建议）：
 *   data/signals/forms/summary.json  各形态累计样本 / 能买到比例 / 次日与持 2 日表现
 *   data/signals/forms/latest.json   最近有数据那天的形态名单（当眼睛用）
 *
 * ⚠️ 数据覆盖度是显式写进产出的：K 线缓存各只票最后日期不齐时，latest.json
 * 会列出 atDate / stale 数量，不拿滞后数据冒充「今天全池」。
 *
 * 口径（一字不改地沿用 src/lib/market/short-forms.ts，别在这里另写一份）：
 *   T 日形态 → T+1 挂 T 日收盘限价；开盘高于挂单价 = 买不到，不计入收益。
 *   这是事后描述统计，不是可成交价、不是策略收益、没扣费、没减基准、没六切片、没聚类 t。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/scan-short-forms.ts
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { classifyForms, settleForm, SHORT_FORMS, type ShortForm, type DayBar } from "@/lib/market/short-forms";

const DATA = process.env.CHIHENG_DATA_DIR ?? "data";
const KLINE = `${DATA}/backtest/kline`;
const TDX = `${DATA}/backtest/tdx-daily`;
const OUT = `${DATA}/signals/forms`;
const WINDOW = 750;

type Row = DayBar & { v?: number };

type Acc = { samples: number; fillable: number; r1: number[]; r2: number[] };
type Stat = {
  samples: number;
  fillable: number;
  fillRate: number | null;
  avgR1: number | null;
  avgR2: number | null;
  winR1: number | null;
};

const mean = (xs: number[]): number | null => (xs.length ? +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(2) : null);
const pct = (n: number, d: number): number | null => (d ? +((n / d) * 100).toFixed(1) : null);

type TdxRow = { id: string; prevClose: number; open: number; high: number; low: number; close: number };
type TdxBar = { id: string; o: number; h: number; l: number; c: number; prevClose: number };

/**
 * 读最新的通达信盘后包（一个请求拿全市场 OHLC 截面）。
 * 只用来生成「当日形态名单」，**不混进历史统计**：kline 缓存是腾讯前复权，
 * 盘后包是不复权，接在一起遇除权日会跳空，涨停判定和事后收益全错。
 * 包里自带 prevClose，用它判涨跌停最准，也不依赖前一根 K 线。
 */
async function loadTdxLatest(): Promise<{ date: string; bars: TdxBar[] } | null> {
  let files: string[];
  try {
    files = (await readdir(TDX)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  } catch {
    return null;
  }
  const last = files[files.length - 1];
  if (!last) return null;
  try {
    const parsed = JSON.parse(await readFile(`${TDX}/${last}`, "utf8")) as { date?: string; rows?: TdxRow[] };
    const date = parsed.date ?? last.slice(0, -5);
    if (!Array.isArray(parsed.rows)) return null;
    const bars = parsed.rows
      .filter(
        (r) =>
          r && typeof r.id === "string" && r.prevClose > 0 &&
          [r.open, r.high, r.low, r.close].every((x) => Number.isFinite(x) && x > 0),
      )
      .map((r) => ({ id: r.id, o: r.open, h: r.high, l: r.low, c: r.close, prevClose: r.prevClose }));
    return { date, bars };
  } catch {
    return null;
  }
}

async function main() {
  const files = (await readdir(KLINE)).filter((f) => f.endsWith(".json"));
  const acc = new Map<ShortForm, Acc>(SHORT_FORMS.map((f) => [f, { samples: 0, fillable: 0, r1: [], r2: [] }]));
  const lastDateCount = new Map<string, number>();
  const lastDates: { id: string; date: string; rows: Row[] }[] = [];

  for (const file of files) {
    const id = file.slice(0, -5);
    let rows: Row[];
    try {
      const raw = JSON.parse(await readFile(`${KLINE}/${file}`, "utf8"));
      if (!Array.isArray(raw)) continue;
      rows = raw.slice(-WINDOW);
    } catch {
      continue; // 读不到就跳过并让覆盖度如实反映，不补 0
    }
    if (rows.length < 10) continue;
    const last = rows[rows.length - 1].date;
    lastDateCount.set(last, (lastDateCount.get(last) ?? 0) + 1);
    lastDates.push({ id, date: last, rows });
  }

  // 「最近有数据那天」= 出现次数最多的最后日期。缓存不齐时它可能是几天前，照实写。
  const targetDate = [...lastDateCount.entries()].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]))[0]?.[0] ?? null;
  const latest = new Map<ShortForm, { id: string; code: string; close: number; forms: ShortForm[] }[]>(
    SHORT_FORMS.map((f) => [f, []]),
  );

  // 当日名单优先用通达信盘后包（全市场 OHLC，覆盖比 kline 缓存齐）。
  // 包比缓存还旧就退回缓存，并把「为什么退回」写进产出，不拿旧包冒充今天。
  const tdx = await loadTdxLatest();
  const useTdx = tdx != null && tdx.date >= (targetDate ?? "");
  const latestDate = useTdx ? tdx!.date : targetDate;
  const latestSource = useTdx
    ? `通达信盘后包 ${tdx!.date}（全市场 OHLC 截面，用包内 prevClose 判涨跌停）`
    : `K 线缓存 ${targetDate}（盘后包缺失或更旧，已退回；名单只覆盖当天有 K 线的票）`;
  if (useTdx) {
    for (const b of tdx!.bars) {
      const forms = classifyForms({ date: tdx!.date, o: b.o, h: b.h, l: b.l, c: b.c }, b.prevClose, b.id);
      for (const f of forms) latest.get(f)!.push({ id: b.id, code: b.id.slice(2), close: b.c, forms });
    }
  } else {
    // 缓存最后一根就是「今天」，后面没有 K 线，所以只打标签、不给收益。
    // 不能塞进下面要 T+1/T+2 的循环——那个循环会跳过最后两根，名单会全空。
    for (const { id, rows } of lastDates) {
      if (rows.length < 2) continue;
      const lastRow = rows[rows.length - 1];
      if (lastRow.date !== targetDate) continue;
      const forms = classifyForms(lastRow, rows[rows.length - 2].c, id);
      for (const f of forms) latest.get(f)!.push({ id, code: id.slice(2), close: lastRow.c, forms });
    }
  }

  let scannedBars = 0;
  for (const { id, rows } of lastDates) {
    for (let i = 1; i < rows.length - 2; i += 1) {
      const row = rows[i];
      const prevClose = rows[i - 1].c;
      const forms = classifyForms(row, prevClose, id);
      if (forms.length === 0) continue;
      scannedBars += 1;
      const outcome = settleForm(row.c, [{ o: rows[i + 1].o, c: rows[i + 1].c }, { o: rows[i + 2].o, c: rows[i + 2].c }]);
      for (const f of forms) {
        const a = acc.get(f)!;
        a.samples += 1;
        if (outcome.fillable) {
          a.fillable += 1;
          if (outcome.r1 != null && Math.abs(outcome.r1) < 50) a.r1.push(outcome.r1);
          if (outcome.r2 != null && Math.abs(outcome.r2) < 50) a.r2.push(outcome.r2);
        }
      }
    }
  }

  const forms: Record<string, Stat> = {};
  for (const f of SHORT_FORMS) {
    const a = acc.get(f)!;
    forms[f] = {
      samples: a.samples,
      fillable: a.fillable,
      fillRate: pct(a.fillable, a.samples),
      avgR1: mean(a.r1),
      avgR2: mean(a.r2),
      winR1: pct(a.r1.filter((x) => x > 0).length, a.r1.length),
    };
  }

  const coverage = {
    klineFiles: files.length,
    usableFiles: lastDates.length,
    targetDate,
    atDate: targetDate ? (lastDateCount.get(targetDate) ?? 0) : 0,
    stale: targetDate ? lastDates.filter((d) => d.date !== targetDate).length : lastDates.length,
    lastDateBreakdown: Object.fromEntries([...lastDateCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)),
    tdxLatestDate: tdx?.date ?? null,
    tdxRows: tdx?.bars.length ?? 0,
    latestDate,
    latestSource,
  };

  const caveats = [
    "事后描述统计，不是可成交价、不是策略收益：T 日收盘价在涨停日往往买不到。",
    "未扣手续费/滑点、未减同期基准、未跑六切片、未算聚类 t，不能当判决数字引用。",
    "涨停按板块幅度近似（主板10/创业科创20/北交30），K 线缓存无 ST 标记，ST 的 5% 判不了。",
    "T+1 挂 T 日收盘限价，次日开盘高于挂单价视为买不到、不计入收益；拿不到后续 K 线记 null 不记 0。",
    "一张 K 线可命中多个形态（低开拉板既是换手板也是弱转强），各标签分别计入。",
    "历史统计只走 kline 缓存（腾讯前复权）；当日名单优先走通达信盘后包（不复权）。两者不混接，避免除权跳空。用包内 prevClose 判涨跌停。",
    "latest.json 的名义日期是 latestDate；若盘后包缺失或更旧会退回 kline 的 targetDate，latestSource 写明原因，别当成全池当日快照。",
  ];

  await mkdir(OUT, { recursive: true });
  const generatedFor = new Date().toLocaleDateString("sv-SE");
  await writeFile(
    `${OUT}/summary.json`,
    JSON.stringify({ generatedFor, generatedAt: new Date().toISOString(), windowDays: WINDOW, coverage, caveats, forms }, null, 2),
  );
  type LatestRow = { id: string; code: string; close: number; forms: ShortForm[] };
  const latestForms: Record<string, LatestRow[]> = {};
  for (const f of SHORT_FORMS) latestForms[f] = latest.get(f)!.slice(0, 100);
  await writeFile(
    `${OUT}/latest.json`,
    JSON.stringify({
      generatedFor,
      date: latestDate,
      source: latestSource,
      coverage,
      note: "名单只作观察，不给买卖建议；收益待后续 K 线补齐后由 summary 反映。",
      forms: latestForms,
    }, null, 2),
  );

  console.log(`形态台账：扫描 ${coverage.usableFiles} 只票 / ${scannedBars} 个形态日，targetDate=${targetDate}（覆盖 ${coverage.atDate} 只，滞后 ${coverage.stale} 只）`);
  console.log(`当日名单：${latestDate} ← ${latestSource}`);
  for (const f of SHORT_FORMS) {
    const s = forms[f];
    console.log(`  ${f.padEnd(5)} 样本 ${String(s.samples).padStart(6)} | 能买到 ${String(s.fillRate ?? "—").padStart(5)}% | 次日 ${s.avgR1 ?? "—"} | 持2日 ${s.avgR2 ?? "—"}`);
  }
  console.log(`\n已写 ${OUT}/summary.json 与 latest.json`);
  if (coverage.stale > coverage.usableFiles * 0.1) {
    console.log(`⚠️ ${coverage.stale} 只票的 K 线没到 ${targetDate}，当日名单不是全池——覆盖度已写进产出，不冒充。`);
  }
}

await main();
