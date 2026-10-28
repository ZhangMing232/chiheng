/**
 * 这个文件是干什么的：
 * 策略层的 AI 管理——镜像 factor-queue.ts 的四级漏斗，但边界更严：
 * AI 只许提名「挑战者」（同一套选股名单、不同的出场参数），转正/淘汰永远由
 * record-journal.ts 里预先登记的 Welch 判决说了算，AI 没有任何代码路径碰到
 * 判决函数、策略闸或线上冠军参数。
 *
 * 你需要知道的（纪律）：
 * 1. **旋钮白名单**：AI 只能调 holdDays / stopPct / targetPct 三个出场参数，
 *    每个有硬范围（见 KNOBS）。选股条件一个比特都不许动——收益差异来自参数
 *    这个归因能成立，靠的就是名单一致。
 * 2. ** AI 产出逐条校验**：id 撞名、style 不在词表、参数越界/全缺（全缺 =
 *    冠军的复制品，没意义）、和同策略在跑挑战者参数雷同、每策略在跑超过
 *    MAX_RUNNING_PER_STYLE 个——都拒并写明原因。一条被拒不中断整批。
 * 3. 校验通过的直接以 running 状态写进 challengers.json，记账进程每分钟读，
 *    当天就开始并行攒样本（每天限 1 只）。since = 提议当天。
 * 4. prompt 的上下文全是判决产物：挑战者名单与状态、冠军参数留档、策略闸
 *    状态、因子层刚过关的信号。数字原样来自文件，不加工。
 * 5. 纯逻辑（校验、prompt 组装）不依赖 fs/fetch，直接单测。
 */

import { readFile } from "node:fs/promises";
import { callAIWithFallback, readAIConfig, readQueue } from "./factor-queue.ts";
import { appendAILog, readAILog, strategySelfHistory } from "./ai-log.ts";
import { readChallengers, readChampions, writeChallengers, championLogPath, type Challenger } from "./challenger.ts";
import { readStrategyGates, type GatesFile } from "./strategy-gate.ts";
import { ACTIVE_STYLES, STYLES, STYLE_IDS, holdOf } from "./strategies.ts";
import { RED_LINE_PROMPT } from "./red-line.ts";
import { readMarketDegraded } from "./providers/index.ts";

// ── 旋钮白名单 ──────────────────────────────────────────────────

/**
 * AI 可调的三个出场参数。硬范围比人工注册窄——宁可 AI 保守，不给它在参数空间
 * 乱飞的自由。缺省 = 沿用冠军值（挑战者记录里不写该字段）。
 */
export const KNOBS = {
  holdDays: { min: 3, max: 30, int: true },
  stopPct: { min: 4, max: 15, int: true },
  targetPct: { min: 8, max: 60, int: true },
} as const;

export type KnobKey = keyof typeof KNOBS;

/** 每套策略同时在跑的挑战者上限——防止 AI 一口气提名一堆把纸面名额稀释成噪声。 */
export const MAX_RUNNING_PER_STYLE = 2;

// ── 纯函数：校验 ────────────────────────────────────────────────

export type ChallengerProposal = {
  id: string;
  style: string;
  name: string;
  rationale: string;
  holdDays?: number;
  stopPct?: number;
  targetPct?: number;
};

const ID_RE = /^[a-z][a-z0-9_-]{1,31}$/;

function knobErrors(p: ChallengerProposal): string[] {
  const errors: string[] = [];
  let anyKnob = false;
  for (const key of Object.keys(KNOBS) as KnobKey[]) {
    const v = p[key];
    if (v === undefined) continue;
    anyKnob = true;
    const rule = KNOBS[key];
    if (rule.int && !Number.isInteger(v)) errors.push(`${key} 必须是整数`);
    else if (typeof v !== "number" || !Number.isFinite(v)) errors.push(`${key} 不是数`);
    else if (v < rule.min || v > rule.max) errors.push(`${key}=${v} 越界（${rule.min}~${rule.max}）`);
  }
  if (!anyKnob) errors.push("三个参数全缺 = 冠军的复制品，至少调一个");
  return errors;
}

/** 参数指纹：两个挑战者旋钮全同 = 雷同。 */
export function paramsKey(p: { holdDays?: number; stopPct?: number; targetPct?: number }): string {
  return `${p.holdDays ?? "-"}:${p.stopPct ?? "-"}:${p.targetPct ?? "-"}`;
}

export type ChallengerCheck = {
  accepted: ChallengerProposal[];
  rejected: { proposal: unknown; reason: string }[];
};

/**
 * AI 的挑战者提案逐条校验。existing = 现有挑战者（撞 id、撞参数用）。
 * 与 factor 层同一个取舍：一个被拒 continue，不中断整批。
 */
export function parseAIChallengerProposals(raw: string, existing: Challenger[]): ChallengerCheck {
  const start = raw.indexOf("[");
  const end = raw.lastIndexOf("]");
  if (start < 0 || end <= start) {
    return { accepted: [], rejected: [{ proposal: raw.slice(0, 200), reason: "AI 返回里没有 JSON 数组" }] };
  }
  let arr: unknown[];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as unknown;
    if (!Array.isArray(parsed)) throw new Error("不是数组");
    arr = parsed;
  } catch (e) {
    return { accepted: [], rejected: [{ proposal: raw.slice(0, 200), reason: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` }] };
  }
  const accepted: ChallengerProposal[] = [];
  const rejected: ChallengerCheck["rejected"] = [];
  const ids = new Set(existing.map((c) => c.id));
  const runningByStyle = new Map<string, (Challenger | ChallengerProposal)[]>();
  for (const c of existing.filter((item) => item.status === "running")) {
    runningByStyle.set(c.style, [...(runningByStyle.get(c.style) ?? []), c]);
  }
  for (const item of arr) {
    const p = item as Partial<ChallengerProposal>;
    const fail = (reason: string) => rejected.push({ proposal: item, reason });
    if (typeof p?.id !== "string" || !ID_RE.test(p.id)) { fail("id 缺失或不合法（要小写字母开头的 slug）"); continue; }
    if (ids.has(p.id)) { fail(`id「${p.id}」已存在`); continue; }
    if (typeof p.style !== "string" || !(STYLE_IDS as string[]).includes(p.style)) { fail(`style「${String(p.style)}」不在词表`); continue; }
    if (typeof p.name !== "string" || p.name.trim().length < 2) { fail("name 缺失或太短"); continue; }
    if (typeof p.rationale !== "string" || p.rationale.trim().length < 10) { fail("rationale（调参理由）太短，少于 10 字"); continue; }
    const errors = knobErrors(p as ChallengerProposal);
    if (errors.length > 0) { fail(errors.join("；")); continue; }
    const running = runningByStyle.get(p.style) ?? [];
    if (running.length >= MAX_RUNNING_PER_STYLE) { fail(`${p.style} 已有 ${MAX_RUNNING_PER_STYLE} 个在跑挑战者，等判决后再提`); continue; }
    if (running.some((c) => paramsKey(c) === paramsKey(p as ChallengerProposal))) { fail("参数组合和该策略在跑挑战者雷同"); continue; }
    ids.add(p.id);
    runningByStyle.set(p.style, [...running, p as ChallengerProposal]);
    accepted.push({
      id: p.id,
      style: p.style,
      name: p.name.trim(),
      rationale: p.rationale.trim(),
      holdDays: p.holdDays,
      stopPct: p.stopPct,
      targetPct: p.targetPct,
    });
  }
  return { accepted, rejected };
}

// ── 纯函数：组 Prompt ───────────────────────────────────────────

export type StrategyAIContext = {
  challengers: Challenger[];
  gates: GatesFile;
  /** 冠军参数留档（champion-log.jsonl 最近几条，原文摘要）。 */
  logTail: string[];
  /** 因子层刚过了 6 关的队列因子。 */
  passedFactors: { id: string; name: string; direction: 1 | -1; expr: string }[];
  /** AI 自己之前提名挑战者的下场（strategySelfHistory 产物），自我纠错用。 */
  selfHistory?: string[];
  /** 每套在跑策略当前的冠军参数（默认 or 已转正挑战者），冷启动提案的基准。 */
  champions: { style: string; source: string; params: string }[];
  /** 当日市场头部快照（VT 工具拉的实时截面），校准当前市场风格，辅助判断出场节奏。 */
  marketEvidence?: string[];
  /** AI 管家最近一次诊断的 suggestions（plan 层产物），供调参参考不强制。 */
  diagnosisHints?: string[];
  /** 挑战者纸面样本进度（账本 variant 行数，summarizeChallengerSamples 产物）。 */
  chalSampleLines?: string[];
  /**
   * 逐笔亏损归因段（lossAttribLines 产物，已按策略拆开）：这套策略的亏损死在
   * 哪个机制（止损太紧 / 跳空 / 到期没走出来），提参数变体对着死因提。
   * 增强项：读不到就空，提议照常跑。
   */
  lossAttribLines?: string[];
};

export function buildStrategyPrompt(ctx: StrategyAIContext): string {
  const styleName = (id: string) => STYLES.find((s) => s.id === id)?.name ?? id;
  const chalLines = ctx.challengers
    .slice(-20)
    .map((c) => {
      const params = [`持有${c.holdDays ?? "沿用冠军"}天`, `止损${c.stopPct ?? "沿用冠军"}%`, `目标${c.targetPct ?? "沿用冠军"}%`].join(" / ");
      return `- ${c.name}（${c.id}）：挑战「${styleName(c.style)}」，${params}，状态 ${c.status}，${c.since} 开跑`;
    })
    .join("\n");
  const gateLines = Object.entries(ctx.gates)
    .map(([style, g]) => `- ${styleName(style)}：${g.state === "disabled" ? `停用中（第 ${g.strikes} 次，冷却 ${g.cooldownDays} 交易日）` : `假释观察中`}，${g.reason}`)
    .join("\n");
  const factorLines =
    ctx.passedFactors.length > 0
      ? ctx.passedFactors.map((f) => `- ${f.name}（${f.id}）：${f.direction > 0 ? "正向" : "反向"}，表达式 ${f.expr}`).join("\n")
      : "- （最近没有）";
  const logLines = ctx.logTail.length > 0 ? ctx.logTail.join("\n") : "- （没有留档）";
  const championLines = ctx.champions
    .map((c) => `- ${styleName(c.style)}：${c.source}；当前参数 ${c.params}`)
    .join("\n");
  return [
    "你在管理一个 A 股量化项目的策略参数进化。机制是冠军-挑战者：挑战者和冠军用同一套选股名单、只改出场参数，双方各攒够 30 笔已平仓后 Welch t ≥ 1.5 且均值更高才转正，t ≤ −2 淘汰。",
    "",
    `目前在实盘跑的策略：${ACTIVE_STYLES.map(styleName).join("、")}。`,
    "",
    "铁律（提案必须遵守）：",
    "1. 只许调三个出场参数：holdDays（3~30 整数）、stopPct（4~15 整数）、targetPct（8~60 整数）。**选股条件不许动**——收益差异必须能归因到参数。",
    "2. 每套策略最多 2 个在跑挑战者，参数组合不许和现有雷同，三个参数全缺没意义。",
    "3. 提案要针对证据：策略闸停用中的策略别提它的挑战者；冠军刚被回滚的参数方向别急着再试；因子层新过关的信号（如大市值溢价）可以想「它适合配什么出场节奏」。",
    `4. style 只能填以下 id 之一（填英文 id，不是中文名）：${STYLE_IDS.map((id) => `${id}（${styleName(id)}）`).join(" / ")}。`,
    "5. 提 1~2 个，宁缺毋滥。每个给：id（小写字母开头 slug）、style、name（中文名）、holdDays / stopPct / targetPct（至少填一个，只填要改的）、rationale（调参理由，一两句）。",
    "6. **冷启动不许空转**：某套策略在跑挑战者不到 2 个、且没有针对它的近期证据时，恰恰最该提案——给该冠军的参数提 1 个保守变体来攒样本。只做小幅偏移（止损 ±2%、目标 ±5%、持有 ±2 天这种量级），rationale 里写明是探索性变体、想验证什么。全部策略都没挑战者在跑时返回空数组，等于这一天白过，不允许。",
    "",
    "冠军当前参数（挑战者的基准，缺省字段就沿用这里）：",
    championLines || "- （没有）",
    "",
    "现有挑战者（近 20 条）：",
    chalLines || "- （没有）",
    ...(ctx.chalSampleLines && ctx.chalSampleLines.length > 0
      ? ["", "挑战者纸面样本进度（账本 variant 行数——攒得慢的在跑挑战者占着名额不出样本，提名时优先考虑样本能落账的风格/参数）：", ...ctx.chalSampleLines]
      : []),
    ...(ctx.lossAttribLines && ctx.lossAttribLines.length > 0
      ? ["", "逐笔亏损归因（按退出机制拆到每套策略：止损被正常波动打掉 → 该松止损或挪止损位；跳空穿止损 → 调参救不了，想仓位/避开事件窗口；到期没走出来 → 该调持有天数或目标价）：", ...ctx.lossAttribLines]
      : []),
    "",
    "策略闸当前状态：",
    gateLines || "- （全部正常）",
    "",
    "参数切换留档（champion-log 最近几条）：",
    logLines,
    "",
    "因子层刚过 6 关的信号（可以据此提策略线）：",
    factorLines,
    ...(ctx.marketEvidence && ctx.marketEvidence.length > 0
      ? [
          "",
          "当日市场证据（Vibe-Trading 工具矿山三路并发：头部个股截面 / 行业板块强弱 / 龙虎榜热钱方向。只用来校准「现在市场在奖励什么风格」，帮助判断出场节奏与参数方向；不要当成历史规律，调参仍以冠军-挑战者判决和自我历史为主）：",
          ...ctx.marketEvidence,
        ]
      : []),
    ...(ctx.diagnosisHints && ctx.diagnosisHints.length > 0
      ? [
          "",
          "AI 管家的诊断建议（最近一次全局诊断的 plan 层产物，供参考不强制；和判决规则/铁律冲突时以后者为准）：",
          ...ctx.diagnosisHints,
        ]
      : []),
    ...(ctx.selfHistory && ctx.selfHistory.length > 0
      ? ["", "你自己之前几轮提名的下场（据此纠错：被 Welch 淘汰的参数方向别急着再试；转正了的想想它做对了什么）：", ...ctx.selfHistory]
      : []),
    "",
    "只输出 JSON 数组，不要输出任何别的文字。",
    // 红线（Vibe 宪法 §0-3）：不给投资动作建议。挑战者提名只有参数旋钮，
    // 但 rationale 是自由文本——说清边界，免得 AI 在理由里夹带目标价/止损位建议。
    RED_LINE_PROMPT,
  ].join("\n");
}

// ── 闭环运行器（node:fs + fetch，server-only）───────────────────

export type StrategyAILoopResult = {
  ok: boolean;
  proposed: number;
  rejected: number;
  rejectReasons: string[];
  error?: string;
};

/** 读 champion-log.jsonl 最近几条（纯文本摘要，没有文件就当空的）。 */
async function readLogTail(n: number): Promise<string[]> {
  try {
    const text = await readFile(championLogPath(), "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim())
      .slice(-n)
      .map((line) => {
        try {
          const e = JSON.parse(line) as { style: string; from: string; to: string; reason: string };
          return `${e.style}: ${e.from} → ${e.to}（${e.reason}）`;
        } catch {
          return line;
        }
      });
  } catch {
    return [];
  }
}

/**
 * 跑一轮策略 AI 闭环：读配置 → 组装判决产物上下文（含自我历史）→ 调 AI →
 * 逐条校验 → 通过的以 running 写进 challengers.json（记账进程当天开始并行攒样本）。
 * 任何一步失败返回 ok:false，不写名单；每轮都写 ai-log 账本（含失败）。
 */
export async function runStrategyAILoop(trigger: "manual" | "auto" = "manual"): Promise<StrategyAILoopResult> {
  const config = await readAIConfig();
  if (!config) {
    const result: StrategyAILoopResult = { ok: false, proposed: 0, rejected: 0, rejectReasons: [], error: "AI 接口还没配置（/ai 页填 baseUrl / apiKey / model）" };
    await appendAILog({ at: new Date().toISOString(), layer: "strategy", trigger, ...result, proposed: [], rejected: [] });
    return result;
  }
  const chalFile = await readChallengers();
  const { entries } = await readQueue();
  const champions = await readChampions();
  /** 每套在跑策略的当前冠军参数摘要：默认参数 or 已转正挑战者的旋钮。 */
  const championInfos = ACTIVE_STYLES.map((style) => {
    const version = champions[style];
    if (!version) {
      return { style, source: "代码默认参数", params: `持有${holdOf(style)}天；止损/目标 = 策略内置公式` };
    }
    const promoted = chalFile.list.find((c) => c.id === version);
    if (!promoted) {
      return { style, source: `参数版本「${version}」`, params: "（champions.json 指了这个版本但挑战者记录里找不到，按默认参数对待）" };
    }
    return {
      style,
      source: `已转正挑战者「${promoted.name}」（${promoted.id}）`,
      params: [`持有${promoted.holdDays ?? holdOf(style)}天`, `止损${promoted.stopPct ?? "内置公式"}%`, `目标${promoted.targetPct ?? "内置公式"}%`].join(" / "),
    };
  });
  // 当日市场证据（与因子层同款）：VT 工具矿山三路并发——头部个股截面 + 行业板块
  // 强弱 + 龙虎榜热钱方向。离线/超时/单源失败降级为剩下几路，全挂为空，
  // 策略提议照常跑——证据是校准项不是依赖项。
  let marketEvidence: string[] = [];
  try {
    const { gatherVtEvidence } = await import("./agent-loop.ts");
    marketEvidence = await gatherVtEvidence();
  } catch {
    marketEvidence = [];
  }
  // 诊断建议（plan 层接线）：与因子层同款，最近一次全局诊断的 suggestions 进本轮 prompt。
  let diagnosisHints: string[] = [];
  try {
    const { fetchDiagnosisHints } = await import("./agent-loop.ts");
    diagnosisHints = await fetchDiagnosisHints();
  } catch {
    diagnosisHints = [];
  }
  // 挑战者纸面样本进度（与诊断层同一份账本采集）：模型提名时看得见谁在攒样、
  // 谁占着名额不出样本——不然它只知道「2 个在跑」，不知道 2 个都是 0 样本。
  let chalSampleLines: string[] = [];
  try {
    const { collectChallengerSamples } = await import("./challenger-samples.ts");
    const { summarizeChallengerSamples } = await import("./agent-loop.ts");
    chalSampleLines = summarizeChallengerSamples(chalFile.list, await collectChallengerSamples());
  } catch {
    chalSampleLines = [];
  }
  // 逐笔亏损归因（与 agent-loop 诊断同一份采集口径）：按策略拆开的亏损死因，
  // 让 AI 提参数变体时有靶子——「rebound 亏在到期没走出来」直接指向 holdDays/targetPct。
  let lossLines: string[] = [];
  try {
    const { readUserBook, OWNER_ID } = await import("./book-file.ts");
    const { attributeTradeLoss, summarizeTradeLosses, lossAttribLines } = await import("./loss-attrib.ts");
    const book = await readUserBook<{ trades?: unknown[] }>(OWNER_ID);
    const attribs = (book.days ?? [])
      .flatMap((day) => day.trades ?? [])
      .map((trade) => attributeTradeLoss(trade as never))
      .filter((x): x is NonNullable<typeof x> => x != null);
    lossLines = lossAttribLines(summarizeTradeLosses(attribs));
  } catch {
    lossLines = [];
  }
  const ctx: StrategyAIContext = {
    challengers: chalFile.list,
    gates: await readStrategyGates(),
    logTail: await readLogTail(8),
    passedFactors: entries.filter((e) => e.status === "passed").map((e) => ({ id: e.id, name: e.name, direction: e.direction, expr: e.expr })),
    selfHistory: strategySelfHistory(await readAILog(), chalFile.list),
    champions: championInfos,
    marketEvidence,
    diagnosisHints,
    chalSampleLines,
    lossAttribLines: lossLines,
  };
  let raw: string;
  try {
    raw = await callAIWithFallback(buildStrategyPrompt(ctx), { layer: "strategy", trigger });
  } catch (error) {
    const result: StrategyAILoopResult = { ok: false, proposed: 0, rejected: 0, rejectReasons: [], error: error instanceof Error ? error.message : String(error) };
    await appendAILog({ at: new Date().toISOString(), layer: "strategy", trigger, ...result, proposed: [], rejected: [] });
    return result;
  }
  const { accepted, rejected } = parseAIChallengerProposals(raw, chalFile.list);
  // 冷启动播种：模型这轮空返回、且某套在跑策略一个挑战者都没有时，由代码按
  // 白名单旋钮确定性提一个保守变体。这不是绕过 AI——挑战者和 AI 提名走同一条
  // Welch 判决、同样只许三个旋钮，只是把「攒第一批样本」从模型的悟性里解耦出来。
  // AI 恢复提案后这里自然不触发（accepted 非空就跳过）。
  const seeded: Challenger[] = [];
  if (accepted.length === 0) {
    const existingIds = new Set(chalFile.list.map((c) => c.id));
    const today = new Date().toISOString().slice(0, 10);
    for (const style of ACTIVE_STYLES) {
      const running = chalFile.list.filter((c) => c.style === style && c.status === "running").length;
      if (running > 0) continue;
      const id = `cold-${style}-v1`;
      if (existingIds.has(id)) continue; // 上一任被判决掉了，不重复用同一个 id
      seeded.push({
        id,
        style,
        name: "冷启动播种·标准变体",
        note: "AI 本轮空返回，代码按白名单旋钮确定性播种（stopPct=10 / targetPct=25，持有沿用冠军），与 AI 提名同标准过 Welch 判决",
        stopPct: 10,
        targetPct: 25,
        status: "running",
        since: today,
      });
    }
  }
  if (accepted.length > 0 || seeded.length > 0) {
    const today = new Date().toISOString().slice(0, 10);
    await writeChallengers({
      list: [
        ...chalFile.list,
        ...accepted.map((a) => ({
          id: a.id,
          style: a.style,
          name: a.name,
          note: `AI 提议：${a.rationale}`,
          holdDays: a.holdDays,
          stopPct: a.stopPct,
          targetPct: a.targetPct,
          status: "running" as const,
          since: today,
          source: "ai" as const,
        })),
        ...seeded,
      ],
    });
  }
  const result: StrategyAILoopResult = { ok: true, proposed: accepted.length + seeded.length, rejected: rejected.length, rejectReasons: rejected.map((r) => r.reason).slice(0, 5) };
  // 空返回（accepted/rejected 都是 0）先分清是「失职」还是「名额满，本来就该空」：
  // 每套在跑策略的挑战者名额都占满时，按铁律 2 本轮不提名是守规矩，不是摸鱼。
  const slotsFull = ACTIVE_STYLES.every(
    (style) => chalFile.list.filter((c) => c.style === style && c.status === "running").length >= MAX_RUNNING_PER_STYLE,
  );
  // 行情源降级（腾讯失败退回新浪）会让依赖近 5/20/60 日涨幅、量比的策略名单为空，
  // 这种空返回是系统性原因，不是 AI 摸鱼——读降级状态文件做归因展示。
  const degraded = await readMarketDegraded();
  const silentEmpty = accepted.length === 0 && rejected.length === 0;
  await appendAILog({
    at: new Date().toISOString(),
    layer: "strategy",
    trigger,
    ...result,
    proposed: accepted.map((a) => ({ id: a.id, name: a.name })),
    rejected: result.rejectReasons,
    ...(silentEmpty
      ? {
          note:
            seeded.length > 0
              ? `AI 返回空数组，已确定性播种 ${seeded.length} 个冷启动挑战者（${seeded.map((s) => `${s.style}:${s.id}`).join("、")}）——同样过 Welch 判决`
              : slotsFull
                ? "AI 返回空数组——每套在跑策略的挑战者名额都已占满，按铁律 2 本轮不该提名，合理空转（等 Welch 判决腾出名额）"
                : degraded
                  ? `AI 返回空数组——行情源降级（${degraded.source}：${degraded.impact}），依赖这些字段的策略名单为空，合理空转不记失职`
                  : `AI 返回空数组（${raw.trim().slice(0, 200) || "空白响应"}）——按冷启动铁律第 6 条，这视为本轮失职`,
        }
      : {}),
  });
  return result;
}
