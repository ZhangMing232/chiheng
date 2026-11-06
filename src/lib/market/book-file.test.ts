/**
 * 账本读写的并发安全测试。全部用临时目录，不碰真 data/books/。
 *
 * 2026-11-06 接线后钉住的行为：writeUserBook 是整本读改写，
 * 读时记版本、写前在锁内重新校验；别人在中间改过就抛 BookConcurrentError，
 * 绝不静默整本覆盖（那会丢掉刚记的一笔，且不报错）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readUserBook, readUserBookWithVersion, readBookVersion, writeUserBook,
  BookConcurrentError, bookPath, type StoredBook,
} from "@/lib/market/book-file";

type Day = { date: string; trades: { id: string }[] };

function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "chiheng-book-file-"));
  const prev = process.cwd();
  process.chdir(dir);
  // 快照/兼容路径：book-file 用 process.cwd()/data/books
  return fn(dir).finally(() => {
    process.chdir(prev);
    rmSync(dir, { recursive: true, force: true });
  });
}

function seed(book: StoredBook<Day>): void {
  const p = bookPath("dev-user");
  writeFileSync(p, JSON.stringify(book, null, 2), "utf8");
}

const base: StoredBook<Day> = {
  joinedAt: "2026-10-20",
  days: [{ date: "2026-10-20", trades: [{ id: "old" }] }],
};

test("读账本带内容版本，写回后版本会变", async () => {
  await withTmp(async () => {
    // 手动建目录（withTmp 只给空目录，bookPath 的父目录要存在）
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(process.cwd(), "data", "books"), { recursive: true });
    seed(base);
    const { book, version } = await readUserBookWithVersion<Day>("dev-user");
    assert.equal(book.days[0]!.trades[0]!.id, "old");
    assert.ok(version && /^[0-9a-f]{16}$/.test(version), "版本是 16 位 hash");
    assert.equal(await readBookVersion("dev-user"), version);

    const updated: StoredBook<Day> = { ...book, days: [{ ...book.days[0]!, trades: [...book.days[0]!.trades, { id: "added" }] }] };
    await writeUserBook("dev-user", updated, { expectedVersion: version });
    assert.notEqual(await readBookVersion("dev-user"), version, "内容变了版本必须变");
    assert.equal((await readUserBook<Day>("dev-user")).days[0]!.trades.length, 2);
  });
});

test("🔴 读与写之间被别人改过 → 抛 BookConcurrentError，绝不覆盖", async () => {
  await withTmp(async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(process.cwd(), "data", "books"), { recursive: true });
    seed(base);
    const { book, version } = await readUserBookWithVersion<Day>("dev-user");

    // 模拟另一个写方在这期间记了一笔（走不带版本的路径，等价于旧代码）
    const theirs: StoredBook<Day> = { ...book, days: [{ ...book.days[0]!, trades: [...book.days[0]!.trades, { id: "theirs" }] }] };
    await writeUserBook("dev-user", theirs);

    // 本方拿着旧版本想写回 —— 必须被拦下
    const mine: StoredBook<Day> = { ...book, days: [{ ...book.days[0]!, trades: [...book.days[0]!.trades, { id: "mine" }] }] };
    await assert.rejects(
      writeUserBook("dev-user", mine, { expectedVersion: version }),
      (e: unknown) => e instanceof BookConcurrentError && /拒绝整本覆盖/.test(e.message),
    );
    // 最关键：磁盘上别人那笔还在，没被我的旧版本盖掉
    const onDisk = JSON.parse(readFileSync(bookPath("dev-user"), "utf8")) as StoredBook<Day>;
    const ids = onDisk.days[0]!.trades.map((t) => t.id);
    assert.ok(ids.includes("theirs"), "别人刚记的一笔必须还在");
    assert.ok(!ids.includes("mine"), "我这轮不能写进去");
    assert.equal(existsSync(`${bookPath("dev-user")}.lock`), false, "异常路径不能留下死锁");
  });
});

test("版本一致时正常写入，且不传版本时行为与旧版兼容", async () => {
  await withTmp(async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(process.cwd(), "data", "books"), { recursive: true });
    seed(base);
    const { book, version } = await readUserBookWithVersion<Day>("dev-user");
    const next: StoredBook<Day> = { ...book, days: [...book.days, { date: "2026-10-21", trades: [] }] };
    await writeUserBook("dev-user", next, { expectedVersion: version });
    assert.equal((await readUserBook<Day>("dev-user")).days.length, 2);

    // ensureUserBook 等初始化路径不传版本：只加互斥，行为不变
    await writeUserBook("dev-user", base);
    assert.equal((await readUserBook<Day>("dev-user")).days.length, 1);
    assert.equal(existsSync(`${bookPath("dev-user")}.lock`), false);
  });
});

test("空账本（文件不存在）读写不出错，版本为 null 也能自洽", async () => {
  await withTmp(async () => {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(process.cwd(), "data", "books"), { recursive: true });
    const { book, version } = await readUserBookWithVersion<Day>("dev-user");
    assert.deepEqual(book.days, []);
    assert.equal(version, null);
    await writeUserBook("dev-user", { joinedAt: "2026-11-06", days: [] }, { expectedVersion: version });
    assert.equal((await readUserBook<Day>("dev-user")).days.length, 0);
  });
});

test("🔴 接线守门：三个已知写方的 writeUserBook 都必须传 expectedVersion", async () => {
  // 新增写方若忘了传版本，就退回「静默整本覆盖」的老路，丢账不报错。
  // 这条测试扫源码把三个写方钉住；新增写方请同步加进 WRITERS。
  const fs = await import("node:fs");
  const path = await import("node:path");
  const root = path.resolve(process.cwd());
  const WRITERS = [
    "scripts/record-journal.ts",
    "src/lib/market/journal-merge.functions.ts",
    "scripts/backfill-exit-reason.ts",
  ];
  for (const rel of WRITERS) {
    const full = path.join(root, rel);
    if (!fs.existsSync(full)) continue; // 换机器/裁剪仓库时跳过，不假报
    const src = fs.readFileSync(full, "utf8");
    assert.match(src, /readUserBookWithVersion/, `${rel} 要用带版本的读`);
    assert.match(src, /expectedVersion/, `${rel} 写回必须带 expectedVersion`);
  }
});
