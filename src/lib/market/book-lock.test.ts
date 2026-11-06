/**
 * 账本文件锁测试。全部用临时目录，不碰真 data/。
 *
 * 最关键的一条是最后那个「交错读-改-写」：它复现了没有锁时的丢更新，
 * 并证明把整段事务放进 withBookLock 后两笔都在。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireBookLock, releaseBookLock, withBookLock, BookLockError,
  BOOK_LOCK_RETRY_MS,
} from "@/lib/market/book-lock";

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chiheng-book-lock-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("抢锁是互斥的：第二个人拿不到，且超时后抛 BookLockError 而不是无锁写入", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "dev-user.json");
    const first = await acquireBookLock(target);
    assert.ok(existsSync(first.path));
    await assert.rejects(
      acquireBookLock(target, { waitMs: BOOK_LOCK_RETRY_MS * 2 }),
      (e: unknown) => e instanceof BookLockError && /拒绝无锁写入/.test(e.message),
    );
    await releaseBookLock(first);
    assert.equal(existsSync(first.path), false);
  });
});

test("释放后才能再抢，凭证里的 token 每把都不同", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "dev-user.json");
    const a = await acquireBookLock(target);
    await releaseBookLock(a);
    const b = await acquireBookLock(target);
    assert.notEqual(a.token, b.token);
    await releaseBookLock(b);
  });
});

test("只释放自己的锁：token 不匹配时不删别人刚抢到的锁", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "dev-user.json");
    const a = await acquireBookLock(target);
    const path = a.path;
    // 模拟：a 的锁过期被清掉，b 抢到新锁，此时迟到的 a 才来 release
    const bTicket = { path, token: "someone-else", pid: 999999, at: Date.now() };
    writeFileSync(path, JSON.stringify(bTicket), "utf8");
    await releaseBookLock(a);
    assert.equal(existsSync(path), true, "不能把别人的锁删掉");
    assert.equal(JSON.parse(readFileSync(path, "utf8")).token, "someone-else");
  });
});

test("死锁自动清理：持锁进程已不在的超旧锁不该让记账永久卡住", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "dev-user.json");
    const path = `${target}.lock`;
    // pid 取一个几乎肯定不存在的，at 也远超 stale
    writeFileSync(path, JSON.stringify({ path, token: "dead", pid: 2_147_483_647, at: 1 }), "utf8");
    const got = await acquireBookLock(target, { waitMs: 2_000 });
    assert.equal(got.token === "dead", false);
    await releaseBookLock(got);
  });
});

test("坏锁内容（写了一半）也能被清掉重抢", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "dev-user.json");
    writeFileSync(`${target}.lock`, "{写了一半", "utf8");
    const got = await acquireBookLock(target, { waitMs: 2_000 });
    assert.ok(got.token);
    await releaseBookLock(got);
  });
});

test("withBookLock：回调抛错也必须释放锁", async () => {
  await withTmp(async (dir) => {
    const target = join(dir, "dev-user.json");
    await assert.rejects(
      withBookLock(target, async () => { throw new Error("模拟写账失败"); }),
      /模拟写账失败/,
    );
    assert.equal(existsSync(`${target}.lock`), false, "异常路径不能留下死锁");
    const again = await acquireBookLock(target);
    await releaseBookLock(again);
  });
});

/** 模拟整本读改写的交易账。 */
type Trade = { id: string };
type Book = { joinedAt: string; trades: Trade[] };
function readBook(path: string): Book {
  return JSON.parse(readFileSync(path, "utf8")) as Book;
}
function writeBook(path: string, b: Book): void {
  writeFileSync(path, JSON.stringify(b, null, 2), "utf8");
}
/** 先读、改内存、再整本写回 —— 和 writeUserBook 的调用方一模一样。 */
async function addTrade(path: string, id: string): Promise<void> {
  const b = readBook(path);
  await new Promise((r) => setTimeout(r, 5)); // 拉开读-写窗口，制造交错
  b.trades.push({ id });
  writeBook(path, b);
}

test("🔴 没有锁：两个写方交错读-改-写，会静默丢掉一笔", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "dev-user.json");
    writeBook(path, { joinedAt: "2026-10-20", trades: [{ id: "old" }] });
    await Promise.all([addTrade(path, "A"), addTrade(path, "B")]);
    const ids = readBook(path).trades.map((t) => t.id);
    assert.equal(ids.length, 2, "应该是 old+A+B 三笔，实际只有两笔 = 丢了一笔");
    assert.equal(ids.includes("A") && ids.includes("B"), false);
  });
});

test("🔴 有锁：把整段读-改-写放进临界区，两笔都在（317 → 318 而不是 317）", async () => {
  await withTmp(async (dir) => {
    const path = join(dir, "dev-user.json");
    writeBook(path, { joinedAt: "2026-10-20", trades: [{ id: "old" }] });
    await Promise.all([
      withBookLock(path, () => addTrade(path, "A"), { waitMs: 5_000 }),
      withBookLock(path, () => addTrade(path, "B"), { waitMs: 5_000 }),
    ]);
    const ids = readBook(path).trades.map((t) => t.id);
    assert.equal(ids.length, 3);
    assert.ok(ids.includes("A") && ids.includes("B"), "A 和 B 都得在账上");
    assert.equal(existsSync(`${path}.lock`), false);
  });
});
