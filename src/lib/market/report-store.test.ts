/**
 * 这个文件是干什么的：
 * 钉住报告落盘的三件事——**AI 和规则必须分得清、缺口不许被删、索引能读回来**。
 *
 * 「缺口进报告」那条最重要：一份把缺数据段落删掉的报告，读起来像什么都查到了，
 * 那是伪造。宁可报告里有「这一段缺数据」，也不能让它体面地消失。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listReports, readReport, renderReport, reportId, saveReport } from "@/lib/market/report-store";
import { runResearch } from "@/lib/market/research";
import type { AiSynthesis } from "@/lib/market/research-ai";
import type { Quote } from "@/lib/market/types";

function quote(): Quote {
  return {
    id: "sh600519", code: "600519", name: "贵州茅台", board: "sh", price: 1288, chg: 1.98,
    pe: 19.77, pb: 6.41, cap: 16101, floatCap: 16101, turnover: 0.25, volRatio: 1.03, amp: 2.14,
    d5: 3.55, d10: 1, d20: -3.16, d60: 6.89, ytd: -4.53, inflow: 14850, amount: 404300, st: false,
  };
}

const AI_OK: AiSynthesis = {
  status: "ok",
  text: "当日与短期偏强，中期与年内仍偏弱，估值分位偏低。",
  why: null,
  blocked: 0,
  numbersReplaced: 0,
  refs: ["ev-a", "ev-b"],
  chain: "calc-x aiSynthesis(ev-a, ev-b) = —文本 [ok]",
  ms: 5622,
};

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "chiheng-report-"));
}

const USER_A = "dev-user";
const USER_B = "visitor-2";

test("报告里 AI 说的和规则推的要分得清", () => {
  const report = runResearch({ quote: quote(), articles: [] });
  const md = renderReport(report, AI_OK);
  assert.match(md, /## AI 综合/);
  assert.match(md, /AI（注入调用/, "要写明这是 AI 说的");
  assert.match(md, /当日与短期偏强/, "AI 的原话要进去");
});

test("AI 没出声时，报告必须写明上面全是规则推的", () => {
  const report = runResearch({ quote: quote(), articles: [] });
  const failed: AiSynthesis = { ...AI_OK, status: "failed", text: null, why: "HTTP 503" };
  const md = renderReport(report, failed);
  assert.match(md, /本轮 AI 没有产出/);
  assert.match(md, /HTTP 503/, "原因要具体");
  assert.match(md, /与 AI 无关/, "不许让人误以为有 AI 参与");
});

test("缺口原样进报告，不许被删", () => {
  const report = runResearch({ quote: quote(), articles: [] });
  const md = renderReport(report, null);
  assert.match(md, /缺数据/, "缺口要出现在报告里");
  assert.match(md, /baostock/, "缺口要带补救线索（哪个脚本能补）");
});

test("四档可信度写进报告头部，读者不用翻代码", () => {
  const md = renderReport(runResearch({ quote: quote(), articles: [] }), null);
  assert.match(md, /已披露证实/);
  assert.match(md, /不给买卖建议/, "红线声明要在报告里");
});

test("引用链进报告：算出来的数字能走回原始序列", () => {
  const report = runResearch({ quote: quote(), articles: [] });
  // AI 综合本身也是一条 calculation，它的 chain 要落进文件
  const md = renderReport(report, AI_OK);
  assert.match(md, /calc-x aiSynthesis/, "AI 的引用链要落进文件");
  assert.match(md, /ev-a, ev-b/, "它引用的证据 id 也要在");
});

test("存盘再读回来：索引、内容、id 都对得上", async () => {
  const root = tmp();
  try {
    const report = runResearch({ quote: quote(), articles: [] });
    const { id, path } = await saveReport(report, AI_OK, USER_A, root);
    assert.match(id, /^600519-/);
    const rows = await listReports(USER_A, root);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.id, id);
    assert.equal(rows[0]!.aiStatus, "ok");
    assert.equal(rows[0]!.name, "贵州茅台");
    assert.ok(path.includes(id), "文件名要含 id，找得回来");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("同一只票短时间内两次研判得到不同 id（不互相覆盖）", async () => {
  const root = tmp();
  try {
    const report = runResearch({ quote: quote(), articles: [] });
    const a = await saveReport(report, AI_OK, USER_A, root);
    const b = await saveReport(report, AI_OK, USER_A, root);
    assert.notEqual(a.id, b.id);
    const rows = await listReports(USER_A, root);
    assert.equal(rows.length, 2, "两次都要留下，覆盖写会丢历史");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("每人一份：A 存的报告 B 看不到（列表和原文都查不到）", async () => {
  const root = tmp();
  try {
    const report = runResearch({ quote: quote(), articles: [] });
    const { id } = await saveReport(report, AI_OK, USER_A, root);
    assert.deepEqual(await listReports(USER_B, root), [], "B 的列表是空的");
    assert.equal(await readReport(id, USER_B, root), null, "B 按 id 也读不到 A 的报告");
    assert.equal((await listReports(USER_A, root)).length, 1, "A 的不受影响");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("旧全局报告只迁给主人：顶层 index 和 md 搬进 dev-user，别人是空列表", async () => {
  const root = tmp();
  const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");
  try {
    // 造一份旧全局结构：顶层 index.jsonl + 一份 md
    const legacy = join(root, "data", "reports");
    mkdirSync(legacy, { recursive: true });
    const row = { id: "600519-20261012T000000-abcd", symbol: "600519", name: "贵州茅台", at: "2026-10-12T00:00:00.000Z", aiStatus: "none", gaps: 1, blocked: 0, numbersReplaced: 0 };
    writeFileSync(join(legacy, "index.jsonl"), `${JSON.stringify(row)}\n`, "utf-8");
    writeFileSync(join(legacy, "600519-20261012T000000-abcd.md"), "# 旧报告\n", "utf-8");

    const ownerRows = await listReports(USER_A, root);
    assert.equal(ownerRows.length, 1, "主人继承旧索引");
    assert.equal(ownerRows[0]!.id, row.id);
    assert.ok(!existsSync(join(legacy, "index.jsonl")), "顶层旧索引要搬走");
    const md = await readReport(row.id, USER_A, root);
    assert.match(md ?? "", /旧报告/, "旧 md 也要跟着走");

    assert.deepEqual(await listReports(USER_B, root), [], "别人不从旧文件继承");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("没存过报告时返回空数组，不报错（data 不在 git）", async () => {
  const rows = await listReports(USER_A, tmp());
  assert.deepEqual(rows, []);
});

test("reportId 里不带非法字符（文件名要能落盘）", () => {
  const id = reportId(runResearch({ quote: quote(), articles: [] }), new Date());
  assert.ok(!/[\\/:*?"<>|]/.test(id), `id 含文件系统非法字符：${id}`);
});
