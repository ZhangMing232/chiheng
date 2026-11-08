/**
 * #144 regime 择时过滤评价脚本（scripts/eval-regime.ts）的守门测试。
 *
 * 钉死两条：
 * 1. 评价必须用 #145 的六切片尺子（大样本 + 样本外 + 多批次），不许退回单切片报数；
 * 2. 「真稳」必须同时要求过关 + 超额为正 —— 判决函数判 |t|，稳定亏钱也会 promoted。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const src = readFileSync(join(ROOT, "scripts/eval-regime.ts"), "utf8");
const runner = readFileSync(join(ROOT, "scripts/lib/backtest-runner.ts"), "utf8");

test("regime 评价用六切片尺子，不退回全池单个数", () => {
  assert.ok(src.includes('BT_SAMPLE: "2646"'), "大样本全池");
  assert.ok(src.includes('BT_HALF: "first"') && src.includes('BT_HALF: "second"'), "前后半段样本外");
  assert.ok(src.includes('BT_OFFSET: "0"') && src.includes('BT_OFFSET: "1"') && src.includes('BT_OFFSET: "2"'), "三批抽样");
  assert.ok(src.includes("BT_FILTER"), "必须真的开关门控做对比");
  assert.ok(src.includes('from "@/lib/market/genome-verdict"'), "判决必须复用聚类 t");
  assert.ok(!/function\s+clusterTOf/.test(src), "不许重写聚类 t");
});

test("真稳判定必须同时要求过关与超额为正", () => {
  assert.ok(src.includes("c.promoted && c.excess > 0"), "负向过关不能算真稳");
  assert.ok(src.includes("GENOME_MIN_TRADES"), "必须带最小样本数闸");
  assert.ok(src.includes("BK_FAMILY"), "bk2/bk4 家族要单独列，不许混在平均里糊过去");
});

test("不污染页面账本", () => {
  assert.ok(runner.includes('BT_NO_LOG: "1"') || src.includes('BT_NO_LOG: "1"'), "批量跑不许往 runs.jsonl 追加");
});
