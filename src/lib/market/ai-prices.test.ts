/**
 * 这个文件是干什么的：
 * 钉住模型参考价目表（ai-prices.ts）的约定——精确匹配、退役名别名、对不上
 * 返回 null。这张表是费用统计的默认值来源：匹配规则错了，费用统计就静默全灭
 * （都走「不算钱不瞎编」分支），所以值得单独钉。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { referencePriceOf, AI_PRICE_ASOF } from "@/lib/market/ai-prices";

test("精确名命中：deepseek-flash / deepseek-v4-pro 有 2026-10 官方价", () => {
  assert.deepEqual(referencePriceOf("deepseek-flash"), { prompt: 1.1, completion: 4.3 });
  assert.deepEqual(referencePriceOf("deepseek-v4-pro"), { prompt: 4.7, completion: 14.1 });
});

test("Kimi 各型号有价：k2.6 / k2.7-code / 高速版 / k3 / k2-0905-preview", () => {
  assert.deepEqual(referencePriceOf("kimi-k2.6"), { prompt: 6.5, completion: 27 });
  assert.deepEqual(referencePriceOf("kimi-k2.7-code"), { prompt: 6.5, completion: 27 });
  assert.deepEqual(referencePriceOf("kimi-k2.7-code-highspeed"), { prompt: 6.5, completion: 54 });
  assert.deepEqual(referencePriceOf("kimi-k3"), { prompt: 20, completion: 100 });
  assert.deepEqual(referencePriceOf("kimi-k2-0905-preview"), { prompt: 4, completion: 16 });
});

test("退役名走别名：deepseek-v4-flash 已路由到 V4.1 Flash，按 flash 价计", () => {
  assert.deepEqual(referencePriceOf("deepseek-v4-flash"), referencePriceOf("deepseek-flash"));
});

test("对不上的模型返回 null（调用方「不算钱不瞎编」分支要靠它）", () => {
  assert.equal(referencePriceOf("some-local-model"), null);
  assert.equal(referencePriceOf(""), null);
});

test("表带核对月份：价是市场信息会变，asOf 必须在", () => {
  assert.match(AI_PRICE_ASOF, /^\d{4}-\d{2}$/);
});
