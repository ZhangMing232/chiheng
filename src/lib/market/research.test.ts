/**
 * 这个文件是干什么的：
 * 钉住个股研判流水线的三条底线——缺的不许补、越线的不许出、来源不许空。
 *
 * 最重要的那条是「模板自带红线自查」：赤轨不做投资建议，这条过去只靠写 prompt 的人
 * 自觉。现在流水线自己的产出也要过一次红线，而且由测试证明它过得去——
 * 将来有人加一句「建议关注」，这条测试会先于任何用户看见它之前失败。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  RESEARCH_TIERS,
  STAGE_IDS,
  runResearch,
  type Evidence,
  type ResearchInput,
} from "@/lib/market/research";
import type { Quote } from "@/lib/market/types";
import type { StockArticle } from "@/lib/market/news";
import { screenAdvice } from "@/lib/market/red-line";
import { valuationPosition } from "@/lib/market/pe-history";

/** 一只正常票。要判断缺口就把对应字段置 null 覆盖。 */
function quote(over: Partial<Quote> = {}): Quote {
  return {
    id: "sh600519",
    code: "600519",
    name: "贵州茅台",
    board: "sh",
    price: 1500,
    chg: 1.2,
    pe: 22.5,
    pb: 7.8,
    cap: 18_800,
    floatCap: 18_800,
    turnover: 0.35,
    volRatio: 1.1,
    amp: 1.8,
    d5: 1,
    d10: 2,
    d20: -3,
    d60: 5,
    ytd: 8,
    inflow: 12_000,
    amount: 300_000,
    st: false,
    ...over,
  };
}

function article(over: Partial<StockArticle> = {}): StockArticle {
  return {
    id: "a1",
    time: "2026-10-10 09:30",
    title: "关于召开临时股东大会的通知",
    tone: "flat",
    url: "http://example.com/a1",
    kind: "ann",
    ...over,
  };
}

test("六阶段顺序固定，每阶段都带问题", () => {
  const report = runResearch({ quote: quote(), articles: [] });
  assert.deepEqual(report.stages.map((s) => s.id), [...STAGE_IDS]);
  for (const stage of report.stages) {
    assert.ok(stage.question.length > 0, `${stage.id} 没有写「这一阶段回答什么」`);
    assert.equal(stage.question.endsWith("？"), true, `${stage.id} 的问题要以问号收尾`);
  }
});

test("模板自带红线自查：自己写的结论一个都不许越线", () => {
  const report = runResearch({ quote: quote(), articles: [article()] });
  assert.equal(report.blocked, 0, "流水线模板自己越线了，说明写文案的人该改，不是放行");
  for (const stage of report.stages) {
    for (const finding of stage.findings) {
      const res = screenAdvice(finding.text);
      assert.equal(res.ok, true, `${stage.id} 的结论命中红线：${res.hits.join("；")}`);
    }
  }
});

test("没有行情时每阶段都写缺口，不许补数字", () => {
  const report = runResearch({ quote: null, articles: [] });
  for (const stage of report.stages) {
    assert.ok(stage.gaps.length > 0, `${stage.id} 没行情却没说缺什么`);
    assert.equal(stage.evidence.length, 0, `${stage.id} 没行情还摆出了证据`);
  }
  assert.ok(report.gaps.length > 0, "顶层要写明「什么都查不到」");
});

test("新浪源降级拿不到 d 系列涨幅：写成缺口，不是 0%", () => {
  const report = runResearch({ quote: quote({ d5: null, d20: null, d60: null, ytd: null }), articles: [] });
  const price = report.stages.find((s) => s.id === "price")!;
  assert.ok(price.gaps.some((g) => g.includes("涨幅缺失")), "缺失必须显式列出来");
  for (const row of price.evidence) {
    assert.ok(!row.value.startsWith("+0.00%"), "拿不到的数不许显示成 0%");
    assert.ok(row.value !== "null", "NaN/null 不许进页面");
  }
});

test("每条证据都要有来源，不许写「内部数据」这种找不到人的话", () => {
  const report = runResearch({ quote: quote(), articles: [article()] });
  for (const stage of report.stages) {
    for (const ev of stage.evidence as Evidence[]) {
      assert.ok(ev.source.length > 0, `${stage.id} 的「${ev.label}」没有写来源`);
      assert.ok(!/内部|公开数据/.test(ev.source), "来源要具体到接口/文件名");
    }
  }
});

test("没有 PE/PB 时写缺口，不用 0 倍冒充便宜", () => {
  const report = runResearch({ quote: quote({ pe: null, pb: null }), articles: [] });
  const val = report.stages.find((s) => s.id === "valuation")!;
  assert.ok(val.gaps.some((g) => g.includes("市盈率")));
  assert.ok(val.gaps.some((g) => g.includes("市净率")));
  assert.equal(val.evidence.length, 0);
});

test("缺历史 PE 分位这件事必须说出口（没跑过脚本时）", () => {
  const report = runResearch({ quote: quote(), articles: [] });
  const val = report.stages.find((s) => s.id === "valuation")!;
  assert.ok(val.gaps.some((g) => g.includes("历史 PE 分位")), "没跑过脚本就明说，别让读者以为算过了");
});

test("有 baostock 序列时给真分位，不再写那条缺口", () => {
  // 60 个递增点：最新的最贵 → 高分位
  const series = Array.from({ length: 60 }, (_, i) => ({
    date: `d${i}`, close: 10 + i, peTTM: i + 1, pbMRQ: (i + 1) / 10, psTTM: 1, turn: 1, isST: false,
  }));
  const valuation = valuationPosition({
    code: "600519", symbol: "sh.600519", source: "baostock", adjust: "none",
    fetchedAt: "2026-10-12", window: { from: "2021-10-12", to: "2026-10-12" },
    counts: { raw: 60, traded: 60, halted: 0 }, series,
  });
  const report = runResearch({ quote: quote(), articles: [], valuation });
  const val = report.stages.find((s) => s.id === "valuation")!;
  assert.ok(!val.gaps.some((g) => g.includes("历史 PE 分位")), "有数据了就不能还说缺");
  assert.ok(val.evidence.some((e) => e.label.includes("PE_TTM 历史位置")), "要摆出历史位置");
  assert.ok(val.evidence.some((e) => e.source.includes("baostock")), "来源要写到具体源");
  assert.equal(report.blocked, 0, "新增的结论也不许越线");
});

test("没有资讯时催化剂阶段是空的，但不冒充「没有催化剂」", () => {
  const report = runResearch({ quote: quote(), articles: [] });
  const cat = report.stages.find((s) => s.id === "catalyst")!;
  assert.ok(cat.gaps.some((g) => g.includes("资讯或公告")));
  assert.equal(cat.evidence.length, 0);
});

test("利好利空机器分档必须标「未核实线索」，不许标已证实", () => {
  const report = runResearch({
    quote: quote(),
    articles: [article({ tone: "good", title: "签了大单" }), article({ id: "a2", tone: "bad", title: "业绩下滑" })],
  });
  const cat = report.stages.find((s) => s.id === "catalyst")!;
  assert.ok(cat.findings.length > 0);
  for (const f of cat.findings) assert.equal(f.tier, "未核实线索", "标题用词分档是机器猜的，必须落在未核实那一档");
});

test("裁决点只给观察条件，不许给动作", () => {
  const report = runResearch({ quote: quote(), articles: [] });
  const verdict = report.stages.find((s) => s.id === "verdict")!;
  for (const f of verdict.findings) {
    const res = screenAdvice(f.text);
    assert.equal(res.ok, true, `裁决点越线了：${res.hits.join("；")}`);
    assert.ok(!/(建议|可以买入|应当|加仓|减仓|止损设在)/.test(f.text));
  }
});

test("四档可信度沿用那一组词，不许退回高/中/低", () => {
  assert.deepEqual([...RESEARCH_TIERS], ["已披露证实", "有依据的推断", "未核实线索", "被反证"]);
  const report = runResearch({ quote: quote(), articles: [article()] });
  for (const stage of report.stages) {
    for (const f of stage.findings) {
      assert.ok(RESEARCH_TIERS.includes(f.tier), `${stage.id} 用了词典外的档位：${f.tier}`);
    }
  }
});
