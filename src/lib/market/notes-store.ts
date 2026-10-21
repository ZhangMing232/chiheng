/**
 * 这个文件是干什么的：
 * 笔记的落盘读写（每人一份：`data/notes/<userId>.json`）。
 *
 * 你需要知道的：
 * - 笔记是**用户自己写的**，所以这里只做「原样存、原样取」。不做任何加工，
 *   更不做「补充」——程序替用户改笔记内容，那是篡改。
 * - 写文件用「临时名 + rename」原子替换，临时名带 pid + 随机数（两个进程同时写
 *   会把文件写没，这个坑踩过）。
 * - data/ 不在 git 里，换机器就是空的。
 * - **每人一份**：开放注册后别人的笔记不能出现在你的页面里。旧的全局
 *   `data/notes.json` 只迁移给 dev-user（这台机器的主人），迁完改名 `.migrated`，
 *   新用户从空笔记开始。用户 id 白名单校验与 book-file.ts 的 safeUserId 同规则；
 *   不 import 它是为了不让 node:fs 链路有进客户端 bundle 的机会（见下面第 17 行注释）。
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { checkNote, sortNotes, type Note } from "./notes.ts";

// 必须在用到的时候才 join：本文件会进客户端 bundle（quotes.functions.ts 引用），
// 浏览器里 node:path 是空壳，模块顶层调用 join 会让整站 JS 一启动就崩（2026-10-16 修过）。
const NOTES_DIR = () => join("data", "notes");
const notesPath = (userId: string) => join(NOTES_DIR(), `${userId}.json`);

/** 未开登录时的本机主人，和 book-file.ts 的 OWNER_ID 同值（不 import，见文件头）。 */
const LEGACY_OWNER_ID = "dev-user";

/** 用户 id 只允许字母、数字、下划线和减号（与 book-file.ts safeUserId 同规则）。 */
function safeUserId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("无效的用户");
  return id;
}

/** 注册开放前的旧全局笔记位置。只用于一次性迁移给主人。 */
const legacyPath = () => join("data", "notes.json");

function parseNotes(raw: string): Note[] {
  const parsed: unknown = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : (parsed as { notes?: unknown })?.notes;
  if (!Array.isArray(rows)) return [];
  const out: Note[] = [];
  let bad = 0;
  for (const row of rows) {
    const checked = checkNote(row);
    if (checked.ok) out.push(checked.note);
    else bad += 1;
  }
  if (bad > 0) console.error(`[notes] 有 ${bad} 条读不出来，已跳过`);
  return sortNotes(out);
}

/**
 * 旧全局笔记 → 主人（dev-user）的一次性迁移。
 * 只迁给主人：新注册用户不该继承这台机器上已有的笔记。
 * 迁完把旧文件改名 `.migrated`；迁不动就下次再试。
 */
async function migrateLegacy(userId: string, root: string): Promise<void> {
  if (userId !== LEGACY_OWNER_ID) return;
  let raw: string;
  try {
    raw = await readFile(join(root, legacyPath()), "utf-8");
  } catch {
    return;
  }
  try {
    const dir = join(root, NOTES_DIR());
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `.migrate.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`);
    await writeFile(tmp, raw, "utf-8");
    await rename(tmp, join(root, notesPath(userId)));
    await rename(join(root, legacyPath()), join(root, `${legacyPath()}.migrated`));
  } catch {
    /* 下次再试 */
  }
}

/** 读某人的全部笔记。文件不存在 = 还没有笔记（返回空数组，不是错误）。 */
export async function loadNotes(userId: string, root = process.cwd()): Promise<Note[]> {
  const id = safeUserId(userId);
  try {
    return parseNotes(await readFile(join(root, notesPath(id)), "utf-8"));
  } catch {
    await migrateLegacy(id, root);
    try {
      return parseNotes(await readFile(join(root, notesPath(id)), "utf-8"));
    } catch {
      return [];
    }
  }
}

/** 存某人的全部笔记。调用方负责先算好下一份（增删改的逻辑在 notes.ts 的纯函数里）。 */
export async function saveNotes(notes: readonly Note[], userId: string, root = process.cwd()): Promise<boolean> {
  const dir = join(root, NOTES_DIR());
  const path = join(root, notesPath(safeUserId(userId)));
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(tmp, JSON.stringify(sortNotes(notes), null, 2), "utf-8");
    await rename(tmp, path);
    return true;
  } catch (error) {
    console.error(`[notes] 写不进去：${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}