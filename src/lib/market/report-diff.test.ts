/**
 * 这个文件是干什么的：
 * 钉住报告对比的底线——**哈希编号去了、行内 id 不去、表格分隔行不算内容、
 * 章节增删要说得出**。
 *
 * 学 Vibe-Research 的 reportDiff，但 id 口径是赤轨的：哈希 id（ev-xxxx，
 * base36 内容哈希）每次可能变，必须去；行内 id（ev-身份-收盘价）由阶段+
 * 标签决定、跨次稳定，留着帮助对齐。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { diffLines, diffReports, displayLine, lineKey, splitSections, stripIds } from "@/lib/market/report-diff";

const MD_V1 = [
  "# [600519-20261001T090000-aaaa] 个股研判 · 贵州茅台（600519）",
  "",
  "> 本报告只给数据、分析框架、情景概率和裁决点，**不给买卖建议**。",
  "",
  "## 身份",
  "",
  "**这一阶段回答**：这是谁",
  "",
  "| 项 | 值 | 来源 | 档位 |",
  "|---|---|---|---|",
  "| 收盘价 | 1288 | 行情快照 | 已披露证实 |",
  "",
  "## AI 综合",
  "",
  "当日与短期偏强(ev-身份-收盘价)。",
  "",
  "- 引用链：`calc-abc123 aiSynthesis(ev-身份-收盘价) = —文本 [ok]`",
  "",
].join("\n");

test("stripIds：哈希 id 去掉，行内 id（含中文标签）保留", () => {
  assert.equal(stripIds("结论 calc-abc123 成立"), "结论 成立");
  assert.equal(stripIds("结论(ev-a1b2c3)成立"), "结论()成立".replace("()", ""), "括号里只剩编号时整段收拾掉");
  assert.equal(stripIds("低位(ev-身份-收盘价)"), "低位(ev-身份-收盘价)", "行内稳定 id 不去");
  assert.equal(stripIds("引用 [ev-x] / [calc-yz] 两条"), "引用 两条", "连着写的编号当一个整体去");
});

test("splitSections：标题与引言不进章节，## 开头才算", () => {
  const secs = splitSections(MD_V1);
  assert.deepEqual(secs.map((s) => s.title), ["身份", "AI 综合"]);
  assert.ok(secs[0]!.lines.some((l) => l.includes("这是谁")));
});

test("lineKey：表格分隔行不算内容", () => {
  assert.equal(lineKey("|---|---|---|"), "");
  assert.equal(lineKey("| 收盘价 | 1288 | 行情快照 |"), "|收盘价|1288|行情快照|");
});

test("displayLine：表格行拆成 格 · 格，去加粗", () => {
  assert.equal(displayLine("| **PE** | 19.77 倍 |"), "PE · 19.77 倍");
});

test("diffLines：没变的行不产生 op，变了的一 add 一 del", () => {
  const a = ["- 收盘价 1288", "- PE 19.77"];
  const b = ["- 收盘价 1301", "- PE 19.77"];
  const ops = diffLines(a, b);
  assert.deepEqual(ops.map((o) => o.op), ["del", "add"]);
  assert.match(ops[0]!.text, /1288/);
  assert.match(ops[1]!.text, /1301/);
});

test("diffLines：只有编号变了的行不算改（去哈希 id 后相同）", () => {
  const a = ["- 引用链：`calc-abc aiSynthesis(ev-x) = —文本 [ok]`"];
  const b = ["- 引用链：`calc-def aiSynthesis(ev-y) = —文本 [ok]`"];
  assert.deepEqual(diffLines(a, b), [], "整条只有哈希 id 不同 → 视为没变");
});

test("diffReports：章节增删说得出，未变的章节标 same", () => {
  const next = MD_V1.replace("## AI 综合", "## 估值锚").replace("当日与短期偏强", "估值处于低分位");
  const diffs = diffReports(MD_V1, next);
  const byTitle = new Map(diffs.map((d) => [d.title, d]));
  assert.equal(byTitle.get("身份")?.status, "same", "内容没动的章节是 same");
  const ai = byTitle.get("AI 综合");
  assert.equal(ai?.status, "removed", "新版没有的章节标 removed");
  assert.equal(byTitle.get("估值锚")?.status, "added");
  assert.ok(diffs.indexOf(byTitle.get("AI 综合")!) > diffs.indexOf(byTitle.get("估值锚")!), "removed 的放最后");
});

test("diffReports：同一章节里的内容变化是 changed，增删行数对得上", () => {
  const next = MD_V1.replace("| 收盘价 | 1288 | 行情快照 | 已披露证实 |", "| 收盘价 | 1301 | 行情快照 | 已披露证实 |");
  const diffs = diffReports(MD_V1, next);
  const idSection = diffs.find((d) => d.title === "身份");
  assert.equal(idSection?.status, "changed");
  assert.equal(idSection?.added, 1);
  assert.equal(idSection?.removed, 1);
  assert.match(idSection!.ops.find((o) => o.op === "del")!.text, /1288/);
  assert.match(idSection!.ops.find((o) => o.op === "add")!.text, /1301/);
});
