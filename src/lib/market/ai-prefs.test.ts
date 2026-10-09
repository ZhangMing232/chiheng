/**
 * 这个文件是干什么的：
 * 钉住 AI 偏好开关（data/ai-prefs.json）的读写约定：默认关、坏了回默认、
 * 写入只认布尔。autoEvolve 开着的时候，记账进程收盘后会每天自动跑一轮进化。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readAIPrefs, writeAIPrefs } from "@/lib/market/ai-prefs";

test("ai-prefs：不存在/坏文件/类型不对都回默认（关），读写往返", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-prefs-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    // 不存在 → 默认关
    assert.deepEqual(await readAIPrefs(), { autoEvolve: false });
    // 往返
    await writeAIPrefs({ autoEvolve: true });
    assert.deepEqual(await readAIPrefs(), { autoEvolve: true });
    // 文件坏了 → 默认关，不抛错
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(dir, "ai-prefs.json"), "not json");
    assert.deepEqual(await readAIPrefs(), { autoEvolve: false });
    // 字段类型不对 → 关
    await writeFile(join(dir, "ai-prefs.json"), JSON.stringify({ autoEvolve: "yes" }));
    assert.deepEqual(await readAIPrefs(), { autoEvolve: false });
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});
