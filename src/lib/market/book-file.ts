/**
 * 这个文件是干什么的：
 * 每个人一本账，存在 data/books/用户id.json。更新代码不会删这些文件。
 *
 * 你需要知道的：
 * 现在没开注册，这台电脑用的用户是 dev-user。
 * 以前的 data/journal.json 只会复制到 dev-user 一次。新用户从加入当天记空账，不会继承旧成交。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { shanghaiDate } from "./session.ts";

/** 未开登录时的本机账。打开注册后，每个会话用自己的用户 id，不再写这一本。 */
export const OWNER_ID = "dev-user";

export type StoredBook<T> = {
  joinedAt: string;
  days: T[];
  nextSettleAt?: number;
};

const booksDir = () => join(process.cwd(), "data", "books");
const legacyPath = () => join(process.cwd(), "data", "journal.json");

/** 用户 id 只允许字母、数字、下划线和减号，避免被人写成 ../ 去读别的文件。 */
export function safeUserId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("无效的用户");
  return id;
}

export function bookPath(userId: string): string {
  return join(booksDir(), `${safeUserId(userId)}.json`);
}

async function migrateOwner(): Promise<void> {
  const dest = bookPath(OWNER_ID);
  try {
    await readFile(dest, "utf8");
    return;
  } catch {
    // 还没有按用户分开的账，才从旧文件复制一次。
  }
  try {
    const legacy = JSON.parse(await readFile(legacyPath(), "utf8")) as { days?: { date?: string }[]; nextSettleAt?: number };
    const days = Array.isArray(legacy.days) ? legacy.days : [];
    const joinedAt = days.map((day) => day.date).filter((date): date is string => Boolean(date)).sort()[0] ?? "2020-01-01";
    await mkdir(booksDir(), { recursive: true });
    await writeFile(dest, JSON.stringify({ joinedAt, days, nextSettleAt: legacy.nextSettleAt }, null, 2));
  } catch {
    // 没有旧账。
  }
}

/** 读这一本账。文件还没有时返回空的天数列表，加入日写成今天。 */
export async function readUserBook<T>(userId: string): Promise<StoredBook<T>> {
  await migrateOwner();
  try {
    const parsed = JSON.parse(await readFile(bookPath(userId), "utf8")) as StoredBook<T>;
    return {
      joinedAt: typeof parsed.joinedAt === "string" ? parsed.joinedAt : shanghaiDate(),
      days: Array.isArray(parsed.days) ? parsed.days : [],
      nextSettleAt: parsed.nextSettleAt,
    };
  } catch {
    return { joinedAt: shanghaiDate(), days: [] };
  }
}

/** 整本账写回磁盘。调用方要先改好内容再写，这里不会合并。 */
export async function writeUserBook<T>(userId: string, book: StoredBook<T>): Promise<void> {
  await mkdir(booksDir(), { recursive: true });
  await writeFile(bookPath(userId), JSON.stringify(book, null, 2));
}

/** 第一次打开时建一本空账。加入日是当天，不复制别人已经记下的成交。 */
export async function ensureUserBook(userId: string): Promise<void> {
  await migrateOwner();
  try {
    await readFile(bookPath(userId), "utf8");
  } catch {
    await writeUserBook(userId, { joinedAt: shanghaiDate(), days: [] });
  }
}

/** 列出已经有账本的用户。dev-user 永远在名单里，方便这台 Mac 先用。 */
export async function listUserIds(): Promise<string[]> {
  await migrateOwner();
  let ids: string[] = [];
  try {
    const names = await readdir(booksDir());
    ids = names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)).filter((id) => /^[A-Za-z0-9_-]{1,80}$/.test(id));
  } catch {
    ids = [];
  }
  if (!ids.includes(OWNER_ID)) ids.unshift(OWNER_ID);
  return ids;
}
