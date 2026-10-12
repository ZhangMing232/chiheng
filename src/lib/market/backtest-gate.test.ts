import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  decideGate,
  costDragRows,
  formatDragRow,
  klineRef,
  type GateInput,
  type TradeLite,
} from "@/lib/market/backtest-gate";

const BASE: GateInput = {
  sampleRequested: 300,
  universeGot: 5000,
  sampleGot: 300,
  klinesGot: 295,
  minBarsRequired: 62,
  sampleWithEnoughBars: 290,
  turnoverGateActive: true,
  turnoverGateForcedOff: false,
};

describe("decideGate：三问闸口", () => {
  it("样本/覆盖/预热都够 → plan，且换手率闸状态写进 plan", () => {
    const d = decideGate(BASE);
    assert.equal(d.kind, "plan");
    if (d.kind !== "plan") return;
    assert.ok(d.plan.some((line) => line.includes("换手率闸：已生效")));
  });

  it("R1：样本不足 50 只 → refusal，带 reason 和 remedy", () => {
    const d = decideGate({ ...BASE, sampleGot: 30 });
    assert.equal(d.kind, "refusal");
    if (d.kind !== "refusal") return;
    assert.match(d.reason, /30 只/);
    assert.ok(d.remedy.length > 0);
  });

  it("R2：覆盖率低于一半 → refusal", () => {
    const d = decideGate({ ...BASE, klinesGot: 100, sampleGot: 300 });
    assert.equal(d.kind, "refusal");
    if (d.kind !== "refusal") return;
    assert.match(d.reason, /覆盖率/);
  });

  it("R3：预热不足一半 → refusal", () => {
    const d = decideGate({ ...BASE, sampleWithEnoughBars: 100, sampleGot: 300 });
    assert.equal(d.kind, "refusal");
    if (d.kind !== "refusal") return;
    assert.match(d.reason, /预热/);
  });

  it("边界：覆盖率恰好 50% 不拒（< 才拒）", () => {
    const d = decideGate({ ...BASE, klinesGot: 150, sampleGot: 300 });
    assert.equal(d.kind, "plan");
  });

  it("BT_TURNOVER=0 显式关闸不拒，plan 里写明是有意对照", () => {
    const d = decideGate({ ...BASE, turnoverGateActive: false, turnoverGateForcedOff: true });
    assert.equal(d.kind, "plan");
    if (d.kind !== "plan") return;
    assert.ok(d.plan.some((line) => line.includes("有意对照")));
  });

  it("缓存缺失（没显式关）不拒，但 plan 里必须有补救指引", () => {
    const d = decideGate({ ...BASE, turnoverGateActive: false, turnoverGateForcedOff: false });
    assert.equal(d.kind, "plan");
    if (d.kind !== "plan") return;
    assert.ok(d.plan.some((line) => line.includes("build-floatcap")));
  });
});

describe("costDragRows：费用 drag 对照", () => {
  const labels = { a: "策略A", b: "策略B" };
  const mk = (rets: number[]): TradeLite[] => rets.map((ret, i) => ({ id: `s${i}`, date: "2026-01-01", ret }));

  it("同一策略有费/免费并排，drag = 均值差", () => {
    const rows = costDragRows(labels, { a: mk([0.01, 0.03]) }, { a: mk([0.01102, 0.03102]) });
    assert.equal(rows.length, 2);
    assert.equal(rows[0].n, 2);
    assert.ok(rows[0].drag != null);
    assert.ok(Math.abs(rows[0].drag! - -0.00102) < 1e-9);
    // 没有交易的策略两侧都是 null，不拿 0 凑
    assert.equal(rows[1].avgWithFee, null);
    assert.equal(rows[1].drag, null);
  });

  it("formatDragRow：null 显示 —，drag 三位小数", () => {
    const row = formatDragRow({ key: "a", label: "策略A", n: 2, avgWithFee: 0.02, avgFree: 0.02102, drag: -0.00102 });
    assert.match(row, /策略A/);
    assert.match(row, /-0\.102%/);
  });
});

describe("klineRef：来源标注格式单点", () => {
  it("缓存目录 + 代码 + 信号日", () => {
    assert.equal(klineRef("data/backtest/kline", "sh600000", "2026-09-30"), "data/backtest/kline/sh600000.json@2026-09-30");
  });
});
