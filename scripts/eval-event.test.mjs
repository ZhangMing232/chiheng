/**
 * #148 事件驱动策略（scripts/backtest.ts 的 BT_EVENT=1 / scripts/eval-event.ts）的守门测试。
 *
 * 钉死四条：
 * 1. 策略默认不注册（BT_EVENT=1 才开），不许污染日常基线和页面账本；
 * 2. 选股条件必须只认事件字段，不许偷偷引入价格形态条件；
 * 3. 事件数据的盘后时间口径必须显式披露 + 有严格滞后开关；
 * 4. 评价必须同时过六切片尺子和两种时间口径对照。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const bt = readFileSync(join(ROOT, "scripts/backtest.ts"), "utf8");
const ev = readFileSync(join(ROOT, "scripts/eval-event.ts"), "utf8");
const runner = readFileSync(join(ROOT, "scripts/lib/backtest-runner.ts"), "utf8");

test("事件策略默认不注册，只在 BT_EVENT=1 时进注册表", () => {
  assert.ok(bt.includes('process.env.BT_EVENT === "1" ? EVENT_STRATEGIES : {}'), "必须走实验开关");
  assert.ok(bt.includes("BT_NO_LOG=1"), "文档要说明跑实验时不污染账本");
});

test("事件策略选股只看事件字段，不引入价格形态条件", () => {
  const start = bt.indexOf("function eventStrategy");
  const end = bt.indexOf("const EVENT_STRATEGIES");
  assert.ok(start > 0 && end > start, "找得到策略函数体");
  const body = bt.slice(start, end);
  for (const banned of ["volRatio", "d20", "d60", "d5", "springStrength", "ma20"]) {
    assert.ok(!body.includes(banned), "事件策略里不许出现价格形态字段 " + banned);
  }
  for (const needed of ["marginBuy", "shortBalance", "hotNetBuy", "amountWan"]) {
    assert.ok(body.includes(needed), "事件策略要用到事件/成交额字段 " + needed);
  }
  assert.ok(body.includes("== null"), "字段缺失要显式判 null，不许拿 0 顶替");
});

test("盘后事件的时间口径必须披露且可切换严格滞后", () => {
  assert.ok(bt.includes("const EXT_LAG = process.env.BT_EXT_LAG"), "要有严格滞后开关");
  assert.ok(bt.includes("extDate"), "injectExt 必须用可切换的日期");
  assert.ok(bt.includes("盘后才公布") || bt.includes("盘后公布"), "报告头必须写明盘后口径");
  assert.ok(bt.includes("BT_EXT_LAG=1 严格滞后"), "披露段要打印当前用的是哪种口径");
});

test("评价器同时用六切片尺子与两种时间口径", () => {
  assert.ok(ev.includes('BT_SAMPLE: "2646"') && ev.includes('BT_HALF: "first"') && ev.includes('BT_OFFSET: "2"'), "六切片");
  assert.ok(ev.includes('for (const lag of ["0", "1"])'), "两种时间口径都要跑");
  assert.ok(ev.includes("靠盘后数据/前视撑着"), "必须能识别只在 lag=0 成立的假象");
  assert.ok(ev.includes("verdictFromTrades(") && ev.includes('from "@/lib/market/genome-verdict"'), "判决复用唯一实现");
  assert.ok(ev.includes("c.promoted && c.excess > 0"), "负向过关不算真稳");
  assert.ok(runner.includes('BT_NO_LOG: "1"'), "不污染 runs.jsonl（保证在公共执行器里）");
  assert.ok(ev.includes("runBacktestSlice"), "必须接公共执行器，不自己 spawn");
});
