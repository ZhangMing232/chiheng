/**
 * 这个文件是干什么的：
 * 笔记的落盘读写（`data/notes.json`）。
 *
 * 你需要知道的：
 * - 笔记是**用户自己写的**，所以这里只做「原样存、原样取」。不做任何加工，
 *   更不做「补充」——程序替用户改笔记内容，那是篡改。
 * - 写文件用「临时名 + rename」原子替换，临时名带 pid + 随机数（两个进程同时写
 *   会把文件写没，这个坑踩过）。
 * - data/ 不在 git 里，换机器就是空的。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkNote, sortNotes, type Note } from "./notes.ts";

// 必须在用到的时候才 join：本文件会进客户端 bundle（quotes.functions.ts 引用），
// 浏览器里 node:path 是空壳，模块顶层调用 join 会让整站 JS 一启动就崩（2026-10-16 修过）。
const NOTES_PATH = () => join("data", "notes.json");

/** 读全部笔记。文件不存在 = 还没有笔记（返回空数组，不是错误）。 */
export async function loadNotes(root = process.cwd()): Promise<Note[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(root, NOTES_PATH()), "utf-8"));
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : (parsed as { notes?: unknown })?.notes;
  if (!Array.isArray(rows)) return [];
  const out: Note[] = [];
  let bad = 0;
  for (const row of rows) {
    const checked = checkNote(row);
    if (checked.ok) out.push(checked.note);
    else bad += 1;
  }
  if (bad > 0) console.error(`[notes] ${NOTES_PATH()} 有 ${bad} 条读不出来，已跳过`);
  return sortNotes(out);
}

/** 存全部笔记。调用方负责先算好下一份（增删改的逻辑在 notes.ts 的纯函数里）。 */
export async function saveNotes(notes: readonly Note[], root = process.cwd()): Promise<boolean> {
  const path = join(root, NOTES_PATH());
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(sortNotes(notes), null, 2), "utf-8");
    await rename(tmp, path);
    return true;
  } catch (error) {
    console.error(`[notes] 写不进去：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}