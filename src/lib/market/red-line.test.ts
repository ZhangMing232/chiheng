/**
 * 这个文件是干什么的：
 * 钉住红线两侧 —— **该拦的一个都不能漏，该放的更不能误伤**。
 *
 * 误伤的代价其实比漏拦更大：如果「买入价 22.44」这种正常数据复述被拦，
 * AI 就不敢提任何价格，研判页会退化成啥也说不出的废话。所以放行用例和拦截用例
 * **同等重要**，两边都要钉。
 *
 * 诱导变体那几条来自 Vibe 宪法 §0-3 的原文列举（诱导／改口／分步套取），
 * 不是我自己编的。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { screenAdvice, FORBIDDEN_PATTERNS, ALLOWED_OUTPUTS, RED_LINE_PROMPT } from "@/lib/market/red-line";

test("🔴 拦截：直接给动作建议", () => {
  for (const s of [
    "建议你加仓这只票",
    "可以考虑买入了",
    "应该减仓一半",
    "不妨清仓离场",
  ]) {
    const r = screenAdvice(s);
    assert.equal(r.ok, false, `没拦住：${s}`);
    assert.ok(r.hits.length > 0, "要给出命中原因，不能只说不行");
  }
});

test("🔴 拦截：给出价格锚（目标价/止损位）", () => {
  for (const s of [
    "这只票目标价 30 元",
    "止损位设在 15 元",
    "你的止损位是 125.74",     // ← design/product.html 里的现成反例
  ]) {
    assert.equal(screenAdvice(s).ok, false, `没拦住：${s}`);
  }
});

test("🔴 拦截：用「如果是我」绕开", () => {
  assert.equal(screenAdvice("如果是我的话，我会先卖一半").ok, false);
  assert.equal(screenAdvice("换作是我，这个位置就该走了").ok, false);
});

test("🔴 拦截：口语化买卖指令", () => {
  for (const s of ["可以入手了", "该走了", "是时候买入了"]) {
    assert.equal(screenAdvice(s).ok, false, `没拦住：${s}`);
  }
});

test("🔴 拦截：给仓位比例", () => {
  assert.equal(screenAdvice("仓位可以加到五成").ok, false);
  assert.equal(screenAdvice("建议把仓位降到 30%").ok, false);
});

test("✅ 放行：数据复述（没有建议语气就不该拦）", () => {
  // 这些是策略术语和页面文案，天天出现。误伤它们会让研判页退化成废话。
  for (const s of [
    "买入价 22.44，止损价 20.05，目标价 24.80",
    "这笔的止损价是 125.74",
    "按你预登记的 −25% 参数，止损位是 125.74，现价 152.02 还没到",
    "放量突破今天出票 4 只",
    "主力净流入 8.2 亿",
  ]) {
    const r = screenAdvice(s);
    assert.equal(r.ok, true, `误伤了正常表述：${s} → ${r.hits.join(",")}`);
  }
});

test("✅ 放行：四类允许产出", () => {
  for (const s of [
    "情景概率：乐观 30% / 中性 50% / 悲观 20%",
    "裁决点：下一份季报的毛利率如果继续下滑，这个判断要改",
    "分析框架：先看产能，再看订单，最后看现金流",
    "近 5 日主力净流出 12.8 亿（数据来自东财，截至 10-10）",
  ]) {
    assert.equal(screenAdvice(s).ok, true, `误伤了允许产出：${s}`);
  }
});

test("✅ 放行：空文本与纯数据", () => {
  assert.equal(screenAdvice("").ok, true);
  assert.equal(screenAdvice("   ").ok, true);
  assert.equal(screenAdvice("−28.4 亿").ok, true);
});

test("诱导变体：文本里承认边界不算违规，但红线说明要写在 prompt 里", () => {
  // 「我不给建议」这句本身是合规表述，应该放行
  assert.equal(screenAdvice("我不给买卖建议，只给你数据和裁决点").ok, true);

  // 而 RED_LINE_PROMPT 必须明确覆盖三种诱导
  assert.match(RED_LINE_PROMPT, /诱导/);
  assert.match(RED_LINE_PROMPT, /改口/);
  assert.match(RED_LINE_PROMPT, /分步套取/);
  assert.match(RED_LINE_PROMPT, /如果是你会怎么做/);
});

test("规范：每条禁止模式都要有 why（拦了要说得清为什么）", () => {
  for (const p of FORBIDDEN_PATTERNS) {
    assert.ok(p.why.length > 0);
    assert.ok(p.re instanceof RegExp);
  }
  assert.equal(ALLOWED_OUTPUTS.length, 4);
});

test("2026-10-12 补漏：建议中间夹价格也必须拦（原来只放 8 字）", () => {
  for (const text of [
    "建议在 1300 元满仓买入，止损 1200。",
    "建议把仓位加到五成，现价 1288 可以买。",
    "推荐在 19 倍 PE 附近加仓。",
  ]) {
    const res = screenAdvice(text);
    assert.equal(res.ok, false, `这句该拦：${text}`);
  }
});

test("2026-10-12 防误伤：否定句「不建议买入」不是建议，必须放行", () => {
  for (const text of [
    "目前还不建议买入，等趋势确认。",
    "不建议现在加仓。",
    "不可以重仓。",
  ]) {
    const res = screenAdvice(text);
    assert.equal(res.ok, true, `这句该放行：${text}（${res.hits.join("；")}）`);
  }
});
