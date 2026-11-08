/**
 * 统一策略评价器（scripts/eval-robust.ts）的守门测试。
 *
 * 2026-11-08 改造：spawn 已从四个评价脚本抽到公共执行器 scripts/lib/backtest-runner.ts，
 * 原先「每个脚本里必须出现某字符串」的断言全部失效——这恰好说明纯字符串守门很脆。
 * 现在拆成两层：
 *   - 公共执行器：验证通用保证（清旧 dump / error 处理 / dump 校验 / 不污染账本）；
 *   - 调用方：只验证「确实接了公共执行器 + 判决走唯一实现」。
 * 真正的行为验证放在 genome-verdict.test.ts / strategy-gate.test.ts（有可执行断言）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { buildSlices } from "./lib/eval-slices.ts";

const ROOT = join(import.meta.dirname, "..");
const src = readFileSync(join(ROOT, "scripts/eval-robust.ts"), "utf8");
const runner = readFileSync(join(ROOT, "scripts/lib/backtest-runner.ts"), "utf8");

test("公共执行器：先删旧 dump，杜绝读到上次残留", () => {
  assert.ok(runner.includes("unlink(dumpPath)"), "spawn 前必须删旧 dump");
  assert.ok(runner.indexOf("unlink(dumpPath)") < runner.indexOf("spawn("), "删旧文件要在 spawn 之前");
});

test("公共执行器：spawn 失败 / dump 缺失 / 策略 key 缺失都要显式报错", () => {
  assert.ok(runner.includes('child.on("error"'), "必须有 spawn error 处理");
  assert.ok(runner.includes("dump 读不到或不是合法 JSON"), "dump 读不到不能静默");
  assert.ok(runner.includes("缺策略 key"), "策略没注册要报错，不能静默变 0 笔");
  assert.ok(runner.includes("所有策略共 0 笔成交"), "全空结果视为回测没跑对");
  assert.ok(runner.includes('BT_NO_LOG: "1"'), "不污染 runs.jsonl");
});

test("调用方接的是公共执行器，不自己 spawn", () => {
  assert.ok(src.includes("runBacktestSlice"), "必须 import 公共执行器");
  assert.ok(!src.includes("spawn("), "不许再自己 spawn（否则绕过上述保证）");
});

test("评价器用唯一实现的聚类稳健 t，不自己算 t", () => {
  assert.ok(src.includes("verdictFromTrades("), "判决输入必须走唯一构造入口");
  assert.ok(src.includes('from "@/lib/market/genome-verdict"'), "必须复用 genome-verdict");
  assert.ok(!/function\s+clusterTOf/.test(src), "不许在本文件里重写聚类 t");
});

test("评价器带大样本 + 样本外 + 多批次三个维度", () => {
  // 2026-11-08：切片定义已抽到 scripts/lib/eval-slices.ts（纯函数）。
  // 原来这里断言「源码里必须出现 BT_SAMPLE: "2646" 这串字符」——加了 BT_SAMPLE
  // 环境变量覆盖之后那串字符就没了，断言红了但源码没坏。改成直接 import 模块、
  // 把切片真算出来看，这样守的是行为不是排版。
  const slices = buildSlices({});

  const full = slices.filter((s) => s.name.startsWith("全池·"));
  assert.equal(full.length, 3, "全池必须切三段：全区间 / 前半段 / 后半段");
  assert.ok(
    full.every((s) => s.env.BT_SAMPLE === "2646"),
    "大样本必须是全池 2646",
  );
  assert.ok(
    full.some((s) => s.env.BT_HALF === "first") && full.some((s) => s.env.BT_HALF === "second"),
    "样本外必须前后半段各跑",
  );

  const batches = slices.filter((s) => s.name.startsWith("抽样·"));
  assert.equal(batches.length, 3, "多批次至少三批");
  const offsets = batches.map((s) => s.env.BT_OFFSET).sort();
  assert.deepEqual(offsets, ["0", "1", "2"], "三批的 offset 必须是 0/1/2（互不重叠的三个批次）");

  assert.ok(src.includes("GENOME_MIN_TRADES"), "必须带最小样本数闸");
});

test("切片支持 BT_SAMPLE 整体覆盖（小样本先验证链路用）", () => {
  const small = buildSlices({ BT_SAMPLE: "80" });
  assert.ok(
    small.every((s) => s.env.BT_SAMPLE === "80"),
    "BT_SAMPLE 必须能整体覆盖所有切片",
  );
  // 覆盖后结构不变（还是六切片、前后半段、三个批次）
  assert.equal(small.length, 6);
  assert.ok(small.some((s) => s.env.BT_HALF === "first"));
  assert.ok(small.some((s) => s.env.BT_HALF === "second"));
  assert.deepEqual(
    small.filter((s) => s.env.BT_OFFSET).map((s) => s.env.BT_OFFSET).sort(),
    ["0", "1", "2"],
  );
});

test("评价器区分正向过关与负向过关（做多不能把稳定亏钱当 alpha）", () => {
  assert.ok(src.includes("负向过关"), "矩阵必须把负向过关单独标出来");
  assert.ok(src.includes("allPositive"), "真稳判定必须要求所有切片超额为正");
  assert.ok(src.includes("excess < 0") || src.includes("excess <0"), "必须显式检查超额符号");
});
