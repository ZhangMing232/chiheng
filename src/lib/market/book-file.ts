/**
 * 这个文件是干什么的：
 * 每个人一本账，存在 data/books/用户id.json。更新代码不会删这些文件。
 *
 * 你需要知道的：
 * 现在没开注册，这台电脑用的用户是 dev-user。
 * 以前的 data/journal.json 只会复制到 dev-user 一次。新用户从加入当天记空账，不会继承旧成交。
 */
import { shanghaiDate } from "./session.ts";

/**
 * ⚠️ 浏览器兼容（2026-10-25，同类坑第三次）：
 * 顶层 import node: 内置模块会被 vite 转成空壳桩顶层解构，模块一求值就抛
 * 「Module externalized」→ hydration 跑不了 → 整站按钮失灵（页面能看、点不动）。
 * 本文件经 quotes.functions.ts / symbol-panel.functions.ts / challenger-samples.ts
 * 进客户端闭包（.functions.ts 是服务端终端，challenger-samples.ts 不是），
 * node API 必须函数内动态 import；路径拼接用 posixJoin 替代 node:path。
 */
const fsApi = () => import("node:fs/promises");
/** 内容版本用 sha256，同样动态 import（客户端闭包不能碰 node:crypto 顶层）。 */
const cryptoApi = () => import("node:crypto");
/** POSIX 风格拼路径。不用 node:path——顶层 import 它同样会在客户端崩（见文件头）。 */
const posixJoin = (...parts: string[]): string => parts.join("/");

/** 未开登录时的本机账。打开注册后，每个会话用自己的用户 id，不再写这一本。 */
export const OWNER_ID = "dev-user";

export type StoredBook<T> = {
  joinedAt: string;
  days: T[];
  nextSettleAt?: number;
};

const booksDir = () => posixJoin(process.cwd(), "data", "books");
const legacyPath = () => posixJoin(process.cwd(), "data", "journal.json");

/** 用户 id 只允许字母、数字、下划线和减号，避免被人写成 ../ 去读别的文件。 */
export function safeUserId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error("无效的用户");
  return id;
}

export function bookPath(userId: string): string {
  return posixJoin(booksDir(), `${safeUserId(userId)}.json`);
}

async function migrateOwner(): Promise<void> {
  const dest = bookPath(OWNER_ID);
  const { mkdir, readFile, writeFile } = await fsApi();
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
/** 账本内容版本：文件原文的 sha256 前 16 位。读不到 = 空版本（不拿 0/假值顶替）。 */
export async function readBookVersion(userId: string): Promise<string | null> {
  const { readFile } = await fsApi();
  const { createHash } = await cryptoApi();
  try {
    const raw = await readFile(bookPath(userId), "utf8");
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  } catch {
    return null;
  }
}

/** 读账本，同时给出内容版本——写回时把版本传回来做乐观并发校验。 */
export type VersionedBook<T> = { book: StoredBook<T>; version: string | null };

async function readRaw<T>(userId: string): Promise<VersionedBook<T>> {
  await migrateOwner();
  const { readFile } = await fsApi();
  const { createHash } = await cryptoApi();
  try {
    // 一次读取、就地算版本：分两次读的话，中间若有人写账，版本和内容就对不上，
    // 会让紧接着的写回被误判成并发冲突。
    const raw = await readFile(bookPath(userId), "utf8");
    const parsed = JSON.parse(raw) as StoredBook<T>;
    return {
      book: {
        joinedAt: typeof parsed.joinedAt === "string" ? parsed.joinedAt : shanghaiDate(),
        days: Array.isArray(parsed.days) ? parsed.days : [],
        nextSettleAt: parsed.nextSettleAt,
      },
      version: createHash("sha256").update(raw).digest("hex").slice(0, 16),
    };
  } catch {
    return { book: { joinedAt: shanghaiDate(), days: [] }, version: null };
  }
}

export async function readUserBookWithVersion<T>(userId: string): Promise<VersionedBook<T>> {
  return readRaw<T>(userId);
}

export async function readUserBook<T>(userId: string): Promise<StoredBook<T>> {
  return (await readRaw<T>(userId)).book;
}

/**
 * 整本账写回磁盘。调用方要先改好内容再写，这里不会合并。
 * 先写同一个目录下的 .tmp 文件，落盘之后再改名。改名在同一块磁盘上是一步完成的，
 * 所以任何时刻读到的要么是上一次完整的账、要么是这一次完整的账，
 * 不会出现写了一半的坏文件——坏文件会被 readUserBook 当成「没有账」而整本消失。
 */
/**
 * 版本对不上：别人在读与写之间改过账本。抛错比静默整本覆盖好——
 * 记账有 stamp 去重，下一分钟会重跑；手动合并/backfill 会明确告诉人「重试」。
 */
export class BookConcurrentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookConcurrentError";
  }
}

export type WriteBookOpts = {
  /** 本次「读」时拿到的版本（readUserBookWithVersion().version）。 */
  expectedVersion?: string | null;
};

/**
 * 整本账写回磁盘。**短临界区**：只在「校验版本 + 写 tmp + rename」这几毫秒持锁。
 *
 * 2026-11-06 接线的关键取舍：不能把整段「读-改-写」放进互斥锁。
 * `runBook` 一轮要拉全市场行情、跑闸门、推送、写 stamp，可能几十秒；
 * 整段持锁会让网页手动合并 / backfill 等 3 秒就超时，还可能被 stale 误清。
 * 所以改成**乐观并发**：读时记版本，写前在锁内重新校验版本；
 * 版本变了就抛 BookConcurrentError，绝不覆盖别人刚记的一笔。
 *
 * 不传 expectedVersion 时行为与旧版一致（只加互斥），保证 ensureUserBook
 * 等初始化路径和既有调用方不受影响。
 */
export async function writeUserBook<T>(userId: string, book: StoredBook<T>, opts: WriteBookOpts = {}): Promise<void> {
  const target = bookPath(userId);
  const { withBookLock } = await import("./book-lock.ts");
  await withBookLock(target, async () => {
    if (opts.expectedVersion !== undefined) {
      const current = await readBookVersion(userId);
      if (current !== opts.expectedVersion) {
        throw new BookConcurrentError(
          `账本在读与写之间被改过（读时版本 ${opts.expectedVersion ?? "空"}，当前 ${current ?? "空"}）。` +
          `拒绝整本覆盖——这一轮跳过，下一分钟记账会重跑；手动操作请刷新后重试。`,
        );
      }
    }
    const { mkdir, open, rename, rm } = await fsApi();
    await mkdir(booksDir(), { recursive: true });
    // 临时文件名字里带上 pid 和随机数。两个进程同时记账时（用户的 .app 自己拉起一份、
    // launchd 又拉起一份，两者互不知情），固定名字会让它们往同一个文件里写，
    // 两次写入长度不同时文件尾部会残留前一次的字节，读出来是坏 JSON，
    // 而 readUserBook 遇到坏 JSON 会当成「没有账」——整本账就这么静默没了。
    const staged = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    const handle = await open(staged, "w");
    try {
      await handle.writeFile(JSON.stringify(book, null, 2), "utf8");
      await handle.sync();
    } catch (error) {
      // 写了一半失败，别把这个半成品留在磁盘上占着名字。
      await handle.close().catch(() => undefined);
      await rm(staged, { force: true }).catch(() => undefined);
      throw error;
    }
    await handle.close();
    await rename(staged, target);
  });
}

/** 第一次打开时建一本空账。加入日是当天，不复制别人已经记下的成交。 */
export async function ensureUserBook(userId: string): Promise<void> {
  await migrateOwner();
  const { readFile } = await fsApi();
  try {
    await readFile(bookPath(userId), "utf8");
  } catch {
    await writeUserBook(userId, { joinedAt: shanghaiDate(), days: [] });
  }
}

/** 列出已经有账本的用户。dev-user 永远在名单里，方便这台 Mac 先用。 */
export async function listUserIds(): Promise<string[]> {
  await migrateOwner();
  const { readdir } = await fsApi();
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
