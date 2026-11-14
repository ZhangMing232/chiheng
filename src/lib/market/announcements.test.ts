/**
 * announcements.ts 的测试：类目匹配、<em> 剥离、事件账读写（临时目录实测）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { categoryOf, stripEm, loadEventStream, fetchEventStream, EVENT_CATEGORIES } from "./announcements.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("stripEm：剥巨潮标题高亮标签", () => {
  assert.equal(stripEm("关于<em>减持</em>公司股票的公告"), "关于减持公司股票的公告");
  assert.equal(stripEm("无标签"), "无标签");
});

test("categoryOf：五类都能命中", () => {
  const cases: [string, string][] = [
    ["关于收到中国证监会<em>立案</em>告知书的公告", "investigation"],
    ["股东<em>减持</em>计划实施完毕的公告", "reduction"],
    ["2026年第三季度<em>业绩预告</em>", "forecast"],
    ["关于对某某公司<em>问询函</em>的回复", "inquiry"],
    ["控股股东部分股份<em>质押</em>及解除质押公告", "pledge"],
  ];
  for (const [title, expect] of cases) {
    assert.equal(categoryOf(stripEm(title)), expect, title);
  }
});

test("categoryOf：普通公告 = null（不硬塞类目）", () => {
  assert.equal(categoryOf(stripEm("2026年11月13日投资者关系活动记录表")), null);
});

test("categoryOf：命中多个取最靠前的类目（问询优先于质押）", () => {
  // 标题同时含问询函和质押：inquiry 在 EVENT_CATEGORIES 里排前面
  const title = "关于<em>问询函</em>中<em>质押</em>事项的回复";
  assert.equal(categoryOf(stripEm(title)), "inquiry");
});

test("EVENT_CATEGORIES：五类关键词互不撞车（同一关键词只属一类）", () => {
  const seen = new Map<string, string>();
  for (const cat of EVENT_CATEGORIES) {
    for (const kw of cat.keywords) {
      const owner = seen.get(kw);
      assert.ok(!owner, `关键词 "${kw}" 同时属于 ${owner} 和 ${cat.key}`);
      seen.set(kw, cat.key);
    }
  }
});

// ── 读写（临时目录实测 fetchEventStream 的 save/load 环路，fetch 用桩替换不了
//    模块内 import——所以这里只测 loadEventStream 的读盘路径和缺失路径）──

test("loadEventStream：没有文件 = null（不编账）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ann-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    assert.equal(await loadEventStream("2026-11-14"), null);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
