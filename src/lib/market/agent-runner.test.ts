/**
 * agent-runner.ts 的纯函数测试：costOfTokens。
 * （runAgentTask 会 spawn 子进程，属集成路径，不在纯函数测试范围。）
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { costOfTokens } from "./agent-runner.ts";
import { referencePriceOf } from "./ai-prices.ts";

test("costOfTokens：flash 价目表口径（1.1 / 4.3 元每百万 token）", () => {
  const r = costOfTokens(1_000_000, 1_000_000, "deepseek-flash");
  assert.equal(r.estimated, true);
  assert.ok(Math.abs(r.cny - (1.1 + 4.3)) < 1e-9);
});

test("costOfTokens：v4-pro 用另一档价（4.7 / 14.1），不写死 flash", () => {
  const r = costOfTokens(1_000_000, 1_000_000, "deepseek-v4-pro");
  assert.ok(Math.abs(r.cny - (4.7 + 14.1)) < 1e-9);
});

test("costOfTokens：与 ai-prices.ts 的单表同源（不另抄一份）", () => {
  const price = referencePriceOf("deepseek-v4-pro")!;
  const r = costOfTokens(2_000_000, 500_000, "deepseek-v4-pro");
  const expected = (2_000_000 / 1e6) * price.prompt + (500_000 / 1e6) * price.completion;
  assert.ok(Math.abs(r.cny - expected) < 1e-9);
});

test("costOfTokens：模型名查不到按 flash 兜底，不抛错", () => {
  const r = costOfTokens(1_000_000, 0, "unknown-model-xyz");
  assert.ok(Math.abs(r.cny - 1.1) < 1e-9);
});

test("costOfTokens：零 token = 0 元", () => {
  assert.equal(costOfTokens(0, 0, "deepseek-flash").cny, 0);
});
