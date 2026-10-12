/**
 * 这个文件是干什么的：
 * 钉住财报拆解——**累计值拆单季要连续、杜邦要对得上、不够期就写缺口不硬算**。
 *
 * 「杜邦对不上」是最容易被忽略的：三因子乘积和 ROE 差太远，说明数据源内部
 * 不一致，硬用就是拿错数字下结论。这类必须显式标出来。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  dupontCheck,
  latestYoy,
  quarterize,
  readFinancials,
  sortByStatDate,
  ttmNetProfit,
  type FinancialRow,
} from "@/lib/market/financials";

function row(over: Partial<FinancialRow> = {}): FinancialRow {
  return {
    pubDate: "2026-08-15", statDate: "2026-06-30",
    netProfit: 460, revenue: 920, roe: 0.18, gpMargin: 0.89, npMargin: 0.51,
    epsTTM: 65, debt: 0.15, cfoToNp: 1.54,
    dupontROE: 0.18, assetTurn: 0.30, assetToEquity: 1.24, nitogr: 0.50,
    ...over,
  };
}

/** 造连续 N 季的累计值序列：单季净利润固定 100，营收固定 200。**每年 Q1 重置累计**（真实 A 股语义）。 */
function series(n: number, singleProfit = 100): FinancialRow[] {
  return Array.from({ length: n }, (_, i) => {
    const q = (i % 4) + 1; // 当年第几季
    const y = 2024 + Math.floor(i / 4);
    const m = q * 3;
    const statDate = `${y}-${String(m).padStart(2, "0")}-${m === 3 ? "31" : m === 6 ? "30" : m === 9 ? "30" : "31"}`;
    return row({ statDate, pubDate: statDate, netProfit: singleProfit * q, revenue: 200 * q });
  });
}

test("quarterize：累计值拆单季，第 1 期即单季，之后是差值", () => {
  const rows = series(3, 100); // 累计 100/200/300 → 单季 100/100/100
  const q = quarterize(rows);
  assert.deepEqual(q.map((x) => x.netProfit), [100, 100, 100]);
});

test("sortByStatDate：按报告期升序，不按公告日期", () => {
  const rows = [row({ statDate: "2026-06-30" }), row({ statDate: "2026-03-31" })];
  assert.deepEqual(sortByStatDate(rows).map((r) => r.statDate), ["2026-03-31", "2026-06-30"]);
});

test("TTM：近 4 个单季之和，不够 4 季返回 null 不拿 3 季凑", () => {
  assert.equal(ttmNetProfit(quarterize(series(4, 100))), 400);
  assert.equal(ttmNetProfit(quarterize(series(3, 100))), null, "3 季凑不出 TTM");
});

test("单季同比：最新单季 ÷ 去年同期 − 1", () => {
  // 单季净利润 100,200,...,800 → 累计 100,300,600,...,3600
  // 最新单季 800 ÷ 去年同期(第5季) 400 − 1 = 1.0
  const single = [100, 200, 300, 400, 500, 600, 700, 800];
  const rows = single.map((sp, i) => row({
    statDate: `${2024 + Math.floor(i / 4)}-${String(((i % 4) * 3 + 3)).padStart(2, "0")}-${((i % 4) * 3 + 3) % 2 ? "30" : "31"}`,
    netProfit: single.slice(0, i + 1).reduce((a, b) => a + b, 0),
  }));
  const yoy = latestYoy(quarterize(rows));
  assert.ok(Math.abs((yoy as number) - 1.0) < 1e-9, `实际 ${yoy}`);
});

test("杜邦一致性：三因子乘积 ≈ ROE 时 ok；对不上时标 drift", () => {
  // nitogr 0.50 × assetTurn 0.30 × assetToEquity 1.20 = 0.18 = ROE
  const ok = dupontCheck(row({ dupontROE: 0.18, nitogr: 0.50, assetTurn: 0.30, assetToEquity: 1.20 }));
  assert.equal(ok!.ok, true);
  assert.ok(ok!.drift! < 0.01);

  const bad = dupontCheck(row({ dupontROE: 0.18, nitogr: 0.50, assetTurn: 0.30, assetToEquity: 3.0 }));
  assert.equal(bad!.ok, false, "乘积 0.45 对 ROE 0.18，差太远要标出来");
  assert.ok(bad!.drift! > 0.5);
});

test("readFinancials：完整 8 季能给出 TTM 和同比", () => {
  const r = readFinancials(series(8, 100));
  assert.equal(r.ttmNetProfit, 400);
  assert.ok(r.latestYoy != null);
  assert.ok(r.gaps.length === 0, `连续数据不该有缺口，实际 ${r.gaps.join("；")}`);
});

test("readFinancials：报告期不连续要写缺口（拆错比不拆糟）", () => {
  // 缺 Q3：H1 之后直接跳到全年
  const rows = [series(2), row({ statDate: "2025-12-31", netProfit: 400 })].flat();
  const r = readFinancials(rows);
  assert.ok(r.gaps.some((g) => g.includes("不是连续季度")), "要显式说拆解可能不准");
});

test("readFinancials：经营现金流/净利润 < 1 要标利润质量待查", () => {
  const rows = series(4, 100).map((r, i) => (i === 3 ? { ...r, cfoToNp: 0.6 } : r));
  const r = readFinancials(rows);
  assert.ok(r.gaps.some((g) => g.includes("利润质量")), "现金流跟不上利润必须说");
});

test("没有数据 → 写缺口并说明怎么补", () => {
  const r = readFinancials([]);
  assert.match(r.gaps[0]!, /fetch-three-sheets/);
});

test("回归：累计值每年 Q1 重置，跨年不能直接相减", () => {
  // 2025 全年累计 100→250→400→500，2026 Q1 重置为 120，H1 为 280
  const rows = [
    row({ statDate: "2025-03-31", netProfit: 100 }),
    row({ statDate: "2025-06-30", netProfit: 250 }),
    row({ statDate: "2025-09-30", netProfit: 400 }),
    row({ statDate: "2025-12-31", netProfit: 500 }),
    row({ statDate: "2026-03-31", netProfit: 120 }),
    row({ statDate: "2026-06-30", netProfit: 280 }),
  ];
  const q = quarterize(rows);
  // 单季应是 100 / 150 / 150 / 100 / 120 / 160
  assert.deepEqual(q.map((x) => x.netProfit), [100, 150, 150, 100, 120, 160], "跨年 Q1 必须重新从自身算起");
});
