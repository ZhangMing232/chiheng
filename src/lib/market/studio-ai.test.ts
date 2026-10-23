/**
 * 这个文件是干什么的：
 * 钉住 AI 海报管线的两条底线——
 * 1. buildVersusBrief：真实数据整理成数据块 + facts，facts 必须覆盖所有
 *    会被画进图里的数字/名称（校验器就靠它逐字比对）。
 * 2. validatePosterSVG：缺字、NaN/undefined、缺免责语都必须逮住——
 *    AI 手滑改了一个数字，图就宁可不出（回退模板），不给读者看假数。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildVersusBrief, moneyOf, validatePosterSVG, type VersusKind } from "@/lib/market/studio-ai";
import type { FlowBook } from "@/lib/market/flow";

const BOOK: FlowBook = {
  stocksIn: [
    { id: "1", name: "中际旭创", chg: 3.82, inflow: 162_000, leader: "" },
    { id: "2", name: "兆易创新", chg: 5.5, inflow: 128_000.4, leader: "" },
  ],
  stocksOut: [
    { id: "3", name: "交通银行", chg: -1.95, inflow: -57_000, leader: "" },
    { id: "4", name: "长江电力", chg: null, inflow: -56_000, leader: "" },
  ],
  sectorsIn: [{ id: "s1", name: "CPO", chg: 4, inflow: 800_000, leader: "中际旭创" }],
  sectorsOut: [{ id: "s2", name: "银行", chg: -2, inflow: -300_000, leader: "交通银行" }],
  north: [{ name: "沪股通", date: "10-23", amount: 9_000_000, leader: "" }],
  market: [
    { name: "沪市", main: 1_200_000, super: 0, big: 0, mid: 0, small: 0, retail: 0 },
    { name: "深市", main: -600_000, super: 0, big: 0, mid: 0, small: 0, retail: 0 },
  ],
  tape: [],
  asOf: Date.now(),
};

test("moneyOf：万以上用亿（一位小数），以下用万", () => {
  assert.equal(moneyOf(162_000), "16.2亿");
  assert.equal(moneyOf(-57_000), "5.7亿");
  assert.equal(moneyOf(5_400), "5400万");
});

test("buildVersusBrief：数据块含双边榜单/板块/两市/北向，facts 覆盖名称和金额", () => {
  const brief = buildVersusBrief(BOOK, "stock");
  assert.match(brief.prompt, /中际旭创/);
  assert.match(brief.prompt, /净流出 5.7亿/);
  assert.match(brief.prompt, /沪市主力净流入 120.0亿/);
  assert.match(brief.prompt, /板块流入 CPO 80.0亿（领涨 中际旭创）/);
  assert.match(brief.prompt, /沪股通成交 900.0亿/);
  assert.match(brief.prompt, /内容必须纵向占满画幅 88%/);
  for (const fact of ["中际旭创", "16.2亿", "交通银行", "5.7亿", "数据不构成投资建议", brief.dateLine]) {
    assert.ok(brief.facts.includes(fact), `facts 缺 ${fact}`);
  }
  // 涨跌幅有值的在 facts 里（校验要逐字查，带符号 +3.82%），null 的不在
  assert.ok(brief.facts.includes("+3.82%"));
  assert.ok(!brief.facts.includes("null"));
});

test("buildVersusBrief：kind=sector 用板块榜，不带板块补充条", () => {
  const brief = buildVersusBrief(BOOK, "sector");
  assert.match(brief.prompt, /板块主力净流入/);
  assert.match(brief.prompt, /CPO/);
  assert.ok(!/板块资金补充/.test(brief.prompt));
});

const GOOD_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920"><text>中际旭创 净流入 16.2亿 3.82%</text><text>数据不构成投资建议 · 赤轨</text></svg>`;

test("validatePosterSVG：齐全且健康 → ok", () => {
  const v = validatePosterSVG(GOOD_SVG, ["中际旭创", "16.2亿", "3.82%", "数据不构成投资建议"]);
  assert.equal(v.ok, true);
  assert.deepEqual(v.missing, []);
  assert.deepEqual(v.issues, []);
});

test("validatePosterSVG：AI 改了数字（缺字）→ 逮住", () => {
  const v = validatePosterSVG(GOOD_SVG, ["中际旭创", "16.2亿", "5.9亿", "数据不构成投资建议"]);
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ["5.9亿"]);
});test("validatePosterSVG：NaN / undefined / 缺免责语 / 非 SVG → 全部逮住", () => {
  const nan = validatePosterSVG(`<svg>NaN万 数据不构成投资建议</svg>`, ["数据不构成投资建议"]);
  assert.equal(nan.ok, false);
  assert.ok(nan.issues.some((i) => i.includes("NaN")));

  const undef = validatePosterSVG(`<svg>undefined 数据不构成投资建议</svg>`, ["数据不构成投资建议"]);
  assert.equal(undef.ok, false);

  const noDisclaim = validatePosterSVG(`<svg><text>中际旭创</text></svg>`, ["中际旭创", "数据不构成投资建议"]);
  assert.equal(noDisclaim.ok, false);
  assert.ok(noDisclaim.missing.includes("数据不构成投资建议"));

  const notSvg = validatePosterSVG("抱歉我无法输出", ["数据不构成投资建议"]);
  assert.equal(notSvg.ok, false);
  assert.ok(notSvg.issues.some((i) => i.includes("完整 SVG")));
});
