/**
 * #162 正向信号研究脚本（scripts/backtest-forward-signal.ts）的守门测试。
 *
 * 钉死口径，防止以后有人把「反向过关」当「正向可用」报上去：
 * 1. 与 live 同口径（t+1 开盘买、t+N 收盘卖、成本、沪深300 基准）；
 * 2. 判决走 genome-verdict 的聚类 t，不自己实现；
 * 3. 「干净的正向」必须同时要求正向 + 聚类 t≥2 + 前后同向，且三个 horizon 全过；
 * 4. 样本不足不硬判。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const src = readFileSync(join(ROOT, "scripts/backtest-forward-signal.ts"), "utf8");

test("正向信号脚本用与 live 一致的成交口径", () => {
  assert.ok(src.includes("k[idx + 1].o"), "买入必须是事件日次日开盘价");
  assert.ok(src.includes("k[idx + N].c"), "卖出必须是 t+N 收盘价");
  assert.ok(src.includes("COST = 0.003"), "成本 0.3% 来回");
  assert.ok(src.includes('loadBench("sh000300")'), "基准沪深300");
  assert.ok(src.includes("HOLD_DAYS = [10, 20, 55]"), "三个 horizon 都要看");
});

test("判决必须走聚类稳健 t + 双闸，不自己实现 t", () => {
  assert.ok(src.includes('from "@/lib/market/genome-verdict"'), "复用 genome-verdict");
  assert.ok(src.includes("clusterTOf(") && src.includes("halvesSameSignOf(") && src.includes("judgeGenomeVerdict("), "三个都要用");
  assert.ok(!/function\s+clusterTOf/.test(src), "不许重写聚类 t");
  assert.ok(src.includes("GENOME_MIN_TRADES"), "样本不足要显式标注");
});

test("干净的正向信号必须同时满足正向、t≥2、前后同向", () => {
  assert.ok(src.includes("r.positive === true") || src.includes("allPositive"), "必须查方向");
  assert.ok(src.includes("clusteredT >= 2") || src.includes("allStrong"), "必须查 t 强度");
  assert.ok(src.includes("halvesSameSign === true") || src.includes("allSame"), "必须查前后同向");
  assert.ok(src.includes("反向过关"), "负向过关要单独标，不许混成「过关」");
});

test("席位分组覆盖四类且未命中的进其他营业部，不硬猜", () => {
  assert.ok(src.includes('"机构"') && src.includes('"拉萨系"') && src.includes('"知名游资"') && src.includes('"其他营业部"'), "四组都要有");
  assert.ok(src.includes('"全体游资"'), "要有与 live NONINST 一致的合并口径");
  assert.ok(src.includes('return "其他营业部"'), "未命中要有兜底");
});
