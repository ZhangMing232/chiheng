import assert from "node:assert/strict";
import { test } from "node:test";
import { planDesk } from "./desk-plan.ts";

test("回测提问只指向回测页，不发明数字", () => {
  const plan = planDesk("这套回测的超额和胜率怎么样");
  assert.deepEqual(plan.tools.map((tool) => tool.id), ["backtest"]);
  assert.equal(plan.refusals.length, 0);
  assert.equal(plan.screened, null);
});

test("券商下单和保证赚钱都拒绝", () => {
  const plan = planDesk("帮我在富途实盘下单，这套稳赚");
  assert.ok(plan.refusals.some((line) => line.includes("不到券商")));
  assert.ok(plan.refusals.some((line) => line.includes("不保证收益")));
});

test("夹了买卖建议的问句要被红线标出来", () => {
  const plan = planDesk("建议买入这只，回测看看");
  assert.ok(plan.screened);
  assert.ok(plan.tools.some((tool) => tool.id === "backtest"));
});

test("空问题不匹配任何工具", () => {
  const plan = planDesk("   ");
  assert.equal(plan.tools.length, 0);
  assert.equal(plan.question, "");
});
