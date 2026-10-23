/**
 * 钉住页面装饰配置表的行为。
 * 这些是「配置写错就整站页面没有身份」的防线。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { decorFor, HUE_COLORS, PAGE_DECOR } from "@/lib/ui/page-decor";

test("每个配置项都有非空的一句话职能", () => {
  for (const [path, decor] of Object.entries(PAGE_DECOR)) {
    assert.ok(decor.purpose.length > 0, `${path} 缺职能句`);
    assert.ok(decor.purpose.length <= 24, `${path} 职能句太长（${decor.purpose.length} 字），页头一行放不下`);
  }
});

test("色相是已定义集合内的（拼错会渲染成不存在的色）", () => {
  const valid = new Set(Object.keys(HUE_COLORS));
  for (const [path, decor] of Object.entries(PAGE_DECOR)) {
    assert.ok(valid.has(decor.hue), `${path} 的 hue "${decor.hue}" 不在 HUE_COLORS 里`);
  }
});

test("🔴 功能组色相必须一致：同一组的页面共用一个色相", () => {
  // 侧栏的五个功能组：组名 → 该组所有一级页面的色相必须相同。
  // 底纹的意义就是「一眼知道在哪一组」——组内色相不一致等于没有底纹。
  const groups: Record<string, string[]> = {
    工作台: ["/", "/butler", "/studio"],
    市场: ["/overview", "/review", "/flow", "/news", "/overseas"],
    策略因子: ["/strategies/screener", "/factors", "/backtest"],
    研究: ["/research", "/debate", "/reports", "/notes"],
    我的: ["/my-stocks", "/inbox", "/settings", "/admin"],
  };
  for (const [group, paths] of Object.entries(groups)) {
    const hues = paths.map((p) => PAGE_DECOR[p]?.hue);
    assert.ok(hues.every((h) => h != null), `${group} 组有页面没配 hue`);
    assert.equal(new Set(hues).size, 1, `${group} 组的色相不统一：${hues.join("/")}`);
  }
});

test("decorFor：精确匹配", () => {
  const d = decorFor("/factors");
  assert.ok(d);
  assert.equal(d.hue, "violet");
});

test("decorFor：子页面继承父页面（/flow/stocks 归 /flow）", () => {
  const d = decorFor("/flow/stocks");
  assert.ok(d, "子页面应该能拿到父页面的装饰");
  assert.equal(d.hue, PAGE_DECOR["/flow"]!.hue);
});

test("decorFor：前缀匹配取最长的（/strategies/screener 不被 /strategies 抢走）", () => {
  const d = decorFor("/strategies/screener");
  assert.equal(d?.hue, PAGE_DECOR["/strategies/screener"]!.hue);
});

test("decorFor：没配的路径返回 null（装饰是加分项，不能让页面崩）", () => {
  assert.equal(decorFor("/不存在的页面"), null);
});

test("🔴 根路径 '/' 不能参与前缀匹配（否则所有页面都变成主控台）", () => {
  // "/" 是所有路径的前缀。如果它参与前缀匹配，/overview 会被判成首页。
  const d = decorFor("/overview");
  assert.notEqual(d?.hue, PAGE_DECOR["/"]!.hue, "/overview 拿到了根页面的装饰");
  assert.equal(d?.hue, "blue");
});

test("每个色相都有深浅两套色值（浅色模式下不能透明）", () => {
  for (const [hue, colors] of Object.entries(HUE_COLORS)) {
    assert.match(colors.dark, /^#[0-9a-f]{6}$/i, `${hue} 的深色值格式不对`);
    assert.match(colors.light, /^#[0-9a-f]{6}$/i, `${hue} 的浅色值格式不对`);
  }
});

test("每个色相深浅两套色值不同（否则切主题时底纹不变）", () => {
  for (const [hue, colors] of Object.entries(HUE_COLORS)) {
    assert.notEqual(colors.dark, colors.light, `${hue} 深浅同色，切主题时底纹没变化`);
  }
});

test("🔴 每个配置都有非空标题（页头不能是空壳）", () => {
  for (const [path, decor] of Object.entries(PAGE_DECOR)) {
    assert.ok(decor.title.trim().length > 0, `${path} 缺标题——页头会渲染成空 h1`);
  }
});

test("🔴 没有侧栏入口的页面也要有标题（不能依赖 navHit）", () => {
  // 这些页面在侧栏里没有入口，靠导航表取标题会拿到空字符串。
  // 2026-10-23 实测踩到：/ai、/symbol、/membership、/strategies/positions
  // 的页头标题全是空的。
  for (const path of ["/ai", "/symbol", "/membership", "/strategies/positions"]) {
    const decor = decorFor(path);
    assert.ok(decor, `${path} 没有装饰配置`);
    assert.ok(decor!.title.length > 0, `${path} 标题为空`);
  }
});
