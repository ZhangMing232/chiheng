/**
 * 这个文件是干什么的：
 * 钉住 AI 接口档案管理（ai-profiles.ts）的约定——旧格式迁移、建档（id 生成/
 * 撞名后缀/第一条自动启用）、更新（key 留空保留）、删除（删启用中的清空
 * activeId）、启用切换、三件套取用。
 *
 * 为什么值得钉：
 * 1. 迁移是单向门：老用户文件是顶层 {baseUrl, apiKey, model}，读错就是把人
 *    的配置当空的，闭环静默不跑。
 * 2. 删启用中的档案必须让 activeId 落空而不是漂到别家——误用别家 key 调接口
 *    是钱和泄密的双重事故。
 * 3. 编辑时 key 留空 = 保留旧 key：弹窗密码框的占位语义要钉死，不然每次改个
 *    模型名就把 key 清掉。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  upsertProfile,
  removeProfile,
  setActiveProfile,
  getActiveConfig,
  profileStatus,
  readProfiles,
  writeProfiles,
  type AIProfilesFile,
} from "@/lib/market/ai-profiles";

const NOW = "2026-10-09T08:00:00.000Z";
const EMPTY: AIProfilesFile = { activeId: null, profiles: [] };

function input(partial: Partial<{ id: string; name: string; baseUrl: string; apiKey: string; model: string }> = {}) {
  return { id: undefined as string | undefined, name: "测试", baseUrl: "https://api.example.com/v1", apiKey: "sk-test", model: "m1", ...partial };
}

// ── 建档 ────────────────────────────────────────────────────────

test("建档：生成 slug id，第一条自动启用；id 撞名自动加后缀（名字本身不许撞）", () => {
  const r1 = upsertProfile(EMPTY, input({ name: "DeepSeek 官方" }), NOW);
  assert.ok(r1.ok);
  if (!r1.ok) return;
  assert.equal(r1.profile.id, "deepseek");
  assert.equal(r1.file.activeId, "deepseek");
  // 名字不同但 slug 相同（大小写/符号差异）→ id 加后缀
  const r2 = upsertProfile(r1.file, input({ name: "deepseek", baseUrl: "https://other/v1" }), NOW);
  assert.ok(r2.ok);
  if (!r2.ok) return;
  assert.equal(r2.profile.id, "deepseek-2");
  assert.equal(r2.file.activeId, "deepseek");
  // 名字直接重复 → 拒
  const dup = upsertProfile(r1.file, input({ name: "DeepSeek 官方", apiKey: "sk-other" }), NOW);
  assert.equal(dup.ok, false);
});

test("建档：校验名字/baseUrl/model 不能空，名字不许撞", () => {
  assert.deepEqual(upsertProfile(EMPTY, input({ name: "  " }), NOW).ok, false);
  assert.deepEqual(upsertProfile(EMPTY, input({ baseUrl: "" }), NOW).ok, false);
  assert.deepEqual(upsertProfile(EMPTY, input({ model: "" }), NOW).ok, false);
  const r = upsertProfile(EMPTY, input({ name: "甲" }), NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  const dup = upsertProfile(r.file, input({ name: "甲", apiKey: "sk-other" }), NOW);
  assert.equal(dup.ok, false);
});

// ── 更新 ────────────────────────────────────────────────────────

test("更新：key 留空保留旧 key，填了新 key 才换；baseUrl 去尾斜杠", () => {
  const created = upsertProfile(EMPTY, input({ name: "local", baseUrl: "http://localhost:11434/v1/" }), NOW);
  assert.ok(created.ok);
  if (!created.ok) return;
  const kept = upsertProfile(created.file, { id: "local", name: "local", baseUrl: "http://localhost:11434/v1/", apiKey: "  ", model: "qwen3" }, NOW);
  assert.ok(kept.ok);
  if (!kept.ok) return;
  assert.equal(kept.profile.apiKey, "sk-test");
  assert.equal(kept.profile.model, "qwen3");
  const swapped = upsertProfile(created.file, { id: "local", name: "local", baseUrl: "http://x/v1", apiKey: "sk-new", model: "qwen3" }, NOW);
  assert.ok(swapped.ok);
  if (!swapped.ok) return;
  assert.equal(swapped.profile.apiKey, "sk-new");
  assert.equal(upsertProfile(EMPTY, { id: "ghost", name: "甲", baseUrl: "u", apiKey: "k", model: "m" }, NOW).ok, false);
});

// ── 删除 / 启用 ─────────────────────────────────────────────────

test("删除：删掉启用中的档案后 activeId 清空；删除不改入参", () => {
  const a = upsertProfile(EMPTY, input({ name: "alpha" }), NOW);
  const b = a.ok && upsertProfile(a.file, input({ name: "beta", apiKey: "sk-2" }), NOW);
  assert.ok(b && b.ok);
  if (!b || !b.ok) return;
  const removed = removeProfile(b.file, "alpha");
  assert.equal(removed.activeId, null);
  assert.equal(removed.profiles.length, 1);
  assert.equal(b.file.profiles.length, 2, "入参不该被改");
});

test("启用：切到别家、传 null 停用、不存在的 id 原样返回", () => {
  const a = upsertProfile(EMPTY, input({ name: "alpha" }), NOW);
  const b = a.ok && upsertProfile(a.file, input({ name: "beta", apiKey: "sk-2" }), NOW);
  assert.ok(b && b.ok);
  if (!b || !b.ok) return;
  const switched = setActiveProfile(b.file, "beta");
  assert.equal(switched.activeId, "beta");
  assert.deepEqual(getActiveConfig(switched), { baseUrl: "https://api.example.com/v1", apiKey: "sk-2", model: "m1" });
  assert.equal(setActiveProfile(switched, null).activeId, null);
  assert.equal(getActiveConfig(setActiveProfile(switched, null)), null);
  assert.equal(setActiveProfile(switched, "ghost").activeId, "beta");
});

// ── 读写 + 旧格式迁移 ───────────────────────────────────────────

test("profileStatus：key 只回尾号", () => {
  const r = upsertProfile(EMPTY, input({ apiKey: "sk-abcdef123456" }), NOW);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(profileStatus(r.profile).keyTail, "3456");
});

test("读写往返；旧格式（顶层三件套）读时迁移成单档案并启用", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ai-profiles-"));
  const prev = process.env.CHIHENG_DATA_DIR;
  process.env.CHIHENG_DATA_DIR = dir;
  try {
    // 旧格式
    await writeFile(join(dir, "ai-config.json"), JSON.stringify({ baseUrl: "https://old/v1", apiKey: "sk-old", model: "old-m" }));
    const migrated = await readProfiles();
    assert.equal(migrated.activeId, "default");
    assert.equal(migrated.profiles.length, 1);
    assert.equal(migrated.profiles[0].name, "默认");
    assert.deepEqual(getActiveConfig(migrated), { baseUrl: "https://old/v1", apiKey: "sk-old", model: "old-m" });
    // 写回即完成迁移，再读是新格式
    await writeProfiles(migrated);
    assert.equal((await readProfiles()).profiles[0].id, "default");
    // 空对象 / 坏文件 → 空档案夹
    await writeFile(join(dir, "ai-config.json"), "{}");
    assert.deepEqual(await readProfiles(), { activeId: null, profiles: [] });
    await writeFile(join(dir, "ai-config.json"), "not json");
    assert.deepEqual(await readProfiles(), { activeId: null, profiles: [] });
  } finally {
    if (prev === undefined) delete process.env.CHIHENG_DATA_DIR;
    else process.env.CHIHENG_DATA_DIR = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test("计价：单价可选、校验非负、编辑时预填留空会清除", () => {
  // 建档带价
  const created = upsertProfile(EMPTY, { ...input({ name: "priced" }), pricePromptPerM: "2", priceCompletionPerM: "8" }, NOW);
  assert.ok(created.ok);
  if (!created.ok) return;
  assert.equal(created.profile.pricePromptPerM, 2);
  assert.equal(created.profile.priceCompletionPerM, 8);
  assert.deepEqual(profileStatus(created.profile).pricePromptPerM, 2);
  // 不填价 → null
  const free = upsertProfile(EMPTY, input({ name: "free" }), NOW);
  assert.ok(free.ok);
  if (!free.ok) return;
  assert.equal(free.profile.pricePromptPerM ?? null, null);
  // 负价 / 非数 → 拒
  assert.equal(upsertProfile(EMPTY, { ...input({ name: "neg" }), pricePromptPerM: "-1" }, NOW).ok, false);
  assert.equal(upsertProfile(EMPTY, { ...input({ name: "nan" }), priceCompletionPerM: "abc" }, NOW).ok, false);
  // 编辑：预填后再留空 = 清除计价
  const cleared = upsertProfile(created.file, { id: "priced", name: "priced", baseUrl: "u", apiKey: "", model: "m", pricePromptPerM: "", priceCompletionPerM: "" }, NOW);
  assert.ok(cleared.ok);
  if (!cleared.ok) return;
  assert.equal(cleared.profile.pricePromptPerM, null);
  assert.equal(cleared.profile.priceCompletionPerM, null);
});
