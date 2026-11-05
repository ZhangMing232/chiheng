/**
 * 策略 spec → 回测适配层的测试。
 *
 * 钉住三件事：
 * 1. **口径表不许漂**：SPEC_EXPR_VARS 里每个变量都必须在 FIELD_SOURCES 里有出处，
 *    且「回测取不到的」必须在 SPEC_UNAVAILABLE 里——否则新加一个变量就悄悄没有来源。
 * 2. **拿不到 ≠ 没有**：pe/cap/turnover 缺失时映射成 null，绝不塞 0。
 * 3. **成交方向**：买价高于信号日收盘 = 追涨（stop），低于 = 等回踩（limit），相等 = 现价单。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FIELD_SOURCES,
  SPEC_UNAVAILABLE,
  loadGenomeSpec,
  metricRowToQuote,
  specBacktestReady,
  specBacktestSignal,
  specVarsUsed,
  type SpecBacktestRow,
} from "@/lib/market/spec-backtest";
import { SPEC_EXPR_VARS } from "@/lib/market/factor-expr";
import type { StrategySpec } from "@/lib/market/strategies";

function row(over: Partial<SpecBacktestRow> = {}): SpecBacktestRow {
  return {
    c: 10,
    chg: 0,
    pe: 10,
    pb: 1,
    cap: 100,
    floatCap: 80,
    turnover: 3,
    volRatio: 1.5,
    ampDay: 2,
    d5: 1,
    d10: 1,
    d20: 1,
    d60: 1,
    amountWan: 10000,
    isST: false,
    ...over,
  };
}

function spec(over: Partial<StrategySpec> = {}): StrategySpec {
  return {
    id: "t_spec",
    name: "测试 spec",
    select: ["pe <= 18"],
    rankBy: "40 - pe",
    pricing: { shape: "spot" },
    holdDays: 8,
    stopPct: 8,
    targetPct: 20,
    source: "manual",
    ...over,
  };
}

// ── 口径表完整性 ────────────────────────────────────────────────

test("口径表不许漂：每个 spec 变量都有出处，取不到的都进 SPEC_UNAVAILABLE", () => {
  for (const v of SPEC_EXPR_VARS) {
    assert.ok(FIELD_SOURCES[v], `变量「${v}」在 FIELD_SOURCES 里没有写来源——加变量必须同时写口径`);
  }
  for (const v of Object.keys(SPEC_UNAVAILABLE)) {
    assert.ok((SPEC_EXPR_VARS as readonly string[]).includes(v), `SPEC_UNAVAILABLE 里的「${v}」不在白名单里`);
    assert.ok(FIELD_SOURCES[v]?.source.includes("（无）"), `「${v}」标成取不到，口径表里也得写「（无）」`);
  }
});

// ── 变量抽取 ────────────────────────────────────────────────────

test("specVarsUsed：把 select / rankBy / 定价表达式里用到的变量抠出来", () => {
  const s = spec({
    select: ["pe <= 18", "pb < 2"],
    rankBy: "40 - pe",
    pricing: { shape: "expr", buyExpr: "price * 1.01", sellExpr: "price * 1.2" },
  });
  const vars = specVarsUsed(s);
  assert.ok(vars.includes("pe"));
  assert.ok(vars.includes("pb"));
  assert.ok(vars.includes("price"));
  assert.ok(!vars.includes("std20"), "白名单外的名字不该出现");
});

test("specBacktestReady：用到回测取不到的字段 → 拒跑并说清缺哪个", () => {
  const ok = specBacktestReady(spec());
  assert.equal(ok.ready, true);
  assert.deepEqual(ok.missing, []);

  const withInflow = specBacktestReady(spec({ rankBy: "inflow" }));
  assert.equal(withInflow.ready, false);
  assert.match(withInflow.missing.join(" "), /inflow/);

  const withYtd = specBacktestReady(spec({ select: ["ytd > 0"] }));
  assert.equal(withYtd.ready, false);
  assert.match(withYtd.missing.join(" "), /ytd/);
});

// ── 字段映射 ────────────────────────────────────────────────────

test("metricRowToQuote：拿不到的字段给 null，不给 0", () => {
  const q = metricRowToQuote(row({ pe: null, cap: null, turnover: null }), "sh600519");
  assert.equal(q.pe, null, "PE 取不到必须是 null，0 会被读成「PE 就是 0」");
  assert.equal(q.cap, null);
  assert.equal(q.turnover, null);
  assert.equal(q.price, 10);
});

test("metricRowToQuote：ST 标记带进 st 和名字（涨跌停按 5% 判）", () => {
  const q = metricRowToQuote(row({ isST: true }), "sh600519");
  assert.equal(q.st, true);
  assert.match(q.name, /ST/);
});

// ── 信号 ────────────────────────────────────────────────────────

test("specBacktestSignal：现价单（spot）→ 买价等于收盘，标 atClose", () => {
  const sig = specBacktestSignal(spec(), row(), "sh600519");
  assert.ok(sig != null);
  assert.equal(sig.buy, 10);
  assert.equal(sig.atClose, true);
  assert.equal(sig.fill, undefined, "现价单不走 stop/limit");
});

test("specBacktestSignal：买价高于信号日收盘 → 追涨（fill=stop）", () => {
  const s = spec({ pricing: { shape: "breakout", pct: 3 } });
  const sig = specBacktestSignal(s, row(), "sh600519");
  assert.ok(sig != null);
  assert.equal(sig.fill, "stop");
  assert.ok(sig.buy > 10, "买价应高于收盘");
});

test("specBacktestSignal：买价低于信号日收盘 → 等回踩（fill=limit）", () => {
  const s = spec({ pricing: { shape: "prevPct", pct: -2 } });
  const sig = specBacktestSignal(s, row(), "sh600519");
  assert.ok(sig != null);
  assert.equal(sig.fill, "limit");
  assert.ok(sig.buy < 10);
});

test("specBacktestSignal：选股不过 / ST / 市值取不到 → 都不给信号", () => {
  assert.equal(specBacktestSignal(spec(), row({ pe: 40 }), "sh600519"), null, "PE 超阈值选股不过");
  assert.equal(specBacktestSignal(spec(), row({ isST: true }), "sh600519"), null, "ST 不可交易");
  assert.equal(specBacktestSignal(spec(), row({ cap: null }), "sh600519"), null, "市值取不到 = 没法确认不是小盘股，保守拒");
});

test("specBacktestSignal：ST 股按 5% 涨跌停判，涨 6% 不是涨停（主板是 10%）", () => {
  // 主板 ST：limit=5%，chg=6% → 贴涨停 → 拒。
  const st = specBacktestSignal(spec(), row({ isST: true, chg: 6 }), "sh600519");
  assert.equal(st, null, "ST 涨 6% 已过 5% 涨停线，本就不该进（且 ST 本来就被拒）");
  // 科创板 20%：涨 15% 不是涨停。id 前缀决定板。
  const kcb = specBacktestSignal(spec(), row({ chg: 15 }), "sh688001");
  assert.ok(kcb != null, "科创板涨 15% 没到 20% 涨停，不该被当成涨停拒掉");
});

// ── 加载器（接回测的入口）────────────────────────────────────────

test("loadGenomeSpec：能取出候选 spec；口径不全或 id 不存在 → 抛错拒跑", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const dir = await mkdtemp(path.join(os.tmpdir(), "chiheng-genome-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    await writeFile(
      path.join(dir, "strategy-genome.json"),
      JSON.stringify({
        list: [
          {
            id: "g_ok", name: "能跑的", select: ["pe <= 18"], rankBy: "40 - pe",
            pricing: { shape: "spot" }, holdDays: 6, stopPct: 8, targetPct: 20,
            source: "ai", status: "proposed", since: "2026-11-05",
          },
          {
            id: "g_bad", name: "跑不了的", select: ["inflow > 0"], rankBy: "inflow",
            pricing: { shape: "spot" }, holdDays: 6, stopPct: 8, targetPct: 20,
            source: "ai", status: "proposed", since: "2026-11-05",
          },
        ],
      }),
      "utf8",
    );
    const ok = await loadGenomeSpec("g_ok");
    assert.equal(ok.spec.id, "g_ok");
    assert.equal(ok.hold, 6, "持有期跟着 spec 走，不走 StyleId 默认表");
    await assert.rejects(() => loadGenomeSpec("g_bad"), /inflow/, "用回测取不到的字段必须拒跑");
    await assert.rejects(() => loadGenomeSpec("g_nope"), /没有/, "id 不存在必须报错，不许悄悄跳过");
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
  }
});
