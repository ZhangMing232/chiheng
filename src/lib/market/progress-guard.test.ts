/**
 * 这个文件是干什么的：
 * 钉住收工守卫的判定，尤其是**推进感知**那条——
 * 「集合变了但变少了」不算推进，这条最容易写成「只要变就算」，然后预算照样被烧光。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { DEFAULT_LIMITS, advanced, judgeRound, type RoundTrace } from "@/lib/market/progress-guard";

function trace(over: Partial<RoundTrace> = {}): RoundTrace {
  return { blocks: 0, idle: 0, lastKeys: [], ...over };
}

test("补齐了就放行，并且把产出状态记下去", () => {
  const v = judgeRound([], ["a", "b"], trace());
  assert.equal(v.outcome, "allow");
  assert.deepEqual(v.trace.lastKeys, ["a", "b"]);
});

test("缺东西就拦下，不是放行也不是终止", () => {
  const v = judgeRound(["还差报告"], [], trace());
  assert.equal(v.outcome, "block");
  assert.equal(v.trace.blocks, 1);
  assert.equal(v.trace.idle, 1);
});

test("有推进时空转计数回 1，不是回 0", () => {
  const v = judgeRound(["还差报告"], ["a", "b"], trace({ blocks: 3, idle: 4, lastKeys: ["a"] }));
  assert.equal(v.outcome, "block", "还有问题就不能放行");
  assert.equal(v.trace.idle, 1, "推进了就该重新给机会，但仍是第 1 次空转计数");
});

test("推进的判据：集合变了且条数没减少", () => {
  assert.equal(advanced(["a"], ["a", "b"]), true, "变多了 = 推进");
  assert.equal(advanced(["a", "b"], ["a", "c"]), true, "换了內容也是推进");
  assert.equal(advanced(["a", "b"], ["a"]), false, "变少了不算推进");
  assert.equal(advanced(["a"], ["a"]), false, "一模一样不算推进");
});

test("顺序不同但集合相同 = 没推进（指纹要先排序）", () => {
  const v = judgeRound(["还差报告"], ["b", "a"], trace({ lastKeys: ["a", "b"] }));
  assert.equal(v.outcome, "block");
  assert.equal(v.trace.idle, 1, "同一批产出换个顺序不算新东西");
});

test("连续空转到上限就终止本轮", () => {
  const t = trace({ blocks: DEFAULT_LIMITS.maxIdle - 1, idle: DEFAULT_LIMITS.maxIdle - 1, lastKeys: ["a"] });
  const v = judgeRound(["还差报告"], ["a"], t);
  assert.equal(v.outcome, "abort");
  assert.match(v.why, /空转终止/);
});

test("abort 是失败，不是「也算完成」——理由里必须带着还差什么", () => {
  const v = judgeRound(["缺最终的评估报告"], ["a"], trace({ idle: 99, lastKeys: ["a"] }));
  assert.equal(v.outcome, "abort");
  assert.ok(v.why.length > 0, "停手必须能说清为什么停，不能静默结束");
});

test("累计拦截达硬上限时，哪怕正在推进也要停", () => {
  const v = judgeRound(
    ["还差报告"],
    ["a", "b", "c"],
    trace({ blocks: DEFAULT_LIMITS.maxTotal - 1, idle: 1, lastKeys: ["a", "b"] }),
  );
  assert.equal(v.outcome, "abort", "硬上限是兜底，推进也救不回来");
  assert.match(v.why, /硬上限/);
});
