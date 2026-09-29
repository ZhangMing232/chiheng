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
