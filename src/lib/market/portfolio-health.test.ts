/**
 * 这个文件是干什么的：
 * 守住持仓体检的六条规则：只数、集中度、行业暴露、报价缺失、估值分位、连亏。
 *
 * 你需要知道的：
 * 每条测试都显式给 priceOf / industryNameOf / peRankOf / dayNet——体检函数
 * 本身零 I/O，输入缺什么就跳过什么，测试要覆盖「缺输入时降级」这条行为，
 * 不然线上数据缺口会变成静默的「体检全绿」。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { healthChecks, type HealthInput } from "@/lib/market/portfolio-health";

/** 一行持仓：默认未平仓、有现价。 */
function open(id: string, price = 10): { id: string; name: string; exit: number | null } {
  return { id, name: id.toUpperCase(), exit: null };
}

function input(patch: Partial<HealthInput> & Pick<HealthInput, "rows">): HealthInput {
  return { priceOf: () => 10, ...patch };
}

test("空仓：只返回一条「无持仓」，不跑其余检查", () => {
  const checks = healthChecks(input({ rows: [] }));
  assert.equal(checks.length, 1);
  assert.equal(checks[0].title, "无持仓");
  assert.equal(checks[0].level, "info");
});

test("单票名义占比 45%：出集中度 warn（阈值 40%）", () => {
  // A 现价 45（名义 4500），其余 9 只现价 10（名义 1000）：4500/13500 = 33%？不够——
  // 用 4 只：A 名义 4500，其余三只各 1000，top1 = 4500/7500 = 60%。
  const rows = [open("a"), open("b"), open("c"), open("d")];
  const priceOf = (id: string) => (id === "a" ? 45 : 10);
  const checks = healthChecks(input({ rows, priceOf }));
  const hit = checks.find((check) => check.title === "单票集中度过高");
  assert.ok(hit, JSON.stringify(checks));
  assert.equal(hit.level, "warn");
  assert.match(hit.detail, /60\.0%/);
});

test("top3 合计超 70%：出前三集中度 warn，与单票检查互不误报", () => {
  // 4 只：a 26、b 25、c 24、d 10（名义金额同价，占比即价格占比）：top1 26%（info 档）、
  // top3 75%（warn 档）。
  const rows = [open("a"), open("b"), open("c"), open("d")];
  const priceOf = (id: string) => ({ a: 26, b: 25, c: 24, d: 10 })[id] ?? 10;
  const checks = healthChecks(input({ rows, priceOf }));
  const top3 = checks.find((check) => check.title === "前三票集中度过高");
  assert.ok(top3, JSON.stringify(checks));
  assert.equal(top3.level, "warn");
  const top1 = checks.find((check) => check.title === "单票集中度偏高");
  assert.ok(top1, JSON.stringify(checks));
  assert.equal(top1.level, "info");
});

test("同一行业名义占比 60%：出行业 warn，detail 带行业名和占比", () => {
  const rows = [open("a"), open("b"), open("c"), open("d")];
  const priceOf = (id: string) => (id === "a" || id === "b" || id === "c" ? 20 : 10);
  const industryNameOf = (id: string) => (id === "a" || id === "b" || id === "c" ? "白酒" : "银行");
  const checks = healthChecks(input({ rows, priceOf, industryNameOf }));
  const hit = checks.find((check) => check.title === "行业暴露集中");
  assert.ok(hit, JSON.stringify(checks));
  assert.equal(hit.level, "warn");
  assert.match(hit.detail, /白酒/);
  // 三只各 2000、一只 1000：6000/7000 ≈ 85.7%
  assert.match(hit.detail, /85\.7%/);
});

test("3 只持仓 2 只拿不到现价：出行情缺口 warn，缺口票按 0 计入占比", () => {
  const rows = [open("a"), open("b"), open("c")];
  const priceOf = (id: string) => (id === "a" ? 10 : null);
  const checks = healthChecks(input({ rows, priceOf }));
  const hit = checks.find((check) => check.title === "行情数据缺口");
  assert.ok(hit, JSON.stringify(checks));
  assert.equal(hit.level, "warn");
  assert.match(hit.detail, /2\/3/);
});

test("3 只 PE 分位 ≥80：出高估值 warn，列出票名；措辞中性（不写买卖建议）", () => {
  const rows = [open("a"), open("b"), open("c")];
  const peRankOf = () => 82;
  const checks = healthChecks(input({ rows, peRankOf }));
  const hit = checks.find((check) => check.title === "高估值分位的票偏多");
  assert.ok(hit, JSON.stringify(checks));
  assert.equal(hit.level, "warn");
  assert.match(hit.detail, /A/);
  assert.doesNotMatch(hit.detail, /建议卖出|应该卖/);
});

test("连亏 4 个开仓日：出连亏 warn；断在最后一天不算", () => {
  const rows = [open("a")];
  const checks = healthChecks(input({ rows, dayNet: [0.01, -0.02, -0.01, -0.03, -0.01] }));
  const hit = checks.find((check) => check.title === "连亏");
  assert.ok(hit, JSON.stringify(checks));
  assert.equal(hit.level, "warn");
  assert.match(hit.detail, /4 个开仓日/);

  const okChecks = healthChecks(input({ rows, dayNet: [-0.01, 0.02, -0.01, -0.01] }));
  assert.equal(okChecks.find((check) => check.title === "连亏"), undefined);
});

test("全绿：也要有一条「体检通过」，面板不许消失", () => {
  // 5 只同价：top1 = 20%、top3 = 60%，都在阈值内，才有全绿的可能。
  const rows = [open("a"), open("b"), open("c"), open("d"), open("e")];
  const checks = healthChecks(input({ rows, dayNet: [0.01] }));
  const pass = checks.find((check) => check.title === "体检通过");
  assert.ok(pass, JSON.stringify(checks));
  assert.equal(pass.level, "ok");
});

test("缺可选输入时对应检查安静跳过，不误报也不全绿消失", () => {
  // 不传 industryNameOf / peRankOf / dayNet：行业、估值、连亏三项不该出现。
  // 同样用 5 只同价保证集中度全绿，才会走到「体检通过」。
  const rows = [open("a"), open("b"), open("c"), open("d"), open("e")];
  const checks = healthChecks(input({ rows }));
  const titles = checks.map((check) => check.title);
  assert.ok(!titles.some((title) => title.includes("行业")), titles.join(","));
  assert.ok(!titles.some((title) => title.includes("估值")), titles.join(","));
  assert.ok(!titles.some((title) => title.includes("连亏")), titles.join(","));
  // 剩下的 ok 项 + 体检通过 仍在。
  assert.ok(titles.includes("体检通过"), titles.join(","));
});

test("未平仓 ≥10 只：出只数 warn；6-9 只是 info", () => {
  const many = Array.from({ length: 10 }, (_, i) => open(`s${i}`));
  const warnChecks = healthChecks(input({ rows: many }));
  assert.equal(warnChecks.find((check) => check.title === "持仓只数偏多")?.level, "warn");

  const some = Array.from({ length: 7 }, (_, i) => open(`s${i}`));
  const infoChecks = healthChecks(input({ rows: some }));
  assert.equal(infoChecks.find((check) => check.title === "持仓只数接近上限")?.level, "info");
  assert.equal(infoChecks.find((check) => check.title === "持仓只数偏多"), undefined);
});
