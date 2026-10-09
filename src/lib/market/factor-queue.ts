/**
 * 这个文件是干什么的：
 * AI 因子管理的队列、配置和闭环运行器。三件事：
 *   1. **预登记待验队列**（data/factor-queue.json）——AI 或人提的新因子
 *      先登记方向/表达式/经济逻辑，状态 = 待验；回测跑完 6 关后更新状态；
 *      连续 2 次没过自动淘汰（tombstone），灰显不再跑。
 *   2. **AI 配置**（data/ai-config.json）——OpenAI 兼容接口的 baseUrl / apiKey /
 *      model 三件套，Ollama / LM Studio / DeepSeek 通吃。apiKey 是密钥：
 *      服务端只回尾四位，完整值不出服务端。
 *   3. **闭环运行器**——读最近一批 6 关判决 → 组成败因摘要喂给 AI →
 *      AI 返回结构化 JSON 新假设 → 校验（表达式过 factor-expr 白名单编译、
 *      id/name 不与现有重复、方向预注册）→ 进队列等下一次回测。
 *
 * 你需要知道的（权限边界，写死在代码里不是提示词约束）：
 * 1. AI **只许提议因子**，队列条目由本文件的校验函数把关；AI 不碰判决逻辑、
 *    不碰持仓下单、不碰策略参数。想改 6 关或交易，它没有任何代码路径。
 * 2. 表达式是 AI 产出进系统的**唯一**入口，进的是 factor-expr.ts 的白名单
 *    编译器——没有 eval，AI 写出「代码」也只是一段算不过编译的字符串。
 * 3. 「改假设直到过关」这条路被堵死：预登记一旦进队列，重跑只更新 failCount，
 *    方向/表达式不改（要改 = 新 id 重新登记，旧记录留档）。
 * 4. data/ 在 .gitignore 里；CHIHENG_DATA_DIR 可换数据目录（测试靠它），
 *    和 factor-runs-file.ts 同一约定。
 * 5. 纯逻辑（状态机、JSON 解析校验）是不依赖 fs/fetch 的纯函数，直接单测；
 *    fs 和 fetch 包在最外层。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateFactorExpr } from "./factor-expr.ts";
import { appendAILog, factorSelfHistory, readAILog } from "./ai-log.ts";
import type { Factor, MetricRow } from "./factors.ts";
import type { FactorRunRow } from "./factor-runs-file.ts";
import { GATE_KEYS } from "./factors-view.ts";

// ── 数据结构 ────────────────────────────────────────────────────

export type QueueStatus = "pending" | "tested" | "passed" | "tombstone";

/** 队列里的一条预登记因子。 */
export type QueueEntry = {
  /** 唯一 slug（小写字母开头）。AI 提的强制要求自带，撞名直接拒。 */
  id: string;
  name: string;
  category: Factor["category"];
  /** 预登记方向：+1 越大越好 / -1 越小越好。进队列后不许改。 */
  direction: 1 | -1;
  /** factor-expr 白名单表达式，如 "std20 / amp20"。 */
  expr: string;
  /** 经济逻辑，跑之前写死。 */
  rationale: string;
  source: "ai" | "manual";
  status: QueueStatus;
  /** 连续失败次数，满 TOMBSTONE_AFTER 淘汰。过关清零。 */
  failCount: number;
  /** 总共跑过几次（含 pass 的）。 */
  runs: number;
  createdAt: string;
  lastRunAt: string | null;
  /** tombstone 的原因等备注。 */
  note?: string;
};

export type QueuePayload = {
  entries: QueueEntry[];
  missing: string | null;
};

/** 回测跑完一轮后，单个队列因子的判决。 */
export type QueueVerdict = { id: string; passed: boolean; at: string };

/** 连续几次没过 6 关就淘汰。2 = 给「换行情环境再确认一次」的机会，也是上限。 */
export const TOMBSTONE_AFTER = 2;

// ── 纯函数：状态机 ──────────────────────────────────────────────

/**
 * 一轮回测跑完，把判决应用到队列上。返回**新数组**（不改入参）。
 * 规则：跑了 runs+1、记 lastRunAt；过 → status=passed、failCount 清零；
 * 挂 → failCount+1，满 TOMBSTONE_AFTER → tombstone 并写淘汰原因。
 * 没出现在 verdicts 里的条目（比如这批没跑它）原样保留。
 */
export function updateQueueAfterRun(queue: QueueEntry[], verdicts: QueueVerdict[]): QueueEntry[] {
  const byId = new Map(verdicts.map((v) => [v.id, v]));
  return queue.map((e) => {
    const v = byId.get(e.id);
    if (!v) return e;
    if (v.passed) {
      return { ...e, status: "passed", failCount: 0, runs: e.runs + 1, lastRunAt: v.at };
    }
    const failCount = e.failCount + 1;
    const tombstone = failCount >= TOMBSTONE_AFTER;
    return {
      ...e,
      status: tombstone ? "tombstone" : "tested",
      failCount,
      runs: e.runs + 1,
      lastRunAt: v.at,
      note: tombstone ? `连续 ${TOMBSTONE_AFTER} 次未过 6 关，自动淘汰` : e.note,
    };
  });
}

// ── 纯函数：AI 产出的解析与校验 ─────────────────────────────────

export type AIProposal = {
  id: string;
  name: string;
  category: string;
  direction: number;
  expr: string;
  rationale: string;
};

export type ProposalCheck = {
  accepted: Omit<QueueEntry, "status" | "failCount" | "runs" | "createdAt" | "lastRunAt">[];
  rejected: { proposal: unknown; reason: string }[];
};

const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const CATEGORIES: Factor["category"][] = ["动量", "反转", "波动率", "量能", "形态", "规模"];

function extractJsonArray(raw: string): unknown[] {
  // AI 可能包 ```json 围栏，取第一个 [ 到最后一个 ] 之间的内容解析。
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("AI 返回里没有 JSON 数组");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("AI 返回的 JSON 不是数组");
  return parsed;
}

/**
 * 把 AI 的原始返回变成队列条目。每一道校验不过都进 rejected 并写明原因——
 * AI 的产出**永远不直接信**：表达式要过白名单编译、id/name 不许撞已存在的
 * （注册表 FACTORS + 队列 + 本次批次内互相）、方向必须是 ±1、类别必须在词表里。
 */
export function parseAIProposals(
  raw: string,
  existing: { ids: Set<string>; names: Set<string> },
): ProposalCheck {
  let arr: unknown[];
  try {
    arr = extractJsonArray(raw);
  } catch (e) {
    return { accepted: [], rejected: [{ proposal: raw.slice(0, 200), reason: e instanceof Error ? e.message : String(e) }] };
  }
  const accepted: ProposalCheck["accepted"] = [];
  const rejected: ProposalCheck["rejected"] = [];
  const ids = new Set(existing.ids);
  const names = new Set(existing.names);
  for (const item of arr) {
    const p = item as Partial<AIProposal>;
    const fail = (reason: string) => rejected.push({ proposal: item, reason });
    if (typeof p?.id !== "string" || !ID_RE.test(p.id)) { fail("id 缺失或不合法（要小写字母开头的 slug）"); continue; }
    if (ids.has(p.id)) { fail(`id「${p.id}」已存在`); continue; }
    if (typeof p.name !== "string" || !p.name.trim()) { fail("name 缺失"); continue; }
    if (names.has(p.name.trim())) { fail(`名字「${p.name.trim()}」已存在`); continue; }
    // 弱模型爱自造组合类别（如「量能/反转」）：先取 "/" 前一段再看词表。
    // 类别只是元数据，取主类别不影响预登记的方向和经济逻辑。
    const category = typeof p.category === "string" ? p.category.split("/")[0].trim() : "";
    if (!CATEGORIES.includes(category as Factor["category"])) { fail(`类别「${String(p.category)}」不在词表（动量/反转/波动率/量能/形态/规模）`); continue; }
    if (p.direction !== 1 && p.direction !== -1) { fail("direction 必须是 1 或 -1"); continue; }
    if (typeof p.expr !== "string") { fail("expr 缺失"); continue; }
    const compiled = validateFactorExpr(p.expr);
    if (!compiled.ok) { fail(`表达式不过编译：${compiled.error}`); continue; }
    if (typeof p.rationale !== "string" || p.rationale.trim().length < 10) { fail("rationale（经济逻辑）太短，少于 10 字"); continue; }
    ids.add(p.id);
    names.add(p.name.trim());
    accepted.push({
      id: p.id,
      name: p.name.trim(),
      category: category as Factor["category"],
      direction: p.direction,
      expr: p.expr,
      rationale: p.rationale.trim(),
      source: "ai",
    });
  }
  return { accepted, rejected };
}

// ── 纯函数：组 Prompt ───────────────────────────────────────────

/** 把最新一批判决压成给 AI 的败因摘要。数字原样来自日志，不加工。
 *  history = AI 自己之前提议的下场（factorSelfHistory 产物），给了就加一段
 *  自我反馈——自我进化的核心：让它读到自己的历史成败再提下一轮。 */
export function buildPrompt(rows: FactorRunRow[], history?: string[]): string {
  const lines = rows.map((r) => {
    const failed = GATE_KEYS.filter((k) => r.gates[k] === false).map((k) => k.toUpperCase());
    const buckets = r.bucketMeans.map((v) => `${(v * 100).toFixed(2)}%`).join(" → ");
    return (
      `- ${r.name}（${r.factor}）：方向${r.direction > 0 ? "正向" : "反向"}，t=${r.t.toFixed(2)}，` +
      `${failed.length === 0 ? "6 关全过" : `败于 ${failed.join("/")}`}。五档超额（低到高）：${buckets}`
    );
  });
  return [
    "你在管理一个 A 股量化项目的因子研究队列。下面是最近一轮因子检验的判决（t 日收盘排序，次日开盘等权买入，持有 N 天后收盘卖出，收益减同期全池）。",
    "",
    "检验铁律（你的提议必须遵守）：",
    "1. 每个因子必须预登记方向和经济逻辑，不许看结果反推。",
    "2. 因子只允许用给定指标字段做四则运算，函数只能用 abs/log/sqrt。不要发明新指标。",
    "3. 优先针对败因提假设：时段翻号的要想「什么条件下它才成立」；形状和方向不符的按真实形状重新立方向；全灭的维度别再试微调。",
    "4. 不许提议和现有因子逻辑等价的换皮（比如换个窗口再测一遍 d60）。",
    "5. 提 1~3 个你最看好的，宁缺毋滥。每个给：id（小写字母开头 slug）、name（中文名）、category（只能填一个词，从这六个里选：动量 / 反转 / 波动率 / 量能 / 形态 / 规模。不要自造组合类别，「量能/反转」这种会被拒）、direction（1 或 -1）、expr（表达式）、rationale（经济逻辑，一两句）。",
    "",
    "最近一轮判决：",
    ...lines,
    ...(history && history.length > 0
      ? ["", "你自己之前几轮提议的下场（据此纠错：别再提已淘汰方向的微调变体；已过关的想想下一个相邻假设；总被拒的先检查表达式合规）：", ...history]
      : []),
    "",
    "只输出 JSON 数组，不要输出任何别的文字。",
  ].join("\n");
}

// ── 文件 IO（node:fs，server-only）─────────────────────────────

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

const queuePath = () => join(dataDir(), "factor-queue.json");

/** 读队列。文件不存在或坏了 → 空队列 + missing 原因，绝不抛错（prefs-file 同一取舍）。 */
export async function readQueue(): Promise<QueuePayload> {
  try {
    const parsed = JSON.parse(await readFile(queuePath(), "utf8")) as { entries?: unknown };
    const entries = Array.isArray(parsed.entries) ? (parsed.entries as QueueEntry[]) : [];
    return { entries, missing: null };
  } catch (error) {
    return { entries: [], missing: `factor-queue.json 读不到（${(error as Error).message}）` };
  }
}

export async function writeQueue(entries: QueueEntry[]): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(queuePath(), JSON.stringify({ entries }, null, 2));
}

/** 队列里还活着的因子（pending/tested/passed）编译成回测用的 Factor，附加在 FACTORS 后面。tombstone 不跑。 */
export async function loadQueueFactors(): Promise<Factor[]> {
  const { entries } = await readQueue();
  const out: Factor[] = [];
  for (const e of entries) {
    if (e.status === "tombstone") continue;
    const compiled = validateFactorExpr(e.expr);
    if (!compiled.ok) continue; // 登记后白名单没变过；万一变了，跳过而不是炸掉整轮回测
    const get = compiled.get as (m: MetricRow) => number | null;
    out.push({ id: e.id, name: e.name, category: e.category, direction: e.direction, rationale: e.rationale, get });
  }
  return out;
}

/** 跑完一轮回测后更新队列状态。 */
export async function applyVerdictsToQueue(verdicts: QueueVerdict[]): Promise<void> {
  const { entries } = await readQueue();
  await writeQueue(updateQueueAfterRun(entries, verdicts));
}

// ── AI 配置 ─────────────────────────────────────────────────────

export type AIConfig = { baseUrl: string; apiKey: string; model: string };

/**
 * 读当前启用的 AI 配置（多套档案里启用那一套的三件套）。
 * 档案的增删改切在 ai-profiles.ts；这里只取闭环要用的生效配置。
 */
export async function readAIConfig(): Promise<AIConfig | null> {
  const { getActiveConfig, readProfiles } = await import("./ai-profiles.ts");
  return getActiveConfig(await readProfiles());
}

// ── AI 调用（OpenAI 兼容 /chat/completions）────────────────────

/** 调用方信息：记进 token 用量账（ai-usage.json），让监控台知道是哪条链路烧的、按什么价算钱。 */
export type AIMeta = {
  layer?: string;
  trigger?: "manual" | "auto" | "test";
  profileId?: string | null;
  pricePromptPerM?: number | null;
  priceCompletionPerM?: number | null;
};

/** OpenAI 兼容 /chat/completions 调用。factor 层和 strategy 层共用。
 *  每次调用的 token 用量 + 计价钱包快照自动记进 ai-usage.json，调用方不用管。 */
export async function callAI(config: AIConfig, prompt: string, meta: AIMeta = {}): Promise<string> {
  const { costOfTokens } = await import("./ai-usage.ts");
  const ctrl = new AbortController();
  // 90s 不够：deepseek-flash 多数 17~37s，但长 prompt + 自我历史偶尔超 90s 被掐，
  // 自动进化在收盘后跑，多等一分钟换不白跑一趟。
  const timer = setTimeout(() => ctrl.abort(), 150_000);
  const started = Date.now();
  try {
    const res = await fetch(`${config.baseUrl}/chat/completions`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.2,
        messages: [
          { role: "system", content: "你是一个严谨的量化研究助理。只输出要求的 JSON，不输出别的。" },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) throw new Error(`AI 接口 HTTP ${res.status}：${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) throw new Error("AI 返回里没有内容");
    // token 用量记账：字段缺失记 0 不瞎编；写失败不炸调用。
    const usage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    };
    const { appendAIUsage } = await import("./ai-usage.ts");
    await appendAIUsage({
      at: new Date().toISOString(),
      layer: meta.layer ?? "unknown",
      trigger: meta.trigger ?? "manual",
      model: config.model,
      profileId: meta.profileId ?? null,
      pricePromptPerM: meta.pricePromptPerM ?? null,
      priceCompletionPerM: meta.priceCompletionPerM ?? null,
      ...usage,
      cost: costOfTokens(usage.promptTokens, usage.completionTokens, meta.pricePromptPerM ?? null, meta.priceCompletionPerM ?? null),
      ms: Date.now() - started,
      ok: true,
    });
    return content;
  } catch (error) {
    // 失败也记账：HTTP 状态 / 超时 / 空返回都落进流水（error 字段），
    // 监控台能直接看到「401 → 去换 key / 充值」而不是一个干巴巴的「失败」。
    const reason = error instanceof Error ? error.message : String(error);
    const { appendAIUsage } = await import("./ai-usage.ts");
    await appendAIUsage({
      at: new Date().toISOString(),
      layer: meta.layer ?? "unknown",
      trigger: meta.trigger ?? "manual",
      model: config.model,
      profileId: meta.profileId ?? null,
      pricePromptPerM: meta.pricePromptPerM ?? null,
      priceCompletionPerM: meta.priceCompletionPerM ?? null,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      cost: 0,
      ms: Date.now() - started,
      ok: false,
      error: reason,
    });
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export type AILoopResult = {
  ok: boolean;
  proposed: number;
  rejected: number;
  rejectReasons: string[];
  error?: string;
};

/**
 * 闭环跑一轮：读配置 → 读最近判决 + 自我历史 → 组 prompt → 调 AI → 校验 → 进队列。
 * 任何一步失败返回 ok:false + 原因，**不写队列**（半吊子结果不入账）；
 * 但每轮都写 ai-log 账本（含失败），这是自我进化的记忆。
 */
export async function runFactorAILoop(
  deps: { readRows: () => Promise<{ batch: { rows: FactorRunRow[] } | null }>; existingFactors: { id: string; name: string }[] },
  trigger: "manual" | "auto" = "manual",
): Promise<AILoopResult> {
  const config = await readAIConfig();
  if (!config) {
    const result: AILoopResult = { ok: false, proposed: 0, rejected: 0, rejectReasons: [], error: "AI 接口还没配置（填 baseUrl / apiKey / model）" };
    await appendAILog({ at: new Date().toISOString(), layer: "factor", trigger, ...result, proposed: [], rejected: [] });
    return result;
  }
  const runs = await deps.readRows();
  if (!runs.batch || runs.batch.rows.length === 0) {
    const result: AILoopResult = { ok: false, proposed: 0, rejected: 0, rejectReasons: [], error: "没有因子判决数据，先跑一轮 BT_FACTOR=1 回测" };
    await appendAILog({ at: new Date().toISOString(), layer: "factor", trigger, ...result, proposed: [], rejected: [] });
    return result;
  }
  const { entries } = await readQueue();
  const history = factorSelfHistory(await readAILog(), entries);
  let raw: string;
  try {
    const { readActiveMeta } = await import("./ai-profiles.ts");
    raw = await callAI(config, buildPrompt(runs.batch.rows, history), { layer: "factor", trigger, ...(await readActiveMeta()) });
  } catch (error) {
    const result: AILoopResult = { ok: false, proposed: 0, rejected: 0, rejectReasons: [], error: error instanceof Error ? error.message : String(error) };
    await appendAILog({ at: new Date().toISOString(), layer: "factor", trigger, ...result, proposed: [], rejected: [] });
    return result;
  }
  const ids = new Set([...deps.existingFactors.map((f) => f.id), ...entries.map((e) => e.id)]);
  const names = new Set([...deps.existingFactors.map((f) => f.name), ...entries.map((e) => e.name)]);
  const { accepted, rejected } = parseAIProposals(raw, { ids, names });
  if (accepted.length > 0) {
    const now = new Date().toISOString();
    await writeQueue([
      ...entries,
      ...accepted.map((a) => ({ ...a, status: "pending" as const, failCount: 0, runs: 0, lastRunAt: null, createdAt: now })),
    ]);
  }
  const result: AILoopResult = { ok: true, proposed: accepted.length, rejected: rejected.length, rejectReasons: rejected.map((r) => r.reason).slice(0, 5) };
  await appendAILog({
    at: new Date().toISOString(),
    layer: "factor",
    trigger,
    ...result,
    proposed: accepted.map((a) => ({ id: a.id, name: a.name })),
    rejected: result.rejectReasons,
  });
  return result;
}

/** 给 UI 的状态配置：校验 aiKey 不出口，只回尾号。 */
export async function aiStatus(config: AIConfig | null): Promise<{ configured: boolean; baseUrl: string | null; model: string | null; keyTail: string | null }> {
  if (!config) return { configured: false, baseUrl: null, model: null, keyTail: null };
  return { configured: true, baseUrl: config.baseUrl, model: config.model, keyTail: config.apiKey.slice(-4) };
}
