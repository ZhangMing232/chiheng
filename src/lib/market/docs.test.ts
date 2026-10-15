/**
 * 这个文件是干什么的：
 * 钉住文档库检索的口径。重点：
 * 1. **每条命中都必须带出处**——没有出处不给（读的人无法核对）
 * 2. 不做中文分词：引号内是一个短语，其余按空白/标点切
 * 3. 空查询不返回任何东西（不返回全部块，那不是搜索）
 * 4. 坏块跳过，不让一份坏文档毁掉整个检索
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDoc, searchDocs, snippetOf, termsOf, type IngestedDoc } from "@/lib/market/docs";

const DOC: IngestedDoc = {
  id: "d1",
  title: "茅台研报",
  format: "pdf",
  sourcePath: "/tmp/a.pdf",
  sourceBytes: 1024,
  ingestedAt: "2026-10-15T10:00:00",
  stats: { extractedChars: 84, pages: 1 },
  chunks: [
    { text: "贵州茅台（600519）投资价值分析报告。核心观点：公司毛利率常年维持在 91% 以上，品牌壁垒深厚。", locator: "第 1 页", page: 1 },
    { text: "风险提示：白酒行业景气度下行、消费税政策变化。", locator: "第 2 页", page: 2 },
  ],
};

test("搜索命中并带出处", () => {
  const hits = searchDocs([DOC], "毛利率");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.chunk.locator, "第 1 页");
  assert.equal(hits[0]!.docTitle, "茅台研报");
  assert.deepEqual(hits[0]!.terms, ["毛利率"]);
});

test("多词组：命中越多分越高", () => {
  const hits = searchDocs([DOC], "毛利率 品牌壁垒");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.score >= 2, true);
  const one = searchDocs([DOC], "毛利率");
  assert.ok(hits[0]!.score > one[0]!.score, "两个词组分要高于一个");
});

test("没命中给空数组（不是返回全部）", () => {
  assert.deepEqual(searchDocs([DOC], "不存在的词"), []);
  assert.deepEqual(searchDocs([DOC], "   "), []);
  assert.deepEqual(searchDocs([], "毛利率"), []);
});

test("标题也命中的加分（两份都讲同一个词时挑得准）", () => {
  const other = { ...DOC, id: "d2", title: "五粮液研报", chunks: [{ text: "毛利率也很高。", locator: "第 1 页" }] };
  const hits = searchDocs([DOC, other], "茅台");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.docId, "d1", "「茅台」只在 d1 的标题里");
});

test("引号内是一个短语，不是两个词", () => {
  assert.deepEqual(termsOf('"毛利率 91" 品牌'), ["毛利率 91", "品牌"]);
  assert.deepEqual(termsOf("毛利率，品牌"), ["毛利率", "品牌"]);
  assert.deepEqual(termsOf(""), []);
});

test("坏块跳过，不让一份坏文档毁掉检索", () => {
  const doc = parseDoc({
    id: "d3",
    title: "坏文档",
    chunks: [{ text: "   " }, { text: "" }, { locator: "第 1 页" }, { text: "有效内容", locator: "第 2 页" }],
  });
  assert.ok(doc);
  assert.equal(doc.chunks.length, 1, "空块被丢掉");
  assert.equal(doc.chunks[0]!.locator, "第 2 页");
});

test("每块必须有出处——没有 locator 的给占位（不是丢掉）", () => {
  const doc = parseDoc({ id: "d4", chunks: [{ text: "没有出处的块" }] })!;
  assert.equal(doc.chunks[0]!.locator, "（无出处）");
});

test("结构不对给 null（页面显示没数据）", () => {
  assert.equal(parseDoc(null), null);
  assert.equal(parseDoc({ id: "x" }), null);
  assert.equal(parseDoc({ id: "x", chunks: [] }), null);
  assert.equal(parseDoc({ id: "x", chunks: [{ text: "  " }] }), null, "全是空块也当没数据");
});

test("片段截取围绕命中位置，带省略号", () => {
  const long = "开头".repeat(60) + "关键词在这里出现" + "结尾".repeat(60);
  const snippet = snippetOf({ text: long, locator: "第 1 页" }, ["关键词"]);
  assert.ok(snippet.includes("关键词"));
  assert.ok(snippet.startsWith("…"), "前面被截断要有省略号");
  assert.ok(snippet.length < long.length);
});

test("同分时排序稳定（刷新一次顺序不能变）", () => {
  const a = { ...DOC, id: "a", title: "A", chunks: [{ text: "关键词", locator: "第 9 页" }] };
  const b = { ...DOC, id: "b", title: "B", chunks: [{ text: "关键词", locator: "第 1 页" }] };
  const first = searchDocs([a, b], "关键词").map((h) => h.docId);
  const second = searchDocs([b, a], "关键词").map((h) => h.docId);
  assert.deepEqual(first, second, "输入顺序不能影响结果");
});

test("limit 生效", () => {
  const many = { ...DOC, chunks: Array.from({ length: 50 }, (_, i) => ({ text: `关键词 ${i}`, locator: `第 ${i + 1} 页` })) };
  assert.equal(searchDocs([many], "关键词", 5).length, 5);
});
