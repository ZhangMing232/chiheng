/**
 * 周对账（2026-11-10，design/quantmind-borrow-list.md P0-2）：判决 vs 实际。
 *
 * 回测判决是「这套打法期望为正/为负」，实盘/跟踪是「实际拿到多少」——两边会漂：
 * 窗口红利退了、市场状态变了、判决前提失效。这个脚本每周一 18:30 把两边并排
 * 推微信，漂出预登记阈值就报「判决失效预警」。
 *
 * 三块内容：
 * 1. 信号对账：tracking-history.jsonl 累计的实测涨跌 vs 判决参考（注明出处）。
 *    样本 < 30 笔不下结论（GENOME_MIN_TRADES 同一纪律），只报数。
 * 2. 粗 PSI（行情状态漂移，borrow-list 里说好的行情侧粗版）：全池等权日收益与
 *    涨停家数，近 20 日 vs 近 250 日。|z|≥3 或波动率比越界就报「分布突变」。
 * 3. 回测判决文件健康度：strategy-verdicts.json 超过 3 天没刷新就提醒。
 *
 * 预登记阈值（不许事后调）：
 * - 偏离预警：n ≥ 30 且 |实测均值 − 判决参考| > 2 个百分点（绝对差）。
 * - 均值漂移：|mean20 − mean250| / (std250/√20) ≥ 3。
 * - 波动切换：std20 / std250 ∉ [0.5, 2.0]。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/reconcile-weekly.ts
 */
import { readFile } from "node:fs/promises";
import { sendPushPlus } from "@/lib/market/push";

const DATA = process.env.CHIHENG_DATA_DIR ?? "data";
const KLINE = `${DATA}/backtest/kline`;
const MIN_LIVE_N = 30;
const DRIFT_PP = 2;

/** 判决参考：数字必须有出处（DECISIONS.md / 战报），不许凭印象写。 */
const REFERENCE: Record<string, { ref: number | null; text: string; source: string }> = {
  低估值: {
    ref: -0.12,
    text: "长历史超额 ≈ −0.12%/笔（≈零期望），判决＝打平、live 全靠窗口红利",
    source: "DECISIONS.md 2026-11-09 低估值持有期 A/B",
  },
  "热点·题材补涨": {
    ref: 0.06,
    text: "+0.06%/笔（噪声级），判决＝无优势、小仓试错",
    source: "report-220335 短线热点三路判决",
  },
};

type Batch = {
  signalDate: string;
  trackedDate: string;
  signals: { strategy: string; chgPct: number | null; chgNetPct?: number | null; name: string; code: string }[];
};

async function loadHistory(): Promise<Batch[]> {
  try {
    const raw = await readFile(`${DATA}/signals/tracking-history.jsonl`, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Batch)
      .sort((a, b) => a.signalDate.localeCompare(b.signalDate));
  } catch {
    return [];
  }
}

/** 粗 PSI：全池等权日收益与涨停家数，近 20 日 vs 近 250 日。只用 ≤T 收盘，无前视。 */
async function marketDrift(): Promise<{ lines: string[]; alert: boolean }> {
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(KLINE).filter((f) => f.endsWith(".json"));
  const retByDate = new Map<string, number[]>();
  const luByDate = new Map<string, number>();
  for (const f of files) {
    let rows: { date: string; c: number }[];
    try {
      rows = JSON.parse(await readFile(`${KLINE}/${f}`, "utf8"));
    } catch {
      continue;
    }
    if (!Array.isArray(rows) || rows.length < 22) continue;
    const id = f.replace(".json", "");
    const lim = id.startsWith("sh688") || id.startsWith("sz300") ? 20 : id.startsWith("bj") ? 30 : 10;
    const tail = rows.slice(-251);
    for (let i = 1; i < tail.length; i++) {
      const prev = tail[i - 1]!.c;
      const cur = tail[i]!.c;
      if (!(prev > 0)) continue;
      const r = cur / prev - 1;
      const d = tail[i]!.date;
      const arr = retByDate.get(d) ?? [];
      arr.push(r);
      retByDate.set(d, arr);
      if (r >= (lim - 0.15) / 100) luByDate.set(d, (luByDate.get(d) ?? 0) + 1);
    }
  }
  const dates = [...retByDate.keys()].sort();
  if (dates.length < 40) return { lines: ["行情数据不足，跳过状态漂移检查"], alert: false };
  const means = dates.map((d) => {
    const a = retByDate.get(d)!;
    return a.reduce((s, x) => s + x, 0) / a.length;
  });
  const lus = dates.map((d) => luByDate.get(d) ?? 0);
  const stat = (xs: number[], win: number) => {
    const part = xs.slice(-win);
    const mean = part.reduce((s, x) => s + x, 0) / part.length;
    const m250 = xs.reduce((s, x) => s + x, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((s, x) => s + (x - m250) ** 2, 0) / xs.length);
    return { mean, m250, sd };
  };
  const r = stat(means, 20);
  const l = stat(lus, 20);
  const sd20 = Math.sqrt(means.slice(-20).reduce((s, x) => s + (x - r.mean) ** 2, 0) / 20);
  const z = (a: number, b: number, sd: number) => (sd > 0 ? (a - b) / (sd / Math.sqrt(20)) : 0);
  const zRet = z(r.mean, r.m250, r.sd);
  const zLu = z(l.mean, l.m250, l.sd);
  const volRatio = r.sd > 0 ? sd20 / r.sd : 1;
  const lines = [
    `全池等权收益：近20日均 ${pct(r.mean)}/日 vs 250日均 ${pct(r.m250)}/日（z=${zRet.toFixed(1)}）`,
    `涨停家数：近20日均 ${l.mean.toFixed(0)} vs 250日均 ${l.m250.toFixed(0)}（z=${zLu.toFixed(1)}）`,
    `波动比（近20/250）：${volRatio.toFixed(2)}`,
  ];
  let alert = false;
  if (Math.abs(zRet) >= 3 || Math.abs(zLu) >= 3 || volRatio < 0.5 || volRatio > 2) {
    alert = true;
    lines.push("⚠️ 分布突变：市场状态和判决样本期不一致——判决参考先打折看");
  }
  return { lines, alert };
}

const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

async function main() {
  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const batches = await loadHistory();
  const lines: string[] = [];
  let driftAlert = false;

  // 1. 信号对账
  lines.push("【信号对账】实测（累计台账，费后口径） vs 判决参考");
  if (batches.length === 0) {
    lines.push("历史台账还空着（今天刚建）——track-signals 明天起每天追加，下周见数。");
  } else {
    const weekAgo = new Date(Date.now() + 8 * 3_600_000 - 7 * 86_400_000).toISOString().slice(0, 10); // 近段 = 最近 7 天
    const fams = new Map<string, { all: number[]; recent: number[] }>();
    for (const b of batches) {
      for (const s of b.signals) {
        // 对账一律用费后口径（chgNetPct，P1-3）；老台账没有该字段的退回毛收益并标出
        const net = s.chgNetPct ?? s.chgPct;
        if (net == null) continue;
        const f = fams.get(s.strategy) ?? { all: [], recent: [] };
        f.all.push(net);
        if (b.trackedDate >= weekAgo) f.recent.push(net);
        fams.set(s.strategy, f);
      }
    }
    for (const [name, f] of fams) {
      const avg = f.all.reduce((s, x) => s + x, 0) / f.all.length;
      const wins = f.all.filter((x) => x > 0).length;
      const rec = f.recent.length
        ? `｜近段 ${f.recent.length} 笔均 ${pct(f.recent.reduce((s, x) => s + x, 0) / f.recent.length)}`
        : "";
      const ref = REFERENCE[name];
      let verdict = "";
      if (ref?.ref != null && f.all.length >= MIN_LIVE_N && Math.abs(avg - ref.ref) > DRIFT_PP) {
        verdict = " ⚠️偏离预警：判决可能失效，建议重跑回测";
        driftAlert = true;
      } else if (f.all.length < MIN_LIVE_N) {
        verdict = `（${f.all.length} < ${MIN_LIVE_N} 笔，不下结论）`;
      }
      lines.push(`· ${name}：${f.all.length} 笔 | 胜率 ${((wins / f.all.length) * 100).toFixed(0)}% | 均 ${pct(avg)}${rec}`);
      if (ref) lines.push(`  判决：${ref.text}（${ref.source}）${verdict}`);
    }
  }

  // 2. 粗 PSI
  lines.push("", "【状态漂移】近20日 vs 近250日");
  const drift = await marketDrift();
  lines.push(...drift.lines);
  // 盘面温度计（borrow-list B2，真炸板率口径）——周报里给个情绪坐标
  try {
    const s = JSON.parse(await readFile(`${DATA}/signals/forms/summary.json`, "utf8")) as {
      thermometer?: { date: string; score: number; limitUps: number; blastRate: number | null; maxStreak: number; prevLuRet: number | null };
    };
    const t = s.thermometer;
    if (t) {
      lines.push(
        `盘面温度计（${t.date}）：${t.score}/100｜涨停 ${t.limitUps} · 炸板率 ${t.blastRate ?? "—"}% · 连板高度 ${t.maxStreak} · 昨涨停今 ${t.prevLuRet ?? "—"}%`,
      );
    }
  } catch {
    /* 台账没生成就不加这一行 */
  }

  // 3. 判决文件健康度
  try {
    const v = JSON.parse(await readFile(`${DATA}/strategy-verdicts.json`, "utf8")) as { at?: string };
    const ageDays = v.at ? (Date.now() - new Date(v.at).getTime()) / 86_400_000 : 999;
    lines.push("", `【判决文件】strategy-verdicts.json ${ageDays.toFixed(1)} 天前刷新${ageDays > 3 ? " ⚠️ 超过 3 天，15:15 的判决任务没跑成" : ""}`);
    if (ageDays > 3) driftAlert = true;
  } catch {
    lines.push("", "【判决文件】strategy-verdicts.json 缺失 ⚠️");
    driftAlert = true;
  }

  const title = `周对账 · ${today}${driftAlert ? " · ⚠️ 有预警" : ""}`;
  const sent = await sendPushPlus(title, lines.join("\n"), "txt");
  console.log(lines.join("\n"));
  console.log(sent ? "\n周对账已推送微信" : "\n推送未发出");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
