/**
 * 这个文件是干什么的：
 * 钉住自选名单的三件事——**重复添加不是错误、删除幂等、到上限要拒**。
 *
 * 「重复添加返回原样」看着多余，其实是要区分两种用户行为：手滑点两次和真的想加两次。
 * 前者不该弹错误框，后者也不该悄悄加两行。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WATCH_LIMIT, addWatch, readWatchlist, removeWatch, writeWatchlist, type WatchItem } from "@/lib/market/watchlist";

function item(id: string, over: Partial<WatchItem> = {}): WatchItem {
  return { id, code: id.slice(2), name: `票${id}`, addedAt: "2026-10-12T08:00:00.000Z", ...over };
}

test("加一只：进名单，保留添加顺序", () => {
  const list = addWatch({ items: [] }, item("sh600519"));
  assert.deepEqual(list.items.map((r) => r.id), ["sh600519"]);
});

test("重复添加返回原样，不加两行也不报错", () => {
  const once = addWatch({ items: [] }, item("sh600519"));
  const twice = addWatch(once, item("sh600519"));
  assert.equal(twice.items.length, 1);
  assert.deepEqual(twice.items, once.items, "内容也不该变（addedAt 保持第一次的）");
});

test("移除幂等：删一个不在名单里的不报错", () => {
  const list = addWatch({ items: [] }, item("sh600519"));
  const after = removeWatch(list, "sz000001");
  assert.deepEqual(after.items.map((r) => r.id), ["sh600519"]);
});

test("到上限就拒，并说清上限是多少", () => {
  let list = { items: [] as WatchItem[] };
  for (let i = 0; i < WATCH_LIMIT; i += 1) list = addWatch(list, item(`sh60000${i}`));
  assert.throws(() => addWatch(list, item("sh999999")), new RegExp(`${WATCH_LIMIT}`));
});

test("落盘再读回来：内容一致", async () => {
  const root = mkdtempSync(join(tmpdir(), "chiheng-watch-"));
  try {
    const list = addWatch(addWatch({ items: [] }, item("sh600519")), item("sz000001"));
    await writeWatchlist(list, root);
    const back = await readWatchlist(root);
    assert.deepEqual(back.items.map((r) => r.id), ["sh600519", "sz000001"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("没存过时读回空名单，不报错（data 不在 git）", async () => {
  const back = await readWatchlist(mkdtempSync(join(tmpdir(), "chiheng-watch-empty-")));
  assert.deepEqual(back.items, []);
});

test("写坏的文件读回空名单，不把页面搞崩", async () => {
  const root = mkdtempSync(join(tmpdir(), "chiheng-watch-bad-"));
  try {
    await writeWatchlist({ items: [] }, root);
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "data", "watchlist.json"), "{ 半截 JSON", "utf-8");
    assert.deepEqual((await readWatchlist(root)).items, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
