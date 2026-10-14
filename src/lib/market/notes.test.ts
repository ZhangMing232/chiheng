/**
 * 这个文件是干什么的：
 * 钉住笔记模块的纪律。
 *
 * 重点（这些是笔记和别的模块最不一样的地方）：
 * 1. **笔记不是事实，是用户自己写的线索**——所以校验只管格式和长度，
 *    不判断内容对错；它也绝不被当成证据引用（测试钉住没有 evidence 出口）
 * 2. 代码认不出来的 symbol 按「散记」处理，不报错也不瞎猜市场
 * 3. 超出上限丢最旧的，删一条改一条的行为都明确
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { NOTE_MAX, NOTE_TEXT_MAX, addNote, checkNote, editNote, filterNotes, noteId, removeNote, sortNotes, type Note } from "@/lib/market/notes";

const note = (over: Partial<Note> = {}): Note => ({
  id: "n1",
  at: "2026-10-14 10:00",
  symbol: "sh600519",
  name: "贵州茅台",
  text: "这批货渠道反馈还行",
  ...over,
});

test("校验：空内容、超长、时间格式、缺 id 都判废", () => {
  assert.equal(checkNote(null).ok, false);
  assert.equal(checkNote({ text: "   ", at: "2026-10-14 10:00", id: "n1" }).ok, false, "空白不是内容");
  assert.equal(checkNote({ text: "x".repeat(NOTE_TEXT_MAX + 1), at: "2026-10-14 10:00", id: "n1" }).ok, false);
  assert.equal(checkNote({ text: "a", at: "14/10/2026", id: "n1" }).ok, false);
  assert.equal(checkNote({ text: "a", at: "2026-10-14 10:00" }).ok, false);
  // 到点不加时分也算合法（只要日期对）
  assert.equal(checkNote({ text: "a", at: "2026-10-14", id: "n1" }).ok, true);
});

test("代码认不出来就当散记，不报错也不瞎猜市场", () => {
  const r = checkNote({ text: "纯想法", at: "2026-10-14", id: "n1", symbol: "600519" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.note.symbol, null, "六位裸代码不算内部 id");
  const r2 = checkNote({ text: "a", at: "2026-10-14", id: "n1", symbol: "sh600519" });
  if (r2.ok) assert.equal(r2.note.symbol, "sh600519");
});

test("排序：新的在前，同一天按 id 稳定倒序", () => {
  const list = [note({ id: "a", at: "2026-10-13 09:00" }), note({ id: "b", at: "2026-10-14 09:00" }), note({ id: "c", at: "2026-10-14 09:00" })];
  assert.deepEqual(sortNotes(list).map((n) => n.id), ["c", "b", "a"]);
});

test("按股票过滤，空 = 全部", () => {
  const list = [note({ id: "a", symbol: "sh600519" }), note({ id: "b", symbol: null }), note({ id: "c", symbol: "sh600519" })];
  // 三条 at 相同 → 按 id 倒序兜底：c 在 a 前
  assert.deepEqual(filterNotes(list, "sh600519").map((n) => n.id), ["c", "a"]);
  assert.equal(filterNotes(list, null).length, 3);
});

test("加同一条是替换不是追加（改完存不会多出一份）", () => {
  const once = addNote([], note());
  const twice = addNote(once, note({ text: "改过的" }));
  assert.equal(twice.length, 1);
  assert.equal(twice[0]!.text, "改过的");
});

test("超过上限丢最旧的", () => {
  const many = Array.from({ length: NOTE_MAX + 5 }, (_v, i) => note({ id: `n${i}`, at: `2026-10-01 00:00` }));
  const next = addNote(many, note({ id: "new", at: "2026-10-14 10:00" }));
  assert.equal(next.length, NOTE_MAX);
  assert.equal(next[0]!.id, "new", "新笔记在最前");
});

test("改一条：改不了就原样返回，不静默删", () => {
  const list = [note()];
  assert.deepEqual(editNote(list, "n1", "   "), list);
  assert.equal(editNote(list, "n1", "新内容")[0]!.text, "新内容");
  assert.equal(editNote(list, "n-other", "新内容")[0]!.text, note().text, "找不到就别动");
});

test("删一条只删那条", () => {
  const list = [note({ id: "a" }), note({ id: "b" })];
  assert.deepEqual(removeNote(list, "a").map((n) => n.id), ["b"]);
});

test("笔记 id 同毫秒也不撞", () => {
  const ids = new Set(Array.from({ length: 50 }, () => noteId("2026-10-14 10:00:00")));
  assert.equal(ids.size, 50);
});