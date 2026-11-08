/**
 * #163 offset1 归因脚本的守门测试。
 *
 * 钉死两个真实的坑：
 * 1. 抽样周期 = step，扫 offset 超过 step 就是重复样本，不许当独立批次算 t；
 * 2. 判断过滤器好坏必须看「开 − 关」的增益，不能看「开之后的超额绝对值」——
 *    早前就是把 offset1「开后仍为负」误读成「过滤器反向」，写进了结论。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const src = readFileSync(join(ROOT, "scripts/diag-offset1.ts"), "utf8");
const runner = readFileSync(join(ROOT, "scripts/lib/backtest-runner.ts"), "utf8");

test("明确写出抽样周期，独立批次只用不重复的那几个", () => {
  assert.ok(src.includes("抽样周期") && src.includes("step = 3"), "必须写明 step 周期");
  assert.ok(src.includes("INDEPENDENT_OFFSETS = [0, 1, 2]"), "独立批次只有 3 个");
  assert.ok(src.includes("ALL_OFFSETS") && src.includes("证明"), "重复批次只用来证明周期性");
  assert.ok(src.includes("INDEPENDENT_OFFSETS.map"), "统计只基于独立批次");
  assert.ok(!/const gains = ALL_OFFSETS\.map/.test(src), "不许拿全部 offset 算增益统计");
});

test("增益按「开 − 关」算，不是看开之后的绝对值", () => {
  assert.ok(src.includes("exOn - exOff"), "增益必须是差值");
  assert.ok(src.includes("挡对了") || src.includes("exBlocked < exKept"), "要反算被挡票的真实收益");
  assert.ok(src.includes("误读"), "把早前的错误结论写明，不许悄悄改掉");
});

test("口径与 live 一致", () => {
  assert.ok(src.includes("loadAvoidIndex") && src.includes("shouldAvoid"), "必须复用 live 索引，不自己重造");
  assert.ok(src.includes("BT_AVOID_WIN: String(WIN)") && src.includes("LHB_THRESH: \"3000\""), "窗口与阈值要和 live 对齐");
  assert.ok(runner.includes('BT_NO_LOG: "1"') || src.includes('BT_NO_LOG: "1"'), "不污染 runs.jsonl");
});
