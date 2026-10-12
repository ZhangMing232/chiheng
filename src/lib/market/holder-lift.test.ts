import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseHolder, parseHolders, parseLift, upcomingLifts } from "@/lib/market/holder-lift";

describe("parseHolder", () => {
  it("正常行：日期截到日，ratio 是百分比原值", () => {
    const p = parseHolder({ END_DATE: "2026-06-30 00:00:00", HOLDER_NUM: 163327, HOLDER_NUM_RATIO: 8.0984 });
    assert.deepEqual(p, { date: "2026-06-30", num: 163327, chgPct: 8.0984 });
  });

  it("户数缺失/非正 → null；ratio 缺 → null 不拿 0 凑", () => {
    assert.equal(parseHolder({ END_DATE: "2026-06-30", HOLDER_NUM: 0 }), null);
    const p = parseHolder({ END_DATE: "2026-06-30", HOLDER_NUM: 100, HOLDER_NUM_RATIO: null });
    assert.equal(p?.chgPct, null);
  });
});

describe("parseHolders", () => {
  it("按日期新到旧排序", () => {
    const points = parseHolders([
      { END_DATE: "2026-03-31", HOLDER_NUM: 151091 },
      { END_DATE: "2026-06-30", HOLDER_NUM: 163327 },
    ]);
    assert.deepEqual(points.map((p) => p.date), ["2026-06-30", "2026-03-31"]);
  });
});

describe("parseLift", () => {
  it("单位换算：万股→亿股，万元→亿元，比例×100", () => {
    const r = parseLift({
      FREE_DATE: "2026-12-01 00:00:00",
      FREE_SHARES_TYPE: "定向增发机构配售股份",
      FREE_SHARES: 1147905.93,
      LIFT_MARKET_CAP: 1468083.2181,
      FREE_RATIO: 0.102395750906,
    });
    assert.ok(r);
    assert.equal(r.date, "2026-12-01");
    assert.ok(Math.abs(r.sharesYi - 114.79) < 0.01);
    assert.ok(Math.abs(r.capYi - 146.81) < 0.01);
    assert.ok(Math.abs(r.ratioPct - 10.24) < 0.01);
  });

  it("缺日期/缺股数 → null", () => {
    assert.equal(parseLift({ FREE_SHARES: 100 }), null);
    assert.equal(parseLift({ FREE_DATE: "2026-12-01", FREE_SHARES: 0 }), null);
  });
});

describe("upcomingLifts", () => {
  const rows = [
    { date: "2026-10-20", type: "a", sharesYi: 1, capYi: 1, ratioPct: 1 },
    { date: "2025-01-01", type: "b", sharesYi: 1, capYi: 1, ratioPct: 1 },
    { date: "2027-03-01", type: "c", sharesYi: 1, capYi: 1, ratioPct: 1 },
  ];
  it("只要今天起 90 天内的，日期升序", () => {
    const out = upcomingLifts(rows, "2026-10-12");
    assert.deepEqual(out.map((r) => r.date), ["2026-10-20"]);
  });
  it("边界：第 90 天当天算，91 天不算", () => {
    const edge = [
      { date: "2027-01-10", type: "x", sharesYi: 1, capYi: 1, ratioPct: 1 },
      { date: "2027-01-11", type: "y", sharesYi: 1, capYi: 1, ratioPct: 1 },
    ];
    const out = upcomingLifts(edge, "2026-10-12");
    assert.deepEqual(out.map((r) => r.date), ["2027-01-10"]);
  });
});
