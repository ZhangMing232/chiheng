/**
 * 这个文件是干什么的：
 * 钉住一致预期聚合——**同机构取最新、机构数门槛、分歧要标、CAGR 分母是预测**。
 *
 * 「同机构取最新」最容易漏：一个券商年内发三份研报（上调两次），全算进去等于
 * 把过期预测和新的混在一起，一致预期被旧预测拉偏。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { aggregateConsensus, latestPerInstitution, type ConsensusReport } from "@/lib/market/consensus";

function rep(over: Partial<ConsensusReport> = {}): ConsensusReport {
  return {
    orgName: "机构A", publishDate: "2026-10-01", rating: "买入",
    thisYearEps: 65, nextYearEps: 70, nextTwoYearEps: 74,
    thisYearPe: 20, nextYearPe: 18, nextTwoYearPe: 17,
    ...over,
  };
}

test("同机构取最新一份，旧预测不混入", () => {
  const rows = [
    rep({ orgName: "机构A", publishDate: "2026-01-01", thisYearEps: 60 }),
    rep({ orgName: "机构A", publishDate: "2026-06-01", thisYearEps: 68 }),
    rep({ orgName: "机构B", publishDate: "2026-05-01", thisYearEps: 70 }),
  ];
  const latest = latestPerInstitution(rows);
  assert.equal(latest.length, 2);
  assert.ok(latest.every((r) => r.publishDate >= "2026-05-01"), "每家只留最新一份");
});

test("机构数 ≥ 3 才可信，少于 3 要标不可靠", () => {
  const two = aggregateConsensus([rep({ orgName: "A" }), rep({ orgName: "B" })]);
  assert.equal(two.nInstitutions, 2);
  assert.equal(two.reliable, false);
  assert.ok(two.gaps.some((g) => g.includes("不可靠")));

  const three = aggregateConsensus([rep({ orgName: "A" }), rep({ orgName: "B" }), rep({ orgName: "C" })]);
  assert.equal(three.reliable, true);
});

test("一致预期 EPS 是各机构均值", () => {
  const r = aggregateConsensus([
    rep({ orgName: "A", thisYearEps: 60 }),
    rep({ orgName: "B", thisYearEps: 70 }),
  ]);
  assert.equal(r.epsThisYear, 65);
});

test("前瞻 CAGR = 明年 ÷ 今年 − 1", () => {
  const r = aggregateConsensus([
    rep({ orgName: "A", thisYearEps: 65, nextYearEps: 71.5 }),
    rep({ orgName: "B", thisYearEps: 65, nextYearEps: 71.5 }),
  ]);
  assert.ok(Math.abs((r.forwardCagr as number) - 0.1) < 1e-9, `实际 ${r.forwardCagr}`);
});

test("分歧 ≥ 2 倍要标出来，别看均值", () => {
  const r = aggregateConsensus([
    rep({ orgName: "A", thisYearEps: 40 }),
    rep({ orgName: "B", thisYearEps: 60 }),
    rep({ orgName: "C", thisYearEps: 80 }),
  ]);
  assert.equal(r.dispersion, 2);
  assert.ok(r.gaps.some((g) => g.includes("分歧")), "max/min = 2 倍必须明说");
});

test("没有预测数据 → 写缺口", () => {
  const r = aggregateConsensus([]);
  assert.equal(r.nInstitutions, 0);
  assert.match(r.gaps[0]!, /机构预测/);
});

test("EPS 缺失时 CAGR 算不出，但别给假值", () => {
  const r = aggregateConsensus([rep({ orgName: "A", nextYearEps: null })]);
  assert.equal(r.forwardCagr, null, "缺分子就不算，不硬凑");
});
