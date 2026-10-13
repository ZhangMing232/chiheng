/**
 * 这个文件是干什么的：
 * 钉住备份加固的三条——**失败不抛、坏备份不留、轮换清理**。
 *
 * 「失败不抛」是命脉：备份失败拖着记账进程一起死，等于为了冗余杀了主流程。
 * 「坏备份不留」对应：复制到一半的 JSON 比没备份更危险——它顶着备份的名字。
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backupJournal, countBackups, latestBackupDate, pruneBackups, verifyBackup } from "@/lib/market/journal-backup";

function sandbox(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "chiheng-bk-root-"));
  const home = mkdtempSync(join(tmpdir(), "chiheng-bk-home-"));
  mkdirSync(join(root, "data", "books"), { recursive: true });
  return { root, home };
}

function writeBook(root: string, userId = "u1", trades = 3) {
  writeFileSync(join(root, "data", "books", `${userId}.json`), JSON.stringify({ trades: Array.from({ length: trades }, (_, i) => ({ id: i })) }), "utf-8");
}

test("备份成功：目录里出现当天那份", async () => {
  const { root, home } = sandbox();
  try {
    writeBook(root);
    const r = await backupJournal("u1", "2026-10-13", root, home);
    assert.equal(r.ok, true);
    assert.equal(await countBackups("u1", home), 1);
    assert.equal(await latestBackupDate("u1", home), "2026-10-13");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("账本不存在 → 幂等成功（没账本没什么可备）", async () => {
  const { root, home } = sandbox();
  try {
    const r = await backupJournal("u1", "2026-10-13", root, home);
    assert.equal(r.ok, true);
    assert.equal(await countBackups("u1", home), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("🔴 备份失败不抛（原版会拖着记账进程死）", async () => {
  // 造一个「复制到一半」的场景：源是目录而不是文件 → copyFile 抛错
  const { root, home } = sandbox();
  try {
    mkdirSync(join(root, "data", "books", "u1.json")); // 源是目录
    const r = await backupJournal("u1", "2026-10-13", root, home);
    assert.equal(r.ok, false, "失败要如实报");
    assert.ok(r.reason, "带原因");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("坏备份校验：不是可解析 JSON → 删除坏文件、报失败", async () => {
  const { root, home } = sandbox();
  try {
    // 直接写一份坏备份到备份目录
    const dir = join(home, "chiheng-backup", "u1");
    mkdirSync(dir, { recursive: true });
    const bad = join(dir, "journal-2026-10-13.json");
    writeFileSync(bad, "{ 坏 JSON 复制到一半", "utf-8");
    assert.equal(await verifyBackup(bad), false);
    // 再跑一次正常备份（源是好的）→ 应该覆盖成功
    writeBook(root);
    const r = await backupJournal("u1", "2026-10-13", root, home);
    assert.equal(r.ok, true, "好账本覆盖坏备份");
    assert.equal(await verifyBackup(bad), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("轮换：超出 keepDays 的清理，保留新的", async () => {
  const { root, home } = sandbox();
  try {
    writeBook(root);
    for (const d of ["2026-09-01", "2026-09-15", "2026-10-01", "2026-10-13"]) {
      await backupJournal("u1", d, root, home);
    }
    assert.equal(await countBackups("u1", home), 4);
    const removed = await pruneBackups("u1", 2, home);
    assert.equal(removed, 2, "清掉最旧两份");
    assert.equal(await countBackups("u1", home), 2);
    assert.equal(await latestBackupDate("u1", home), "2026-10-13", "新的留住");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
});

test("prune 失败不抛（目录不存在）", async () => {
  const home = mkdtempSync(join(tmpdir(), "chiheng-bk-empty-"));
  try {
    assert.equal(await pruneBackups("nobody", 30, home), 0);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("verifyBackup：有 trades/entries/days 任一就算可解析", async () => {
  const home = mkdtempSync(join(tmpdir(), "chiheng-bk-v-"));
  try {
    for (const [name, content, ok] of [
      ["a.json", '{"trades":[]}', true],
      ["b.json", '{"entries":[]}', true],
      ["c.json", '{"days":[]}', true],
      ["d.json", '{"other":1}', false],
      ["e.json", "不是 JSON", false],
    ] as const) {
      const p = join(home, name);
      writeFileSync(p, content, "utf-8");
      assert.equal(await verifyBackup(p), ok, name);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
