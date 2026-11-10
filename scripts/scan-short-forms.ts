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

// ── 盘面温度计（2026-11-10，borrow-list B2）────────────────────────────
// 打板圈情绪指标，全部用真数——QuantMind 同名指标的炸板率是拿下跌家数拟合的假数
// （quantdb_feed.py:733），我们从 K 线逐只认触板/封板。只当状态参考不当信号：
// 追情绪已被判决死（连板阶梯 t=−10.2）。
// 口径（预登记，不许事后调）：
//   涨停＝收盘 ≥ 昨收×(1+板幅−0.15%)；炸板＝盘中触板（最高 ≥ 涨停价×0.998）没封住；
//   炸板率＝炸板/(炸板+涨停)；连板高度＝当日涨停票的最大连续涨停天数；
//   昨涨停今表现＝昨日涨停票今日涨幅均值。
//   温度＝clamp(50 + 12·z涨停率 + 12·z昨涨停今表现 + 8·z连板高度 − 12·z炸板率, 0, 100)，
//   z 取近 250 交易日序列的均值/标准差；涨停用率不用数（半刷新缓存覆盖不齐时，
//   数的 z 基线来自全史日、拿小样本比全史=系统性偏冷，率是同一构念的无偏版）。
//   覆盖度随 summary 如实写，不冒充全池。
type Thermometer = {
  date: string;
  score: number;
  limitUps: number;
  blastRate: number | null;
  maxStreak: number;
  prevLuRet: number | null;
  coverage: number;
};

function buildThermometer(lastDates: { id: string; rows: Row[] }[], targetDate: string | null): Thermometer | null {
  if (!targetDate) return null;
  const luByDate = new Map<string, number>();
  const blastByDate = new Map<string, number>();
  const streakByDate = new Map<string, number>();
  const retByDate = new Map<string, number[]>();
  const barsByDate = new Map<string, number>();
  // 按日期全量统计，不看票的末根停在哪——缓存半新半旧时「末根==目标日」的闸会把
  // 已刷新的票整个排除（2026-11-10 实测：1566 vs 真实 2504，涨停 5 vs 17，就是这个闸）。
  for (const { id, rows } of lastDates) {
    const lim = id.startsWith("sh688") || id.startsWith("sz30") ? 20 : id.startsWith("bj") ? 30 : 10;
    const touch = (1 + lim / 100) * 0.998;
    let streak = 0;
    let prevLu = false;
    for (let i = Math.max(1, rows.length - 251); i < rows.length; i++) {
      const prev = rows[i - 1]!.c;
      const cur = rows[i]!;
      if (!(prev > 0)) continue;
      const lu = cur.c >= prev * touch;
      const d = cur.date;
      barsByDate.set(d, (barsByDate.get(d) ?? 0) + 1);
      if (lu) {
        streak += 1;
        luByDate.set(d, (luByDate.get(d) ?? 0) + 1);
        streakByDate.set(d, Math.max(streakByDate.get(d) ?? 0, streak));
      } else {
        streak = 0;
        if (cur.h >= prev * touch) blastByDate.set(d, (blastByDate.get(d) ?? 0) + 1);
      }
      if (prevLu) {
        const arr = retByDate.get(d) ?? [];
        arr.push((cur.c / prev - 1) * 100);
        retByDate.set(d, arr);
      }
      prevLu = lu;
    }
  }
  const dates = [...barsByDate.keys()].sort();
  if (dates.length < 40) return null;
  // 报哪一天：最新的、且覆盖 ≥30% 股票的那天——半刷新缓存里「最新」可能只有几只票，
  // 那不是全池截面；宁可报前一天并把覆盖写清楚。
  const minCov = lastDates.length * 0.3;
  let report = targetDate;
  for (let i = dates.length - 1; i >= 0; i--) {
    if ((barsByDate.get(dates[i]!) ?? 0) >= minCov) {
      report = dates[i]!;
      break;
    }
  }
  // 涨停用**率**不用数：半刷新缓存里当天覆盖只有几百只，数量的 z 基线来自全史日
  // （2691 只），拿 1079 只的数去比全史的数=系统性偏冷。率是同一构念的无偏版。
  const luS = dates.map((d) => ((luByDate.get(d) ?? 0) / (barsByDate.get(d) || 1)) * 100);
  const blastS = dates.map((d) => {
    const b = blastByDate.get(d) ?? 0;
    const l = luByDate.get(d) ?? 0;
    return b + l > 0 ? (b / (b + l)) * 100 : null;
  });
  const streakS = dates.map((d) => streakByDate.get(d) ?? 0);
  const retS = dates.map((d) => {
    const a = retByDate.get(d);
    return a?.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  });
  const z = (series: (number | null)[], x: number | null): number => {
    const xs = series.filter((v): v is number => v != null);
    if (x == null || xs.length < 20) return 0;
    const m = xs.reduce((s, v) => s + v, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length);
    return sd > 0 ? (x - m) / sd : 0;
  };
  const at = dates.indexOf(report);
  const limitUps = luByDate.get(report) ?? 0;
  const luRate = luS[at] ?? 0;
  const blastRate = blastS[at];
  const maxStreak = streakS[at] ?? 0;
  const prevLuRet = retS[at];
  const score = Math.max(
    0,
    Math.min(
      100,
      50 + 12 * z(luS, luRate) + 12 * z(retS, prevLuRet) + 8 * z(streakS, maxStreak) - 12 * z(blastS, blastRate),
    ),
  );
  return {
    date: report,
    score: +score.toFixed(1),
    limitUps,
    blastRate: blastRate == null ? null : +blastRate.toFixed(1),
    maxStreak,
    prevLuRet: prevLuRet == null ? null : +prevLuRet.toFixed(2),
    coverage: barsByDate.get(report) ?? 0,
  };
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
      // 找目标日那根 bar——「末根==目标日」的旧闸在半刷新缓存里会漏掉已刷新的票
      // （2026-11-10 实测：1566/2504 只、涨停 5 vs 真实 17，温度计同一个坑）。
      let ri = rows.length - 1;
      while (ri >= 1 && rows[ri].date > targetDate) ri -= 1;
      if (rows[ri].date !== targetDate) continue;
      const forms = classifyForms(rows[ri], rows[ri - 1].c, id);
      for (const f of forms) latest.get(f)!.push({ id, code: id.slice(2), close: rows[ri].c, forms });
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

  const thermometer = buildThermometer(lastDates, targetDate);

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
    JSON.stringify({ generatedFor, generatedAt: new Date().toISOString(), windowDays: WINDOW, coverage, caveats, forms, thermometer }, null, 2),
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

  // 盘面温度计推微信（borrow-list B2）：每天 15:35 一条状态参考，不是买入信号。
  if (thermometer) {
    const t = thermometer;
    const formsToday = SHORT_FORMS.map((f) => `${f} ${latest.get(f)!.length}`).join(" · ");
    try {
      const { sendPushPlus } = await import("@/lib/market/push");
      const sent = await sendPushPlus(
        `盘面温度计 ${t.score.toFixed(0)}/100 · ${t.date}`,
        [
          `涨停 ${t.limitUps} 只 · 炸板率 ${t.blastRate == null ? "—" : t.blastRate + "%"} · 连板高度 ${t.maxStreak} · 昨涨停今表现 ${t.prevLuRet == null ? "—" : (t.prevLuRet >= 0 ? "+" : "") + t.prevLuRet + "%"}`,
          `覆盖 ${t.coverage} 只（K 线到 ${t.date} 的；滞后票不含）`,
          "──────────────────",
          `今日形态：${formsToday}`,
          "──────────────────",
          "温度是状态参考不是信号——追情绪/追板已被判决死（板越高次日越亏）。",
        ].join("\n"),
        "txt",
      );
      console.log(sent ? "盘面温度计已推送微信" : "温度计推送未发出");
    } catch (e) {
      console.log(`温度计推送失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else {
    console.log("温度计没算出来（数据天数不足 40），今天不推。");
  }
}

await main();
