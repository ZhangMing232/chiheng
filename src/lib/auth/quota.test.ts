/** ai-quota 账本读失败必须 fail-closed（2026-11-16 修）。 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "quota-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    await fn(dir);
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
}

test("账本不存在 = 空表（新部署正常）", async () => {
  await withTempDir(async () => {
    const { readQuotaTable } = await import("./quota.ts");
    assert.deepEqual(await readQuotaTable(), {});
  });
});

test("账本损坏 = 抛错 fail-closed（不再静默放行）", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "ai-quota.json"), '{ "byUser": ');
    const { readQuotaTable } = await import("./quota.ts");
    await assert.rejects(readQuotaTable(), /额度账本|格式异常/);
  });
});

test("账本缺 byUser 字段 = 抛错", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "ai-quota.json"), '{"wrong":{}}');
    const { readQuotaTable } = await import("./quota.ts");
    await assert.rejects(readQuotaTable(), /额度账本|格式异常/);
  });
});

test("正常账本 = 读出 byUser", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "ai-quota.json"), JSON.stringify({ byUser: { u1: { day: "2026-11-16", evolve: 2, diagnose: 0 } } }));
    const { readQuotaTable } = await import("./quota.ts");
    const table = await readQuotaTable();
    assert.equal(table.u1.evolve, 2);
  });
});
