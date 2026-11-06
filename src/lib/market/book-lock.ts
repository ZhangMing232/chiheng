/**
 * 账本文件锁：让「读整本 → 改 → 写回整本」这三步同一时刻只有一个写方在做。
 *
 * 为什么需要（2026-11-06 体检）：`writeUserBook` 是整本读改写，临时文件名带 pid
 * 只防了「两个进程写坏同一个 tmp 文件」，**没防丢更新**：
 *   A 读 316 笔 → B 读 316 笔 → A 写 317 → B 写 317（B 把 A 刚记的那笔整个盖掉）。
 * 文件不坏、不报错，就是账上静默少一笔。三个写方（每分钟记账 / 网页手动合并 /
 * backfill 脚本）都可能进这个窗口。
 *
 * 🔴 **接线时必须包住完整的读-改-写**，不能只锁 `writeUserBook` 的最后一步：
 * 两次「读」都在写之前发生，只锁写等于没锁。用 `withBookLock` 把读、改、写
 * 一起放进临界区，或者写前做版本校验（乐观并发）。见 design/REMAINING.md §12.1。
 *
 * 取舍：拿不到锁**抛错**，不静默降级成无锁写（那是把「不知道有没有并发」
 * 伪装成「写成功了」）。记账有 stamp 去重、下一分钟会重跑，丢一轮比丢一笔好。
 *
 * ⚠️ 浏览器兼容：本文件经 book-file.ts 进服务端终端，但 node API 一律函数内
 * 动态 import（项目里同类坑踩过三次），路径拼接不用 node:path。
 */
const fsApi = () => import("node:fs/promises");

/** 锁文件里记的凭证。token 用来保证「只释放自己持有的那把锁」。 */
export type BookLockTicket = {
  path: string;
  token: string;
  pid: number;
  at: number;
};

/**
 * 锁的「绝对上限」：只有超过这个年龄、且持锁进程查不到了，才当死锁清理。
 * 2026-11-06 接线时改过：原实现是「超 30s 就清，不管进程死没死」，
 * 而 `runBook` 一轮要拉行情/跑闸门/推送，长事务会被别的写方误清。
 * 现在短临界区只持有写文件那几十毫秒，进程活着就不清。
 */
export const BOOK_LOCK_STALE_MS = 30_000;
/** 硬上限：即便进程还"活着"，超过 10 分钟也强制清（防进程卡死永久占锁）。 */
export const BOOK_LOCK_HARD_STALE_MS = 10 * 60 * 1000;
/** 拿不到锁时最多等多久。 */
export const BOOK_LOCK_WAIT_MS = 3_000;
/** 重试间隔。 */
export const BOOK_LOCK_RETRY_MS = 40;

export class BookLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BookLockError";
  }
}

function lockPathFor(target: string): string {
  return `${target}.lock`;
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // 不发信号，只探活
    return true;
  } catch (err) {
    // EPERM = 进程在但没权限，也算活着；ESRCH = 真没了
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 抢锁。`open(path, "wx")` 是原子创建：同一时刻只有一个进程能成功，
 * 不需要「先 exists 再写」那种有竞态的判断。
 *
 * 遇到旧锁：写它的进程已不在、或超过硬上限（10 分钟），才清掉重抢。
 * 清理也带 token 比对，避免「A 判定 stale → B 已经抢到新锁 → A 把 B 的锁删了」。
 */
export async function acquireBookLock(
  target: string,
  opts: { waitMs?: number; hardStaleMs?: number; now?: () => number } = {},
): Promise<BookLockTicket> {
  const { open, readFile, unlink, mkdir } = await fsApi();
  const path = lockPathFor(target);
  const waitMs = opts.waitMs ?? BOOK_LOCK_WAIT_MS;
  const hardStaleMs = opts.hardStaleMs ?? BOOK_LOCK_HARD_STALE_MS;
  const now = opts.now ?? Date.now;
  const deadline = now() + waitMs;
  // 目录可能还不存在（第一本账）
  await mkdir(target.slice(0, Math.max(0, target.lastIndexOf("/"))) || ".", { recursive: true }).catch(() => undefined);

  for (;;) {
    const token = `${process.pid}.${now()}.${Math.random().toString(36).slice(2, 10)}`;
    const ticket: BookLockTicket = { path, token, pid: process.pid, at: now() };
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(JSON.stringify(ticket), "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return ticket;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    // 已有人持锁：读一下锁凭证，判断是不是死锁
    let held: Partial<BookLockTicket> | null = null;
    try {
      held = JSON.parse(await readFile(path, "utf8")) as Partial<BookLockTicket>;
    } catch {
      // 写了一半的坏锁内容 —— 也按死锁处理，但不能盲删（见下）
    }
    // 判死锁的三条，缺一不可：
    // ① 坏内容（写了一半）→ 清；② 持锁进程确实已不在 → 清；
    // ③ 超过硬上限（10 分钟）→ 清，防进程卡死。
    // **进程活着且没超硬上限就不清**，哪怕超过 staleMs —— 长事务不该被误伤。
    const pidDead = held != null && typeof held.pid === "number" && !alive(held.pid);
    const age = held != null && typeof held.at === "number" ? now() - held.at : 0;
    const stale = held == null || pidDead || age > hardStaleMs;
    if (stale) {
      // 只删我们刚读到的那把锁：删之前再读一次比对 token，防止别人已经抢到新锁。
      // 坏内容（写了一半）没有 token 可比，直接删——但删完必须回到抢锁循环，
      // 不能在这里 return（否则会拿着没锁的状态往下走）。
      try {
        let safeToDelete = held == null;
        if (!safeToDelete) {
          try {
            const again = await readFile(path, "utf8");
            const current = JSON.parse(again) as Partial<BookLockTicket>;
            safeToDelete = held != null && (current.token === held.token || current.token == null);
          } catch {
            // 第二次读出来也是坏内容：和我们刚读到的是同一份坏锁，可以删
            safeToDelete = true;
          }
        }
        if (safeToDelete) await unlink(path).catch(() => undefined);
      } catch {
        // 已被别人删掉/抢到，下一轮重试即可
      }
    }
    if (now() >= deadline) {
      throw new BookLockError(
        `账本锁被占用超过 ${waitMs}ms（${path}）。拒绝无锁写入——这一轮记账跳过，下一分钟会重跑。`,
      );
    }
    await sleep(BOOK_LOCK_RETRY_MS);
  }
}

/** 只释放自己那把锁。token 不匹配就不动（别人已经抢到了）。 */
export async function releaseBookLock(ticket: BookLockTicket | null | undefined): Promise<void> {
  if (!ticket) return;
  const { readFile, unlink } = await fsApi();
  try {
    const current = JSON.parse(await readFile(ticket.path, "utf8")) as Partial<BookLockTicket>;
    if (current.token !== ticket.token) return;
    await unlink(ticket.path);
  } catch {
    // 锁已经不在了（被超时清理/别人删了），不用管
  }
}

/**
 * 把一段完整的「读-改-写」放进临界区。回调返回 false 表示本次不需要写。
 * 无论成功失败都释放锁；拿不到锁直接抛 BookLockError，不静默降级。
 */
export async function withBookLock<T>(
  target: string,
  fn: () => Promise<T>,
  opts?: { waitMs?: number; hardStaleMs?: number; now?: () => number },
): Promise<T> {
  const ticket = await acquireBookLock(target, opts);
  try {
    return await fn();
  } finally {
    await releaseBookLock(ticket);
  }
}
