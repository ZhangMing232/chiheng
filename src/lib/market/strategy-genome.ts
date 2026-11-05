/**
 * 这个文件是干什么的：
 * 「策略基因组」轨道——失败驱动的**策略级**进化。和冠军-挑战者（只拧三个出场旋钮、
 * 选股名单锁死）是两条平行的轨道：这条出产的不是参数变体，而是**全新或更新的
 * 策略 spec**（选股条件 + 排序 + 定价形状/表达式 + 持有/止损/目标）。
 *
 * 为什么需要它（用户原话）：原来「来来回回就那几个、调几个微不足道的参数不断的跑」
 * 是结构性的——挑战者通道在架构上就改不了「买什么」。这条轨道补上「失败 →
 * 更新/全新策略」这一层。两条轨道并存：旧的参数挑战者保留干净归因，新的基因组
 * 轨道负责真正的策略演化。
 *
 * 你需要知道的（纪律）：
 * 1. **新 spec 照样先过 6 关 + 聚类 t≥2 才许上线**（STRATEGY-GEN2 §2.1 铁律）。
 *    AI 提的只是候选，判决和换算都不在它手里——它碰不到线上冠军参数、碰不到
 *    6 关判决函数。这条轨道不破坏旧通道的验证闸门。
 * 2. **近亲封禁 + 同家族封禁**：新 spec 的选股逻辑（select 条件抽出的
 *    变量×运算符签名）若和已有 spec 或**已淘汰 spec**高度重合，直接拒——这正是
 *    治「换汤不换药」的核心手段。AI 拿到死因档案，被明确要求「换正交思路，别微调近亲」。
 * 3. 表达式走 factor-expr 的 spec 编译器（白名单 + 比较运算），没有 eval。
 *    选股条件用比较运算写（如 "pe <= 18"），求值 === 1 才入选。
 * 4. 数据在 data/strategy-genome.json（在 .gitignore 里，换机器重跑）。
 */

import { readFile } from "node:fs/promises";
import { compileSpecExpr, SPEC_EXPR_VARS } from "./factor-expr.ts";
import { SPEC_JUDGEABLE_VARS, SPEC_UNAVAILABLE, specVarsUsed } from "./spec-backtest.ts";
import type { StrategySpec } from "./strategies.ts";
import { readChallengers } from "./challenger.ts";
import { readQueue, callAIWithFallback, readAIConfig } from "./factor-queue.ts";
import { readTombstones } from "./factor-tombstones.ts";
import { readStrategyGates } from "./strategy-gate.ts";
import { appendAILog } from "./ai-log.ts";
import { RED_LINE_PROMPT } from "./red-line.ts";

const fsApi = () => import("node:fs/promises");
const posixJoin = (...parts: string[]): string => parts.join("/");

export type GenomeStatus = "proposed" | "testing" | "promoted" | "rejected" | "tombstone";

/** 一套候选策略 spec，带进化轨道自己的状态机。 */
export type GenomeCandidate = StrategySpec & {
  status: GenomeStatus;
  since: string;
  source: "ai" | "manual";
  /** 来自哪次失败死因（post-mortem 溯源），调试/复盘用。 */
  fromFailure?: string;
  /** 若被 6 关/回测淘汰，记败在哪。 */
  failedGates?: string[];
  /** 最近一次判决的数字（页面展示用，不参与判决逻辑）。见 genome-verdict.ts。 */
  verdict?: {
    at: string;
    trades: number;
    excessPp: number | null;
    clusteredT: number | null;
    halvesSameSign: boolean | null;
    reason: string;
  };
  note?: string;
};

export type GenomeFile = { list: GenomeCandidate[] };

export type GenomeLoopResult = {
  ok: boolean;
  proposed: number;
  rejected: number;
  rejectReasons: string[];
  error?: string;
};

const dataDir = () => process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data");
export const genomePath = () => posixJoin(dataDir(), "strategy-genome.json");

export async function readGenome(): Promise<GenomeFile> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(genomePath(), "utf8"));
    if (parsed && Array.isArray(parsed.list)) return parsed as GenomeFile;
  } catch {
    // 没有文件 = 还没有基因组候选，正常。
  }
  return { list: [] };
}

export async function writeGenome(file: GenomeFile) {
  const { mkdir, writeFile } = await fsApi();
  await mkdir(dataDir(), { recursive: true });
  await writeFile(genomePath(), JSON.stringify(file, null, 2));
}

// ── 近亲 / 同家族封禁 ──────────────────────────────────────────────

/**
 * 从 spec 抽出「选股逻辑签名」：每条 select 条件里的 变量×运算符 对，加上 rankBy
 * 用到的变量。用来判断两个 spec 是不是「同一套选股思路的不同常数」。
 */
export function specSignature(spec: StrategySpec): string[] {
  const tokens = new Set<string>();
  for (const cond of spec.select) {
    const vars = cond.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
    const ops = cond.match(/<=|>=|==|!=|[<>]/g) ?? [];
    for (const v of vars) {
      // 只收白名单里的变量，函数名/常数不算
      if ((SPEC_EXPR_VARS as readonly string[]).includes(v)) {
        for (const op of ops) tokens.add(`${v}${op}`);
      }
    }
  }
  const rankVars = spec.rankBy.match(/[a-zA-Z_][a-zA-Z0-9_]*/g) ?? [];
  for (const v of rankVars) if ((SPEC_EXPR_VARS as readonly string[]).includes(v)) tokens.add(`rank:${v}`);
  return [...tokens].sort();
}

/** 两个签名的交集大小 / 较大签名大小（0~1）。越大越像同一思路。 */
export function signatureOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setB = new Set(b);
  const shared = a.filter((t) => setB.has(t)).length;
  return shared / Math.max(a.length, b.length);
}

/** 候选 spec 的选股签名是否和已有/已淘汰 spec 近亲（重叠超阈值）。 */
export function isNearTwin(
  candidate: StrategySpec,
  existing: StrategySpec[],
  threshold = 0.6,
): { twin: boolean; withId?: string; overlap: number } {
  const sig = specSignature(candidate);
  let best = 0;
  let bestId: string | undefined;
  for (const e of existing) {
    const o = signatureOverlap(sig, specSignature(e));
    if (o > best) {
      best = o;
      bestId = e.id;
    }
  }
  return { twin: best >= threshold, withId: bestId, overlap: best };
}

// ── 纯函数：校验 AI 产出 ───────────────────────────────────────────

export type GenomeProposal = StrategySpec & { rationale: string };

const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;
const PRICING_SHAPES = ["spot", "prevPct", "peAnchor", "breakout", "expr"] as const;

function exprOk(src: string): boolean {
  try {
    compileSpecExpr(src);
    return true;
  } catch {
    return false;
  }
}

function pricingOk(p: StrategySpec["pricing"]): string | null {
  if (!PRICING_SHAPES.includes(p.shape)) return `定价形状「${p.shape}」不在白名单（${PRICING_SHAPES.join("/")}）`;
  if (p.shape === "expr" && !p.buyExpr) return "expr 形状必须给 buyExpr";
  if (p.shape === "expr" && p.buyExpr && !exprOk(p.buyExpr)) return `buyExpr 不过编译：${p.buyExpr}`;
  if (p.shape === "expr" && p.sellExpr && !exprOk(p.sellExpr)) return `sellExpr 不过编译：${p.sellExpr}`;
  if (p.shape === "expr" && p.stopExpr && !exprOk(p.stopExpr)) return `stopExpr 不过编译：${p.stopExpr}`;
  if (p.shape === "peAnchor" && (p.buyPe == null || p.sellPe == null || p.stopPe == null)) return "peAnchor 必须给 buyPe/sellPe/stopPe";
  if ((p.shape === "prevPct" || p.shape === "breakout") && p.pct == null) return `${p.shape} 必须给 pct`;
  return null;
}

export type GenomeCheck = {
  accepted: (GenomeProposal & { fromFailure?: string })[];
  rejected: { proposal: unknown; reason: string }[];
};

export function parseGenomeProposals(
  raw: string,
  existing: GenomeCandidate[],
  /** 已淘汰 spec 的签名——近亲直接拒，避免「死了又提一模一样的」。 */
  deadSpecs: StrategySpec[] = [],
): GenomeCheck {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return { accepted: [], rejected: [{ proposal: raw.slice(0, 200), reason: "AI 返回里没有 JSON 数组" }] };
  }
  let arr: unknown[];
  try {
    arr = JSON.parse(raw.slice(start, end + 1)) as unknown[];
  } catch (e) {
    return { accepted: [], rejected: [{ proposal: raw.slice(0, 200), reason: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }] };
  }
  const accepted: GenomeCheck["accepted"] = [];
  const rejected: GenomeCheck["rejected"] = [];
  const ids = new Set(existing.map((c) => c.id));
  const allSpecsForTwin = [...existing, ...deadSpecs];
  for (const item of arr) {
    const p = item as Partial<GenomeProposal>;
    const fail = (reason: string) => rejected.push({ proposal: item, reason });
    if (typeof p?.id !== "string" || !ID_RE.test(p.id)) { fail("id 缺失或不合法（要小写字母开头的 slug）"); continue; }
    if (ids.has(p.id)) { fail(`id「${p.id}」已存在`); continue; }
    if (typeof p.name !== "string" || p.name.trim().length < 2) { fail("name 缺失或太短"); continue; }
    if (!Array.isArray(p.select) || p.select.length === 0) { fail("select 必须是非空数组"); continue; }
    if (typeof p.rankBy !== "string" || !exprOk(p.rankBy)) { fail("rankBy 缺失或不过编译"); continue; }
    for (const cond of p.select) {
      if (typeof cond !== "string" || !exprOk(cond)) { fail(`选股条件不过编译：${String(cond)}`); break; }
    }
    if (!p.pricing || typeof p.pricing !== "object") { fail("pricing 缺失"); continue; }
    const perr = pricingOk(p.pricing);
    if (perr) { fail(perr); continue; }
    if (typeof p.holdDays !== "number" || p.holdDays < 1 || p.holdDays > 60) { fail("holdDays 越界（1~60）"); continue; }
    if (typeof p.stopPct !== "number" || p.stopPct < 3 || p.stopPct > 40) { fail("stopPct 越界（3~40）"); continue; }
    if (typeof p.targetPct !== "number" || p.targetPct < 1 || p.targetPct > 80) { fail("targetPct 越界（1~80）"); continue; }
    if (typeof p.rationale !== "string" || p.rationale.trim().length < 10) { fail("rationale（经济逻辑）太短，少于 10 字"); continue; }
    // 可判性闸：spec 用到的变量必须回测取得到，否则这条 spec 永远判不了（会一直卡在
    // proposed，等于白提）。**在提议端就拒，并告诉它能用什么**——事后发现判不了更亏。
    const unjudgeable = specVarsUsed(p as StrategySpec).filter((v) => SPEC_UNAVAILABLE[v]);
    if (unjudgeable.length > 0) {
      fail(
        `用了回测取不到的变量：${unjudgeable.join("、")}——` +
          `回测没有这些序列，这条 spec 永远判不了（${unjudgeable.map((v) => SPEC_UNAVAILABLE[v]).join("；")}）。` +
          `只能用这些变量：${SPEC_JUDGEABLE_VARS.join(" ")}`,
      );
      continue;
    }
    // 近亲封禁：选股签名和已有/已淘汰 spec 重叠超阈值 → 拒
    const twin = isNearTwin(p as StrategySpec, allSpecsForTwin);
    if (twin.twin) {
      fail(`选股逻辑和「${twin.withId}」近亲（签名重叠 ${(twin.overlap * 100).toFixed(0)}%），这是换汤不换药——换正交思路再提`);
      continue;
    }
    ids.add(p.id);
    accepted.push({ ...(p as GenomeProposal), fromFailure: (p as { fromFailure?: string }).fromFailure });
  }
  return { accepted, rejected };
}

// ── 纯函数：组 Prompt ─────────────────────────────────────────────

export type GenomeContext = {
  /** 因子层死因档案（6 关打死 + 衰退休退），喂给 AI 当「别撞的死法」。 */
  factorTombstones: string[];
  /** 被拒/淘汰的挑战者（参数通道的失败），说明「老思路的出场参数也试过了」。 */
  rejectedChallengers: string[];
  /** 已淘汰的策略 spec（基因组轨道自己的墓碑），近亲直接禁提。 */
  deadSpecs: GenomeCandidate[];
  /** 当前在跑/已通过的策略 spec，避免提近亲。 */
  liveSpecs: GenomeCandidate[];
  /** 策略闸当前状态（哪套在停用/假释），别对停用的盲目提。 */
  gateLines: string[];
  /** 已通过 6 关的因子（挖掘出来的真 edge），可直接熔进 spec 当 select/rankBy——因子→策略融合的入口。 */
  passedFactors: { id: string; name: string; expr: string; direction: 1 | -1; rationale: string }[];
};

/**
 * 因子→策略融合：把一个「已过 6 关」的因子熔成一个策略 spec 种子。
 * 这是用户要的「因子挖掘完融合」的落地——因子不再是孤立的 timing hint，
 * 而是可以直接长成一套「选股 + 排序 + 定价」的策略候选。
 * 注意：因子表达式必须能在 spec 上下文（SPEC_VARS）里编译，否则无法直熔，
 * 返回 { ok:false } 让调用方改为「让 AI 翻译」（prompt 里已列出可用变量）。
 */
export type FactorSeed = { id: string; name: string; expr: string; direction: 1 | -1; rationale: string };
export type SpecFromFactor =
  | { ok: true; spec: StrategySpec }
  | { ok: false; reason: string };

export function specFromFactor(
  f: FactorSeed,
  opts: { holdDays?: number; stopPct?: number; targetPct?: number } = {},
): SpecFromFactor {
  // 验证因子表达式能在 spec 上下文编译（变量必须在 SPEC_VARS 里，否则是空壳）。
  try {
    compileSpecExpr(f.expr);
  } catch (e) {
    return {
      ok: false,
      reason: `因子表达式「${f.expr}」含 spec 上下文没有的变量，无法直接熔进策略（让 AI 翻译成 spec 变量）：${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const select = f.direction === 1 ? [`${f.expr} > 0`] : [`${f.expr} < 0`];
  const rankBy = f.direction === 1 ? f.expr : `0 - (${f.expr})`;
  const spec: StrategySpec = {
    id: `fused_${f.id}`,
    name: `融合·${f.name}`,
    select,
    rankBy,
    pricing: { shape: "spot" },
    holdDays: opts.holdDays ?? 8,
    stopPct: opts.stopPct ?? 8,
    targetPct: opts.targetPct ?? 20,
    source: "ai",
    note: `由因子「${f.name}」（方向${f.direction > 0 ? "正向" : "反向"}）熔成；rationale: ${f.rationale}`,
  };
  return { ok: true, spec };
}

export function buildGenomePrompt(ctx: GenomeContext): string {
  const specLines = [...ctx.liveSpecs, ...ctx.deadSpecs].map((s) => {
    const sel = s.select.join(" 且 ");
    return `- ${s.name}（${s.id}，${s.status}）：${sel}；排序 ${s.rankBy}；定价 ${s.pricing.shape}${s.pricing.pct != null ? ` pct=${s.pricing.pct}` : ""}；持有${s.holdDays}天 止损${s.stopPct}% 目标${s.targetPct}%`;
  });
  return [
    "你在管理一个 A 股量化项目的「策略基因组」进化轨道。目标不是微调出场参数，而是**产出全新的选股策略**——失败要能总结成「更新后的策略」或「一套全新策略」。",
    "",
    "机制：每个候选是一套策略 spec = { select: 选股条件(表达式数组), rankBy: 排序表达式, pricing: 定价形状, holdDays, stopPct, targetPct }。选股条件用比较运算写（如 \"pe <= 18\"、\"d60 < -5\"、\"volRatio >= 1.8\"），全部为真(===1)才入选。可用变量：" + SPEC_EXPR_VARS.join(", ") + "。定价形状：spot(现价买) / prevPct(昨收+N%) / peAnchor(PE倍数锚定买22卖10) / breakout(昨收+突破%) / expr(自写买/卖/止损表达式)。",
    "",
    "⚠️ **只能用回测能判的变量**（提了别的，这条 spec 永远判不了，等于白提，会被直接拒）：" +
      SPEC_JUDGEABLE_VARS.join(" ") +
      "。不许用：" +
      Object.keys(SPEC_UNAVAILABLE).join("、") +
      "。",
    "",
    "铁律（提案必须遵守）：",
    "1. **必须和现有/已淘汰策略的选股逻辑正交**——不要只在老策略上改常数或加减一两个条件。要换思路（换选股维度、换排序逻辑、换定价锚）。近亲提案会被直接拒绝。",
    "2. 失败驱动：下面的死因档案告诉你「什么死过」，你要绕开它们，不是再试一遍。",
    "3. select 至少 1 条、必须含比较运算；rankBy 是数值表达式（越大越优先，如 \"40 - pe\" 或 \"-d60\"）；pricing 至少给形状。",
    "4. 范围：holdDays 1~60、stopPct 3~40、targetPct 1~80。",
    "5. 每个给：id（小写slug）、name（中文）、select、rankBy、pricing、holdDays、stopPct、targetPct、rationale（经济逻辑，一两句，说清这套为什么可能和死掉的那些不一样）。可附 fromFailure 字段注明你针对哪条死因。",
    "6. 提 1~2 个，宁缺毋滥。只输出 JSON 数组。",
    "",
    "现有/已淘汰策略（选股逻辑签名已比对，近亲会被拒）：",
    specLines.length > 0 ? specLines.join("\n") : "- （还没有）",
    "",
    "因子层死因档案（6 关打死 + 衰退休退，别撞同样的死法）：",
    ctx.factorTombstones.length > 0 ? ctx.factorTombstones.join("\n") : "- （没有）",
    "",
    "被拒/淘汰的挑战者（参数通道也试过的出场思路）：",
    ctx.rejectedChallengers.length > 0 ? ctx.rejectedChallengers.join("\n") : "- （没有）",
    "",
    "已通过 6 关的因子（挖掘出来的真 edge，可熔进你的 spec 当选股/排序条件——这就是因子→策略融合）：",
    ctx.passedFactors.length > 0
      ? ctx.passedFactors
          .map((f) => `- ${f.name}（${f.id}，${f.direction > 0 ? "正向" : "反向"}）：expr=${f.expr}；逻辑：${f.rationale}`)
          .join("\n")
      : "- （还没有已通过的因子，跳过融合）",
    "",
    "策略闸当前状态：",
    ctx.gateLines.length > 0 ? ctx.gateLines.join("\n") : "- （全部正常）",
    "",
    "只输出 JSON 数组，不要输出任何别的文字。",
    RED_LINE_PROMPT,
  ].join("\n");
}

// ── 闭环运行器（node:fs + fetch，server-only）───────────────────

export async function runGenomeLoop(trigger: "manual" | "auto" = "manual"): Promise<GenomeLoopResult> {
  const config = await readAIConfig();
  if (!config) {
    const result: GenomeLoopResult = { ok: false, proposed: 0, rejected: 0, rejectReasons: [], error: "AI 接口还没配置（/ai 页填 baseUrl / apiKey / model）" };
    await appendAILog({ at: new Date().toISOString(), layer: "genome", trigger, ...result, proposed: [], rejected: [] });
    return result;
  }
  const genome = await readGenome();
  const { entries } = await readQueue();
  const challengers = await readChallengers();
  const tombstones = await readTombstones();
  const gates = await readStrategyGates();

  // 已通过 6 关的因子 = 挖掘出来的真 edge，既能进 prompt 让 AI 融合，也能当「AI 沉默时」的融合回退种子。
  const passedFactorSeeds = entries
    .filter((e) => e.status === "passed")
    .map((e) => ({ id: e.id, name: e.name, expr: e.expr, direction: e.direction, rationale: e.rationale }));

  const factorTombLines = tombstones.slice(0, 20).map(
    (t) => `- ${t.name}（${t.category}）：${t.failedGates.length ? `败于 ${t.failedGates.join("/")}` : "衰退休退"}；expr=${t.expr ?? "?"}`,
  );
  const rejectedChalLines = challengers.list
    .filter((c) => c.status === "rejected")
    .slice(-10)
    .map((c) => `- ${c.name}（${c.id}）：挑战「${c.style}」，被拒——${c.note ?? ""}`);
  const gateLines = Object.entries(gates).map(
    ([style, g]) => `- ${style}：${g.state === "disabled" ? `停用中（第 ${g.strikes} 次，冷却 ${g.cooldownDays} 交易日）` : "假释观察中"}，${g.reason}`,
  );
  const deadSpecs = genome.list.filter((c) => c.status === "tombstone");

  const ctx: GenomeContext = {
    factorTombstones: factorTombLines,
    rejectedChallengers: rejectedChalLines,
    deadSpecs,
    liveSpecs: genome.list.filter((c) => c.status !== "tombstone"),
    gateLines,
    passedFactors: passedFactorSeeds,
  };

  let raw: string;
  try {
    raw = await callAIWithFallback(buildGenomePrompt(ctx), { layer: "genome", trigger });
  } catch (error) {
    const result: GenomeLoopResult = { ok: false, proposed: 0, rejected: 0, rejectReasons: [], error: error instanceof Error ? error.message : String(error) };
    await appendAILog({ at: new Date().toISOString(), layer: "genome", trigger, ...result, proposed: [], rejected: [] });
    return result;
  }

  const { accepted, rejected } = parseGenomeProposals(
    raw,
    genome.list,
    deadSpecs.map((d) => d),
  );
  // 融合回退：AI 这轮没产出可用提案，但有已通过 6 关的因子 → 把头部那个熔成 spec 种子顶上。
  // 这就是「因子→策略融合」的兜底落地：因子不再只是孤立信号。近亲/id 撞了就跳过，不强行顶。
  if (accepted.length === 0 && passedFactorSeeds.length > 0) {
    const seed = specFromFactor(passedFactorSeeds[0]);
    if (seed.ok && !genome.list.some((c) => c.id === seed.spec.id)) {
      const twin = isNearTwin(seed.spec, [...genome.list, ...deadSpecs]);
      if (!twin.twin) {
        accepted.push({ ...seed.spec, rationale: seed.spec.note ?? `融合自因子 ${passedFactorSeeds[0].id}` });
      } else {
        rejected.push({ proposal: seed.spec.id, reason: `融合种子和「${twin.withId}」近亲，不强行顶上` });
      }
    } else if (seed.ok) {
      rejected.push({ proposal: seed.spec.id, reason: "融合种子 id 已存在" });
    } else {
      rejected.push({ proposal: passedFactorSeeds[0].id, reason: seed.reason });
    }
  }
  if (accepted.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    await writeGenome({
      list: [
        ...genome.list,
        ...accepted.map((a) => ({
          ...a,
          status: "proposed" as const,
          since: today,
          source: "ai" as const,
          note: `AI 提议：${a.rationale}`,
        })),
      ],
    });
  }
  const result: GenomeLoopResult = { ok: true, proposed: accepted.length, rejected: rejected.length, rejectReasons: rejected.map((r) => r.reason).slice(0, 5) };
  await appendAILog({
    at: new Date().toISOString(),
    layer: "genome",
    trigger,
    ...result,
    proposed: accepted.map((a) => ({ id: a.id, name: a.name })),
    rejected: result.rejectReasons,
  });
  return result;
}
