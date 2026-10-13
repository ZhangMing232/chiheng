/**
 * 这个文件是干什么的：
 * 钉住知识档案的两条命——**旧结论不当事实、核对不了就说核对不了**。
 *
 * 「旧结论不当事实」最容易犯：AI 拿到旧档案会顺手把上次的结论复述成事实，
 * 而那条结论可能已经被实时数据推翻。档案只能是「待验证项」。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkOldPoints, knowledgePrompt, knowledgeSummary, type KnowledgeFile } from "@/lib/market/knowledge";
import { decisionPointsFrom } from "@/lib/market/catalyst-sop";
import { runResearch } from "@/lib/market/research";
import { loadKnowledge, saveKnowledge } from "@/lib/market/knowledge-store";
import type { Quote } from "@/lib/market/types";

function quote(over: Partial<Quote> = {}): Quote {
  return {
    id: "sh600519", code: "600519", name: "贵州茅台", board: "sh", price: 1288, chg: 1.98,
    pe: 19.77, pb: 6.41, cap: 16101, floatCap: 16101, turnover: 0.25, volRatio: 1.03, amp: 2.14,
    d5: 3.55, d10: 1, d20: -3.16, d60: 6.89, ytd: -4.53, inflow: 14850, amount: 404300, st: false,
    ...over,
  };
}

function file(over: Partial<KnowledgeFile> = {}): KnowledgeFile {
  return {
    symbol: "600519", name: "贵州茅台", savedAt: "2026-10-12T20:00:00.000Z", reportId: "600519-x",
    conclusions: ["PE 与 PB 都处在自身历史的低分位"], points: [], snapshot: { d20: -3.16, peRank: 8, pbRank: 11 },
    ...over,
  };
}

test("d20 掉头 → 上次的预警标「已应验」", () => {
  const old = file({ points: [{ object: "近 20 日涨幅方向", threshold: "穿越 0", source: "行情", nextAt: "每日", effect: "失效", from: "price" }] });
  const checks = checkOldPoints(old, quote({ d20: 2.5 }), null);
  assert.equal(checks[0]!.status, "triggered");
  assert.match(checks[0]!.detail, /方向确实变了/);
});

test("d20 没掉头 → 「未触发，继续盯」", () => {
  const old = file({ points: [{ object: "近 20 日涨幅方向", threshold: "穿越 0", source: "行情", nextAt: "每日", effect: "失效", from: "price" }] });
  const checks = checkOldPoints(old, quote({ d20: -4.0 }), null);
  assert.equal(checks[0]!.status, "watching");
  assert.match(checks[0]!.detail, /还没掉头/);
});

test("分位档位切换 → 已应验", () => {
  const old = file({ points: [{ object: "PE/PB 历史分位", threshold: "穿档", source: "baostock", nextAt: "财报日", effect: "切换", from: "valuation" }] });
  const checks = checkOldPoints(old, null, { points: 728, peRank: 85, pbRank: 88, window: { from: "a", to: "b" } } as never);
  assert.equal(checks[0]!.status, "triggered");
  assert.match(checks[0]!.detail, /low 档，这次在 high 档/);
});

test("核对不了的明说缺什么，不许猜", () => {
  const old = file({ points: [{ object: "主力净流入", threshold: "连续 3 日同向", source: "行情", nextAt: "每日", effect: "失效", from: "capital" }] });
  const checks = checkOldPoints(old, quote(), null);
  assert.equal(checks[0]!.status, "cannot-check");
  assert.match(checks[0]!.detail, /逐日核对/);
});

test("prompt 段写死「旧结论不许当事实」", () => {
  const p = knowledgePrompt(file(), []);
  assert.match(p, /旧结论不许当事实引用/);
  assert.match(p, /待验证项/);
});

test("落盘再读回来：档案一致", async () => {
  const root = mkdtempSync(join(tmpdir(), "chiheng-know-"));
  try {
    const f = file();
    await saveKnowledge(f, root);
    const back = await loadKnowledge("600519", root);
    assert.equal(back?.symbol, "600519");
    assert.equal(back?.conclusions.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("没归档过 → 读回 null（不是报错）", async () => {
  const back = await loadKnowledge("sz000001", mkdtempSync(join(tmpdir(), "chiheng-know-empty-")));
  assert.equal(back, null);
});

test("摘要一行说得清有几个待验证预警", () => {
  const s = knowledgeSummary(file({ points: [{}, {}, {}] as never }));
  assert.match(s, /3 个待验证预警/);
});

test("从真报告生成的裁决点能直接进档案（链路通）", () => {
  const report = runResearch({ quote: quote(), articles: [] });
  const points = decisionPointsFrom(report.stages.filter((s) => s.id !== "verdict"));
  assert.ok(points.length >= 3, "档案里的预警不能少于 3 个");
});
