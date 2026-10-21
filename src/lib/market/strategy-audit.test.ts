/**
 * 这个文件是干什么的：
 * 钉住策略审计（strategy-audit.ts）的各条规则：相关系数对齐口径、共线阈值、
 * 覆盖率缺口、小样本 t 值、连亏/回撤阈值、撮合口径核验。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  auditRun,
  collinearityFindings,
  coverageFinding,
  drawdownFindings,
  lookaheadFinding,
  sampleSizeFindings,
  seriesCorrelation,
} from "@/lib/market/strategy-audit";
import type { BacktestEnv, BacktestStyleStat } from "@/lib/market/backtest-runs";

const ENV: BacktestEnv = {
  start: "2025-09-18",
  end: "2026-09-30",
  days: 250,
  sample: 60,
  covered: 60,
  fillMode: "b",
  fee: 0.00302,
  turnoverGate: true,
  stopPct: null,
  bench300: -0.08,
};

function style(
  patch: Partial<Omit<BacktestStyleStat, "daily">> & { key: string; daily?: { date: string; ret: number }[] },
): BacktestStyleStat {
  return {
    label: patch.key,
    trades: 300,
    winRate: 0.3,
    avgRet: 0.001,
    benchAvg: 0,
    alpha: 0.001,
    tStat: 2.5,
    beatRate: 0.4,
    avgHold: 3,
    worstStreak: 5,
    drawdown: 0.2,
    ...patch,
    // 测试序列只给 date/ret（审计只需要这两列），结构比落盘记录窄，属可控收窄。
  } as BacktestStyleStat;
}

/** 造 n 天的日度序列（日期连续不重复），ret 由 fn(i) 给。 */
function daily(n: number, fn: (i: number) => number): { date: string; ret: number }[] {
  const base = Date.UTC(2026, 0, 1);
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(base + i * 86400_000);
    const date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
    return { date, ret: fn(i) };
  });
}

test("相关系数：同向 = 1，反向 = -1，常数序列 = null，共同天不足 20 = null", () => {
  const up = daily(30, (i) => 0.01 + i * 0.0001);
  assert.ok(Math.abs((seriesCorrelation(up, up) ?? 0) - 1) < 1e-12);
  const down = daily(30, (i) => 0.01 - i * 0.0001);
  assert.ok(Math.abs((seriesCorrelation(up, down) ?? 0) + 1) < 1e-12);
  assert.equal(seriesCorrelation(daily(30, () => 0.005), up), null);
  assert.equal(seriesCorrelation(daily(10, (i) => i * 0.001), up), null);
});

test("共线性：r ≥ 0.8 出 warn 且点名两套策略；0.6-0.8 出 info；都低出 ok", () => {
  const noise = (i: number) => Math.sin(i) * 0.001;
  // 同向分量 + 独立噪声，幅度调成 r ≈ 0.7（落在 0.6-0.95 的 info 档）。
  const common = (i: number) => Math.sin(i) * 0.01;
  const a = daily(40, (i) => common(i) + noise(i));
  const twin = daily(40, (i) => 0.02 + common(i) + noise(i)); // 常数差不影响相关
  const warn = collinearityFindings([style({ key: "a", daily: a }), style({ key: "b", daily: twin })]);
  const warnHit = warn.find((finding) => finding.level === "warn");
  assert.ok(warnHit, JSON.stringify(warn));
  assert.match(warnHit.title, /a ≈ b/);

  const mid = daily(40, (i) => common(i) + Math.cos(i * 1.3) * 0.01);
  const info = collinearityFindings([style({ key: "a", daily: a }), style({ key: "c", daily: mid })], 0.95, 0.6);
  assert.equal(info.find((finding) => finding.title.includes("偏像"))?.level, "info");

  // 独立序列：相关 ≈ 0，走 ok 档。
  const independent = daily(40, (i) => Math.cos(i * 1.3) * 0.01);
  const ok = collinearityFindings([style({ key: "a", daily: a }), style({ key: "d", daily: independent })]);
  assert.equal(ok[0].level, "ok");
});

test("共线性：只有一套带序列时如实说无法评估，不硬算", () => {
  const findings = collinearityFindings([style({ key: "a", daily: daily(30, () => 0.01) }), style({ key: "b" })]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].title, "共线性无法评估");
  assert.equal(findings[0].level, "info");
});

test("覆盖率：抽样没全拿到出 warn；窗口短出 info；完整且够长出 ok", () => {
  const gap = coverageFinding({ ...ENV, covered: 45 });
  assert.equal(gap.level, "warn");
  assert.match(gap.detail, /45/);

  const short = coverageFinding({ ...ENV, days: 80 });
  assert.equal(short.level, "info");

  assert.equal(coverageFinding(ENV).level, "ok");
});

test("样本：|t| ≥ 2 但笔数少是 info（t 值只当参考）；|t| < 2 且少是 warn", () => {
  const findings = sampleSizeFindings([
    style({ key: "thin", trades: 60, tStat: 2.3 }),
    style({ key: "none", trades: 40, tStat: 0.5 }),
  ]);
  assert.equal(findings.find((finding) => finding.title.includes("thin"))?.level, "info");
  assert.equal(findings.find((finding) => finding.title.includes("none"))?.level, "warn");

  const ok = sampleSizeFindings([style({ key: "fat", trades: 300 })]);
  assert.equal(ok[0].level, "ok");
});

test("回撤：连亏超 10 天或回撤超 50% 出 warn，都正常出 ok", () => {
  const findings = drawdownFindings([
    style({ key: "bleed", worstStreak: 13 }),
    style({ key: "deep", drawdown: 0.6 }),
  ]);
  assert.equal(findings.find((finding) => finding.title.includes("bleed"))?.level, "warn");
  assert.equal(findings.find((finding) => finding.title.includes("deep"))?.level, "warn");
  assert.equal(drawdownFindings([style({ key: "calm" })])[0].level, "ok");
});

test("前视：fillMode=b 出 ok 且如实声明防线在单测；别的 fillMode 出 warn", () => {
  assert.equal(lookaheadFinding(ENV).level, "ok");
  assert.match(lookaheadFinding(ENV).detail, /fillMode=b/);
  assert.equal(lookaheadFinding({ ...ENV, fillMode: "a" }).level, "warn");
});

test("auditRun：对一次运行出全套，warn 排在最前", () => {
  const findings = auditRun({
    env: { ...ENV, covered: 30 },
    styles: [
      style({ key: "a", daily: daily(40, (i) => 0.01 + Math.sin(i) * 0.001), trades: 40, tStat: 2.2 }),
      style({ key: "b", daily: daily(40, (i) => 0.02 + Math.sin(i) * 0.001), trades: 40, tStat: 1.1, worstStreak: 12 }),
    ],
  });
  const levels = findings.map((finding) => finding.level);
  assert.ok(levels.indexOf("warn") <= levels.indexOf("info") || !levels.includes("info"));
  assert.ok(findings.some((finding) => finding.area === "共线性" && finding.level === "warn"));
  assert.ok(findings.some((finding) => finding.area === "覆盖率" && finding.level === "warn"));
  assert.ok(findings.some((finding) => finding.area === "前视"));
});
