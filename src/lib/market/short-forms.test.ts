import assert from "node:assert/strict";
import { test } from "node:test";

import { boardLimitPct, classifyForms, settleForm, SHORT_FORMS } from "./short-forms.ts";
import type { DayBar } from "./short-forms.ts";

const bar = (o: number, h: number, l: number, c: number, date = "2026-11-06"): DayBar => ({ date, o, h, l, c });

test("涨跌停幅度按板块分，ST 优先", () => {
  assert.equal(boardLimitPct("sh600519"), 10);
  assert.equal(boardLimitPct("sz000001"), 10);
  assert.equal(boardLimitPct("sh688981"), 20);
  assert.equal(boardLimitPct("sz300750"), 20);
  assert.equal(boardLimitPct("bj430047"), 30);
  assert.equal(boardLimitPct("sz300750", true), 5, "ST 5% 优先于板块 20%");
});

test("六类形态各自认得出来", () => {
  const prev = 10; // 涨停 11.00，跌停 9.00
  // 炸板：最高触 11，收盘没封住
  assert.ok(classifyForms(bar(10.2, 11, 9.9, 10.4), prev, "sh600000").includes("炸板"));
  // 换手板：最低不到涨停、最高触板、收盘封住
  assert.ok(classifyForms(bar(10.2, 11, 10.1, 11), prev, "sh600000").includes("换手板"));
  // 一字板：开在涨停且全天最低也没下来
  assert.ok(classifyForms(bar(11, 11, 11, 11), prev, "sh600000").includes("一字板"));
  // T 字板：开在涨停、盘中打开、收盘封回
  assert.ok(classifyForms(bar(11, 11, 10.5, 11), prev, "sh600000").includes("T字板"));
  // 地天板：砸到跌停附近又封涨停
  assert.ok(classifyForms(bar(9.1, 11, 9.0, 11), prev, "sh600000").includes("地天板"));
  // 弱转强：低开却收涨停
  assert.ok(classifyForms(bar(9.8, 11, 9.7, 11), prev, "sh600000").includes("弱转强"));
});

test("多标签是故意的：低开拉板同时是换手板和弱转强", () => {
  const forms = classifyForms(bar(9.8, 11, 9.7, 11), 10, "sh600000");
  assert.ok(forms.includes("换手板"));
  assert.ok(forms.includes("弱转强"));
  for (const f of forms) assert.ok(SHORT_FORMS.includes(f), "不许冒出没登记的形态");
});

test("无前视：砍掉未来数据重算，之前每一天的形态逐点相同", () => {
  const series: DayBar[] = [
    bar(10, 10.2, 9.9, 10.1, "2026-11-02"),
    bar(10.1, 11.11, 10.0, 10.4, "2026-11-03"), // 炸板
    bar(10.4, 11.44, 10.3, 11.44, "2026-11-04"), // 换手板
    bar(11.44, 12.58, 11.0, 11.9, "2026-11-05"),
    bar(11.9, 13.09, 11.8, 12.2, "2026-11-06"),
    bar(12.2, 13.42, 12.1, 12.5, "2026-11-09"),
    bar(12.5, 13.75, 12.4, 12.8, "2026-11-10"),
  ];
  const labelsFor = (rows: DayBar[]) =>
    rows.slice(1).map((b, i) => classifyForms(b, rows[i].c, "sh600000"));
  const full = labelsFor(series);
  assert.ok(full.some((f) => f.length > 0), "测试数据里得真有形态，否则这个断言等于没测");

  const cut = labelsFor(series.slice(0, 5)); // 只留前 5 根，后面的全砍掉
  assert.deepEqual(cut, full.slice(0, 4), "砍掉未来，历史每天形态必须一字不差");

  const tampered = [
    ...series.slice(0, 5),
    ...series.slice(5).map((b) => ({ ...b, h: b.h * 1.5, c: b.c * 1.5, o: b.o * 1.2, l: b.l * 0.5 })),
  ];
  assert.deepEqual(labelsFor(tampered).slice(0, 4), full.slice(0, 4), "把未来整段改掉，历史也不该变");
});

test("数据不全返回空，不猜、不拿 0 当没涨停", () => {
  assert.deepEqual(classifyForms(bar(10, 10, 10, 10), 0, "sh600000"), []);
  assert.deepEqual(classifyForms(bar(10, 10, 10, Number.NaN), 10, "sh600000"), []);
  assert.deepEqual(classifyForms(bar(10, 10, 10, 10), 10, "sh600000"), [], "普通日不贴任何标签");
});

test("高开买不到就不计入收益——看着涨不等于买得到", () => {
  const miss = settleForm(11, [{ o: 11.5, c: 11.8 }, { o: 11.8, c: 12 }]);
  assert.equal(miss.fillable, false);
  assert.equal(miss.r1, null, "买不到不能记成 0 收益");
  const hit = settleForm(11, [{ o: 10.8, c: 10.5 }, { o: 10.5, c: 10.2 }]);
  assert.equal(hit.fillable, true);
  assert.ok(hit.r1 != null && hit.r1 < 0);
  assert.ok(hit.r2 != null && hit.r2 < hit.r1);
});

test("后续 K 线缺失返回 null，不是 0", () => {
  assert.deepEqual(settleForm(11, null), { fillable: false, r1: null, r2: null });
  assert.deepEqual(settleForm(11, [{ o: 10.8, c: Number.NaN }, { o: 10, c: 10 }]), {
    fillable: false,
    r1: null,
    r2: null,
  });
});
