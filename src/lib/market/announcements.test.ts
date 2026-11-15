/**
 * announcements.ts 的测试：类目匹配、标签剥离、北京时区、事件账读写。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  categoryOf,
  stripEm,
  dayOfBeijingMs,
  loadEventStream,
  EVENT_CATEGORIES,
} from "./announcements.ts";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("stripEm：剥任意高亮标签 + 解码实体 + 逐词切开能连上关键词", () => {
  assert.equal(stripEm("关于<em>减持</em>公司股票的公告"), "关于减持公司股票的公告");
  assert.equal(stripEm("审核<em>问询</em><em>函</em>中有关事项"), "审核问询函中有关事项");
  assert.equal(stripEm("A &amp; B &lt;环比&gt;"), "A & B <环比>");
  assert.equal(stripEm("无标签"), "无标签");
});

test("dayOfBeijingMs：+8h 修正，零点公告不落到前一天（2026-11-15 复检钉死）", () => {
  // 实测巨潮 2026-11-14 公告 announcementTime=1794585600000
  // 裸 toISOString() 得 2026-11-13T16:00:00Z（错一天），+8h 后才是 2026-11-14。
  assert.equal(new Date(1794585600000).toISOString().slice(0, 10), "2026-11-13");
  assert.equal(dayOfBeijingMs(1794585600000), "2026-11-14");
  assert.equal(dayOfBeijingMs(NaN), "");
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
    assert.equal(categoryOf(title), expect, title);
  }
});

test("categoryOf：负向词排除「不减持 / 解除质押 / 业绩说明会」等反向公告", () => {
  assert.equal(categoryOf("关于控股股东、认购对象出具特定期间不减持公司股票承诺"), null);
  assert.equal(categoryOf("关于股东提前终止减持计划的公告"), null);
  assert.equal(categoryOf("关于持股5%以上股东股份解除质押的公告"), null);
  assert.equal(categoryOf("关于召开2026年第三季度业绩说明会的公告"), null);
});

test("categoryOf：普通公告 = null（不硬塞类目）", () => {
  assert.equal(categoryOf("2026年11月13日投资者关系活动记录表"), null);
});

test("categoryOf：命中多个取最靠前的类目（问询优先于质押）", () => {
  assert.equal(categoryOf("关于<em>问询函</em>中<em>质押</em>事项的回复"), "inquiry");
});

test("EVENT_CATEGORIES：五类都有独立 query，且负向词不与自身关键词冲突", () => {
  for (const cat of EVENT_CATEGORIES) {
    assert.ok(cat.query.length > 0, `${cat.key} 缺 query`);
    assert.ok(cat.keywords.length > 0, `${cat.key} 缺 keywords`);
    for (const neg of cat.negative) {
      assert.ok(!cat.keywords.some((kw) => kw.includes(neg)), `${cat.key} 负向词 ${neg} 与关键词自相矛盾`);
    }
  }
});

test("EVENT_CATEGORIES：关键词去重（不重复登记同一个词）", () => {
  const seen = new Map<string, string>();
  for (const cat of EVENT_CATEGORIES) {
    for (const kw of cat.keywords) {
      const owner = seen.get(kw);
      assert.ok(!owner, `关键词 "${kw}" 同时属于 ${owner} 和 ${cat.key}`);
      seen.set(kw, cat.key);
    }
  }
});

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

test("loadEventStream：半截 JSON = null（不会被当成已采集）", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ann-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "announcements"), { recursive: true });
    await writeFile(join(dir, "announcements", "2026-11-14.json"), '{ "events": [');
    assert.equal(await loadEventStream("2026-11-14"), null);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
