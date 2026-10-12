/**
 * 这个文件是干什么的：
 * 钉住辩论的三条底线——**双方共用一份证据、双方都要过闸、两边都失败也要显示**。
 *
 * 「两边都失败也要显示」最容易被忘：空着一侧，读者会以为这一侧没有反面意见。
 * 沉默不是中立，是藏话。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildDebatePrompt, runDebate, type DebateRole } from "@/lib/market/debate";
import { runResearch } from "@/lib/market/research";
import type { AiCaller } from "@/lib/market/research-ai";
import type { Quote } from "@/lib/market/types";

function quote(): Quote {
  return {
    id: "sh600519", code: "600519", name: "贵州茅台", board: "sh", price: 1288, chg: 1.98,
    pe: 19.77, pb: 6.41, cap: 16101, floatCap: 16101, turnover: 0.25, volRatio: 1.03, amp: 2.14,
    d5: 3.55, d10: 1, d20: -3.16, d60: 6.89, ytd: -4.53, inflow: 14850, amount: 404300, st: false,
  };
}

function stages() {
  return runResearch({ quote: quote(), articles: [] }).stages;
}

/** 按角色返回不同台词的假 AI。 */
function fakeAi(script: Partial<Record<DebateRole, string | (() => never)>>): AiCaller {
  return async (prompt: string) => {
    const role: DebateRole = prompt.includes("支持继续跟踪") ? "bull" : "bear";
    const line = script[role];
    if (line == null) return JSON.stringify({ refs: [], text: "默认台词" });
    if (typeof line === "string") return line;
    line();
    return "";
  };
}

test("双方 prompt 的证据部分完全一致，只有任务描述不同", () => {
  const bull = buildDebatePrompt("bull", stages(), "600519", "贵州茅台");
  const bear = buildDebatePrompt("bear", stages(), "600519", "贵州茅台");
  const bullEvidence = bull.slice(bull.indexOf("双方共用"), bull.indexOf("任务："));
  const bearEvidence = bear.slice(bear.indexOf("双方共用"), bear.indexOf("任务："));
  assert.equal(bullEvidence, bearEvidence, "证据必须一字不差——多给一方材料就不是辩同一件事");
  assert.match(bull, /支持/);
  assert.match(bear, /反对/);
});

test("prompt 里写死不许给买卖建议", () => {
  const p = buildDebatePrompt("bull", stages(), "600519", "贵州茅台");
  assert.match(p, /不许给买卖建议/);
  assert.match(p, /该盯什么/, "辩论的产出是观察点，不是行动");
});

test("双方都正常：并列返回，各自带引用链", async () => {
  const ai = fakeAi({
    bull: JSON.stringify({ refs: ["ev-x"], text: "短期资金在流入，量比温和。" }),
    bear: JSON.stringify({ refs: ["ev-y"], text: "年内仍为负，中期趋势未修复。" }),
  });
  const r = await runDebate(stages(), "600519", "贵州茅台", ai, ["ev-x", "ev-y"]);
  assert.equal(r.sides.length, 2);
  assert.equal(r.sides[0]!.status, "ok");
  assert.equal(r.sides[1]!.status, "ok");
  assert.match(r.sides[0]!.chain!, /debate_bull/);
  assert.match(r.sides[1]!.chain!, /debate_bear/);
});

test("一方越线：只拦那一方，另一方照常", async () => {
  const ai = fakeAi({
    bull: JSON.stringify({ refs: [], text: "建议在 1300 元满仓买入，止损 1200。" }),
    bear: JSON.stringify({ refs: [], text: "年内跌幅仍在，需警惕。" }),
  });
  const r = await runDebate(stages(), "600519", "贵州茅台", ai);
  const bull = r.sides.find((s) => s.role === "bull")!;
  const bear = r.sides.find((s) => s.role === "bear")!;
  assert.equal(bull.status, "refused", "越线那方整段不出");
  assert.equal(bull.text, null);
  assert.equal(bear.status, "ok", "不能因为一边越线就顺手关掉另一边");
});

test("一方 AI 挂了：显示失败原因，不空着", async () => {
  const ai = fakeAi({
    bull: () => {
      throw new Error("HTTP 503");
    },
    bear: JSON.stringify({ refs: [], text: "年内为负。" }),
  });
  const r = await runDebate(stages(), "600519", "贵州茅台", ai);
  const bull = r.sides.find((s) => s.role === "bull")!;
  assert.equal(bull.status, "failed");
  assert.match(bull.why!, /503/, "原因要具体");
  assert.ok(bull.text == null);
});

test("双方都失败时两侧都有说明，不许空着一侧", async () => {
  const boom: AiCaller = async () => {
    throw new Error("超时");
  };
  const r = await runDebate(stages(), "600519", "贵州茅台", boom);
  for (const side of r.sides) {
    assert.equal(side.status, "failed");
    assert.ok(side.why, "每一侧都要说清为什么没出声");
  }
});

test("一方编数字：数字闸门换掉，但这一方照常显示", async () => {
  const ai = fakeAi({
    bull: JSON.stringify({ refs: [], text: "明年营收预计 9876 亿元，会大幅超预期。" }),
    bear: JSON.stringify({ refs: [], text: "年内仍弱。" }),
  });
  const r = await runDebate(stages(), "600519", "贵州茅台", ai);
  const bull = r.sides.find((s) => s.role === "bull")!;
  assert.equal(bull.status, "ok");
  assert.ok(bull.numbersReplaced >= 1);
  assert.ok(bull.text!.includes("（略※）"));
  assert.ok(!bull.text!.includes("9876"));
});

test("没注入 caller：两侧都 skipped", async () => {
  const r = await runDebate(stages(), "600519", "贵州茅台", null);
  for (const side of r.sides) assert.equal(side.status, "skipped");
});

test("声明引用不存在的证据：id 被剔掉", async () => {
  const ai = fakeAi({
    bull: JSON.stringify({ refs: ["ev-假的"], text: "基于某证据。" }),
    bear: JSON.stringify({ refs: [], text: "反对。" }),
  });
  const r = await runDebate(stages(), "600519", "贵州茅台", ai, ["ev-真的"]);
  assert.deepEqual(r.sides[0]!.refs, []);
});
