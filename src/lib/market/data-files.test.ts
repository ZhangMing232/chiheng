/**
 * 这个文件是干什么的：
 * 钉住数据新鲜度的判据。
 *
 * 重点：
 * 1. **文件不存在 ≠ 过期**：显示「没抓过」，不显示「0 天前」。这两件事的原因不同，
 *    混成一句「数据缺失」会让人查错方向
 * 2. **必须有却没有**的项要能单独挑出来（那是真问题，不只是过期）
 * 3. TTL 查 fetch-policy，不在这里重写数字
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { DATA_FILES, allFreshness, freshnessOf, missingRequired, type Facts } from "@/lib/market/data-files";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const universe = DATA_FILES.find((f) => f.path === "data/universe-cache.json")!;
const notes = DATA_FILES.find((f) => f.path === "data/notes.json")!;

test("文件不存在说「没抓过」，不是「0 天前」", () => {
  const f = freshnessOf(universe, {}, NOW);
  assert.equal(f.state, "missing");
  assert.equal(f.ageMs, null);
  assert.equal(f.sizeKb, null);
  assert.match(f.note, /没这个文件/);
  assert.match(f.refresh, /服务自己维护/, "要告诉别人怎么补");
});

test("必需项缺失和可选项缺失，说话不一样", () => {
  const required = freshnessOf(universe, {}, NOW);
  const optional = freshnessOf(notes, {}, NOW);
  assert.match(required.note, /页面有些地方会开不了/);
  assert.match(optional.note, /不影响其它页面/);
});

test("过了 TTL 就是过期，没过就是新鲜", () => {
  const fresh = freshnessOf(universe, { [universe.path]: { size: 1024 * 300, mtime: NOW - 2 * MIN } }, NOW);
  assert.equal(fresh.state, "ok");
  assert.match(fresh.note, /还新鲜/);
  const stale = freshnessOf(universe, { [universe.path]: { size: 1024 * 300, mtime: NOW - 60 * MIN } }, NOW);
  assert.equal(stale.state, "stale");
  assert.match(stale.note, /已过新鲜期/);
});

test("不看新鲜度的文件（记账心跳、笔记）只报多久没更新", () => {
  const f = freshnessOf(notes, { [notes.path]: { size: 200, mtime: NOW - 3 * 24 * 60 * MIN } }, NOW);
  assert.equal(f.state, "na");
  assert.match(f.note, /3 天前更新/);
  assert.ok(f.ageMs != null, "还是要给年龄");
});

test("必需项缺失能单独挑出来（那是真问题，不只是过期）", () => {
  const cap = DATA_FILES.find((f) => f.path === "data/backtest/cap.json")!;
  const facts: Facts = {
    [universe.path]: { size: 1, mtime: NOW },
    "data/recorder.json": null,
    [cap.path]: { size: 1, mtime: NOW },
  };
  const rows = allFreshness(facts, NOW);
  const missing = missingRequired(rows);
  assert.deepEqual(missing.map((m) => m.label), ["记账心跳"]);
});

test("每份文件都写了怎么补（refresh 不能空）", () => {
  for (const f of DATA_FILES) assert.ok(f.refresh.length > 5, `${f.path} 没写怎么补`);
});