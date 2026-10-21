/**
 * 这个文件是干什么的：
 * AI 接口档案管理（data/ai-config.json）。从「单份三件套」升级成「多套档案 +
 * 启用一套」：DeepSeek、Ollama 本地、LM Studio、公司网关……填过的都留住，
 * 随时切换启用、编辑（key 留空 = 不换）、删除。所有闭环（因子层 / 策略层 /
 * 自动进化）只认**当前启用**的那一套。
 *
 * 你需要知道的：
 * 1. 文件格式：{ activeId: string | null, profiles: AIProfile[] }。读到旧格式
 *    （顶层 baseUrl/apiKey/model，没有 profiles 字段）自动当成一条「默认」档案，
 *    下次写回时完成迁移——老用户无感。
 * 2. apiKey 是密钥：服务端只回尾四位（profileStatus），完整值不出服务端；
 *    编辑时 key 留空 = 保留旧 key。
 * 3. 纯函数（upsert/remove/setActive）不碰 fs，直接单测；fs 包在最外层。
 * 4. data/ 在 .gitignore 里，CHIHENG_DATA_DIR 可换数据目录（测试靠它）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { referencePriceOf } from "./ai-prices.ts";
import type { AIConfig } from "./factor-queue.ts";

// ── 数据结构 ────────────────────────────────────────────────────

export type AIProfile = {
  /** slug（小写字母开头）。新建时生成，撞名自动加后缀。 */
  id: string;
  /** 给人看的名字，如「DeepSeek 官方」「本机 Ollama」。 */
  name: string;
  baseUrl: string;
  /** 完整 key 只存服务端。 */
  apiKey: string;
  model: string;
  updatedAt: string;
  /** 计价（可选，元/百万 tokens）：填了用量监控台才算费用，空 = 只统计 tokens 不算钱。 */
  pricePromptPerM?: number | null;
  priceCompletionPerM?: number | null;
};

export type AIProfilesFile = {
  activeId: string | null;
  profiles: AIProfile[];
};

// ── 纯函数：档案操作 ────────────────────────────────────────────

const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/;

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return ID_RE.test(base) ? base : "profile";
}

export type ProfileInput = {
  id?: string;
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 元/百万 tokens；空字符串/undefined = 清除计价（不算费用）。 */
  pricePromptPerM?: string;
  priceCompletionPerM?: string;
};

export type ProfileResult = { ok: true; file: AIProfilesFile; profile: AIProfile } | { ok: false; error: string };

function parsePrice(raw: string | undefined): number | null | "error" {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return "error";
  return n;
}

function validateInput(input: ProfileInput, existing: AIProfile[]): string | null {
  if (!input.name.trim()) return "名字不能空";
  if (!input.baseUrl.trim()) return "baseUrl 不能空";
  if (!input.model.trim()) return "model 不能空";
  if (existing.some((p) => p.name.trim() === input.name.trim() && p.id !== input.id)) return `名字「${input.name.trim()}」已存在`;
  if (parsePrice(input.pricePromptPerM) === "error") return "Prompt 单价要是非负数（元/百万 tokens），不填就不算费用";
  if (parsePrice(input.priceCompletionPerM) === "error") return "Completion 单价要是非负数（元/百万 tokens），不填就不算费用";
  return null;
}

/**
 * 新建或更新档案。新建（id 空）：生成 slug id，撞名加 -2/-3 后缀，第一条档案
 * 自动设为启用。更新：id 必须存在；apiKey 留空 = 保留旧 key。
 * 校验不过返回 ok:false 不写文件。返回新文件对象（不改入参）。
 */
export function upsertProfile(file: AIProfilesFile, input: ProfileInput, now: string): ProfileResult {
  const name = input.name.trim();
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const model = input.model.trim();
  const invalid = validateInput({ ...input, name, baseUrl, model }, file.profiles);
  if (invalid) return { ok: false, error: invalid };

  // 单价留空 → 按内置参考价目表自动填入（ai-prices.ts，2026-10 核对的官方价）。
  // 「只填 API key 就搞定」：价是可改的默认值，不是系统替你定价——用户随时
  // 能在弹窗里改成自己套餐的实际价。
  const ref = referencePriceOf(model);
  const pricePrompt = (parsePrice(input.pricePromptPerM) as number | null) ?? ref?.prompt ?? null;
  const priceCompletion = (parsePrice(input.priceCompletionPerM) as number | null) ?? ref?.completion ?? null;

  if (input.id) {
    const existing = file.profiles.find((p) => p.id === input.id);
    if (!existing) return { ok: false, error: `档案「${input.id}」不存在` };
    const updated: AIProfile = {
      ...existing,
      name,
      baseUrl,
      model,
      apiKey: input.apiKey.trim() || existing.apiKey,
      pricePromptPerM: pricePrompt,
      priceCompletionPerM: priceCompletion,
      updatedAt: now,
    };
    return {
      ok: true,
      file: { ...file, profiles: file.profiles.map((p) => (p.id === input.id ? updated : p)) },
      profile: updated,
    };
  }

  let id = slugify(name);
  for (let i = 2; file.profiles.some((p) => p.id === id); i++) id = `${slugify(name)}-${i}`;
  const profile: AIProfile = {
    id,
    name,
    baseUrl,
    apiKey: input.apiKey.trim(),
    model,
    pricePromptPerM: pricePrompt,
    priceCompletionPerM: priceCompletion,
    updatedAt: now,
  };
  return {
    ok: true,
    file: { activeId: file.activeId ?? id, profiles: [...file.profiles, profile] },
    profile,
  };
}

/** 删档案。删掉的是启用中的那套 → activeId 清空（闭环停在「未配置」而不是误用别家）。 */
export function removeProfile(file: AIProfilesFile, id: string): AIProfilesFile {
  const profiles = file.profiles.filter((p) => p.id !== id);
  return { activeId: profiles.some((p) => p.id === file.activeId) ? file.activeId : null, profiles };
}

/** 启用某套（id 必须在名单里）；传 null 停用全部。 */
export function setActiveProfile(file: AIProfilesFile, id: string | null): AIProfilesFile {
  if (id !== null && !file.profiles.some((p) => p.id === id)) return file;
  return { ...file, activeId: id };
}

/** 当前启用的档案 → 闭环用的三件套；没启用或档案没了 → null。 */
export function getActiveConfig(file: AIProfilesFile): AIConfig | null {
  const active = file.profiles.find((p) => p.id === file.activeId);
  if (!active || !active.baseUrl || !active.apiKey || !active.model) return null;
  return { baseUrl: active.baseUrl, apiKey: active.apiKey, model: active.model };
}

/** 给 UI 的状态：key 只回尾号；计价一并回（不是秘密，弹窗预填用）。 */
export function profileStatus(p: AIProfile): {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  keyTail: string;
  pricePromptPerM: number | null;
  priceCompletionPerM: number | null;
} {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    model: p.model,
    keyTail: p.apiKey.slice(-4),
    pricePromptPerM: p.pricePromptPerM ?? null,
    priceCompletionPerM: p.priceCompletionPerM ?? null,
  };
}

/** 当前启用档案的计价钱包（调用时做快照记进用量账）；没启用或没填价 → 相应字段 null。 */
export async function readActiveMeta(): Promise<{ profileId: string; pricePromptPerM: number | null; priceCompletionPerM: number | null } | null> {
  const { profiles, activeId } = await readProfiles();
  const active = profiles.find((p) => p.id === activeId);
  if (!active) return null;
  return { profileId: active.id, pricePromptPerM: active.pricePromptPerM ?? null, priceCompletionPerM: active.priceCompletionPerM ?? null };
}

// ── 文件 IO（node:fs，server-only）─────────────────────────────

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

const aiConfigPath = () => join(dataDir(), "ai-config.json");

/** 读档案。旧格式（顶层三件套、无 profiles）自动迁移成单档案；坏了 → 空档案夹。 */
export async function readProfiles(): Promise<AIProfilesFile> {
  try {
    const parsed = JSON.parse(await readFile(aiConfigPath(), "utf8")) as Partial<AIProfilesFile> & Partial<AIConfig>;
    if (Array.isArray(parsed.profiles)) {
      return { activeId: typeof parsed.activeId === "string" ? parsed.activeId : null, profiles: parsed.profiles as AIProfile[] };
    }
    // 旧格式迁移：顶层三件套齐全 → 一条「默认」档案并启用
    if (typeof parsed.baseUrl === "string" && typeof parsed.apiKey === "string" && typeof parsed.model === "string") {
      if (!parsed.baseUrl.trim() || !parsed.apiKey.trim() || !parsed.model.trim()) return { activeId: null, profiles: [] };
      const profile: AIProfile = {
        id: "default",
        name: "默认",
        baseUrl: parsed.baseUrl.trim().replace(/\/+$/, ""),
        apiKey: parsed.apiKey.trim(),
        model: parsed.model.trim(),
        updatedAt: new Date().toISOString(),
      };
      return { activeId: "default", profiles: [profile] };
    }
    return { activeId: null, profiles: [] };
  } catch {
    return { activeId: null, profiles: [] };
  }
}

export async function writeProfiles(file: AIProfilesFile): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(aiConfigPath(), JSON.stringify(file, null, 2));
}
