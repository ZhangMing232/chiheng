/**
 * 这个文件是干什么的：
 * 钉住 AI 综合的三道闸，以及**失败时必须安静降级**这条。
 *
 * 最关键的一条是「不许假装有 AI 参与」：AI 挂了就明说挂了，页面照常显示规则
 * 推出来的结论。悄悄把模板结论说成 AI 说的，比没有 AI 更糟。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  buildResearchPrompt,
  collectEvidence,
  parseAiOutput,
  runAiSynthesis,
  type AiCaller,
} from "@/lib/market/research-ai";
import { runResearch } from "@/lib/market/research";
import type { Quote } from "@/lib/market/types";
import type { StageResult } from "@/lib/market/research";

function quote(): Quote {
  return {
    id: "sh600519", code: "600519", name: "贵州茅台", board: "sh", price: 1500, chg: 1.2,
    pe: 22.5, pb: 7.8, cap: 18800, floatCap: 18800, turnover: 0.35, volRatio: 1.1, amp: 1.8,
    d5: 1, d10: 2, d20: -3, d60: 5, ytd: 8, inflow: 12000, amount: 300000, st: false,
  };
}

/** 造一组带证据的阶段，喂给 AI。 */
function stages(): StageResult[] {
  return runResearch({ quote: quote(), articles: [] }).stages;
}

/** 一个按剧本返回的假 AI。不联网、不烧 token。 */
function fakeAi(reply: string | (() => never)): AiCaller {
  return async () => {
    if (typeof reply === "string") return reply;
    reply();
    return "";
  };
}

test("prompt 里逐条带证据 id：AI 要能指名道姓地引用", () => {
  const p = buildResearchPrompt(stages(), "600519", "贵州茅台");
  assert.match(p, /ev-/, "证据要带 id");
  assert.match(p, /市盈率 TTM/, "证据内容要在");
  assert.match(p, /600519/, "标的信息要在");
  assert.match(p, /只输出 JSON/, "输出格式要求要写死");
});

test("AI 正常回答：过闸后给出文本，并留下引用链", async () => {
  const ev = collectEvidence(stages());
  const ai = fakeAi(JSON.stringify({ refs: [ev[0]!.id], text: "市盈率处于自身历史中位，估值不极端。" }));
  const r = await runAiSynthesis(stages(), "600519", "贵州茅台", ai, ev.map((e) => e.id));
  assert.equal(r.status, "ok");
  assert.match(r.text!, /市盈率/);
  assert.deepEqual(r.refs, [ev[0]!.id]);
  assert.match(r.chain!, /aiSynthesis/, "AI 综合本身要记成一条 calculation");
});

test("AI 编造材料里没有的数字：数字闸门把它换掉", async () => {
  const ev = collectEvidence(stages());
  const ai = fakeAi(JSON.stringify({ refs: [], text: "明年营收预计 9876 亿元，市盈率会到 55 倍。" }));
  const r = await runAiSynthesis(stages(), "600519", "贵州茅台", ai, ev.map((e) => e.id));
  assert.equal(r.status, "ok", "编数字不等于越线，照出但换掉");
  assert.ok(r.numbersReplaced >= 2, `两个编的数字都该被换，实际 ${r.numbersReplaced}`);
  assert.ok(r.text!.includes("（略※）"), "换成了占位符");
  assert.ok(!r.text!.includes("9876"), "原文不许留下");
});

test("AI 给投资建议：红线拦下，整句不出", async () => {
  const ai = fakeAi(JSON.stringify({ refs: [], text: "建议在 1500 元买入，止损设在 1400 元。" }));
  const r = await runAiSynthesis(stages(), "600519", "贵州茅台", ai);
  assert.equal(r.status, "refused");
  assert.equal(r.text, null, "越线的话一个字都不显示");
  assert.match(r.why!, /红线/);
});

test("AI 挂了：降级 + 说清原因，不假装有 AI", async () => {
  const boom: AiCaller = async () => {
    throw new Error("HTTP 503");
  };
  const r = await runAiSynthesis(stages(), "600519", "贵州茅台", boom);
  assert.equal(r.status, "failed");
  assert.equal(r.text, null);
  assert.match(r.why!, /503/, "原因要具体，不能只说「出错了」");
});

test("没注入 caller：skipped，这一轮不调", async () => {
  const r = await runAiSynthesis(stages(), "600519", "贵州茅台", null);
  assert.equal(r.status, "skipped");
  assert.match(r.why!, /未配置|关闭/);
});

test("AI 声明引用不存在的证据：那个 id 被剔掉，不许进 inputsRefs", async () => {
  const ai = fakeAi(JSON.stringify({ refs: ["ev-压根不存在"], text: "基于某条证据的判断。" }));
  const r = await runAiSynthesis(stages(), "600519", "贵州茅台", ai, ["ev-真实的那条"]);
  assert.deepEqual(r.refs, [], "悬空引用必须剔掉");
  assert.equal(r.status, "ok");
});

test("AI 没按 JSON 回：按纯文本处理，并明说引用关系不可查", async () => {
  const ai = fakeAi("这是一段纯文本，没有 JSON。");
  const r = await runAiSynthesis(stages(), "600519", "贵州茅台", ai);
  assert.equal(r.status, "ok");
  assert.match(r.text!, /没按要求的 JSON 回/, "要告诉读者引用关系查不了");
});

test("parseAiOutput：能剥掉 JSON 外面的废话", () => {
  const r = parseAiOutput('好的，结果如下：{"refs":["ev-a"],"text":"内容"} 希望有帮助');
  assert.equal(r.parsed, true);
  assert.deepEqual(r.refs, ["ev-a"]);
  assert.equal(r.text, "内容");
});

test("空内容算失败，不算成功", async () => {
  const r = await runAiSynthesis(stages(), "600519", "贵州茅台", fakeAi("   "));
  assert.equal(r.status, "failed");
  assert.match(r.why!, /空/);
});
