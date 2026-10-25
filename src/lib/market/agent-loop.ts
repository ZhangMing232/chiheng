/**
 * 这个文件是干什么的：
 * AI 大脑的「观察 + 诊断」层（design/AI-BRAIN.md 方案 A 的第一步）。
 * 之前的两层闭环（factor-queue / strategy-ai）是「单轮提议」——AI 每轮只看
 * 一层自己的上下文，提完就走。这里把**整个账本**摊给它：因子判决史 + 队列 +
 * 死因档案 + 挑战者纸面 + 策略闸 + AI 自身进化史，让它先「看懂全局」再说话。
 *
 * 你需要知道的（纪律，和两层闭环同规矩）：
 * 1. **这轮只诊断，不行动**。输出是一份诊断报告（总评 / 因子层 / 策略层 /
 *    建议 / 规则变更请求），原样落 data/agent-diagnosis.json 展示给人看。
 *    建议项要真行动，得走已有的提议通道（parseAIProposals / 挑战者提名），
 *    那是下一步（plan/act）的事。
 * 2. **规则变更请求只展示**。AI 觉得「6 关太严 / Welch 阈值不对」，只能写进
 *    ruleChangeRequests 给人拍板——判决规则写死在代码里，AI 没有任何代码路径
 *    碰得到（和 VT1/VT2 的边界同一条）。
 * 3. 纯函数（buildDiagnosisPrompt / parseDiagnosis / extractJson）不碰 fs/fetch，
 *    直接单测；collect/run 是 server-only。
 * 4. 诊断也记 ai-log（layer="agent"）：跑了没产出、配置失效、接口欠费，都要
 *    能在账本里看到，不能静默。token 走 callAIWithFallback 同一本账。
 */

/**
 * ⚠️ 浏览器兼容（2026-10-25，同类坑第三次）：
 * 顶层 import node: 内置模块会被 vite 转成空壳桩顶层解构，模块一求值就抛
 * 「Module externalized」→ hydration 跑不了 → 整站按钮失灵（页面能看、点不动）。
 * 本文件经 factor-queue.ts（debate/research 路由文件静态引用链）进客户端闭包，
 * 且它拖着 challenger / strategy-gate / vt-tools / challenger-samples 一整串，
 * node API 必须函数内动态 import；路径拼接用 posixJoin 替代 node:path。
 */
const fsApi = () => import("node:fs/promises");
/** POSIX 风格拼路径。不用 node:path——顶层 import 它同样会在客户端崩（见文件头）。 */
const posixJoin = (...parts: string[]): string => parts.join("/");
/** POSIX 风格取父目录。同上，node:path 的 dirname 也不能顶层 import。 */
const posixDirname = (p: string): string => p.slice(0, p.lastIndexOf("/"));

import { callAIWithFallback, readAIConfig, readQueue } from "./factor-queue.ts";
import { appendAILog, evolveStats, readAILog } from "./ai-log.ts";
import { necropsyLines } from "./factor-necropsy.ts";
import { readFactorRuns, type FactorRunRow } from "./factor-runs-file.ts";
import { readTombstones } from "./factor-tombstones.ts";
import { readChallengers, readChampions, CHALLENGER_RULE } from "./challenger.ts";
import { readStrategyGates } from "./strategy-gate.ts";
import { ACTIVE_STYLES, STYLES, holdOf } from "./strategies.ts";
import { RED_LINE_PROMPT } from "./red-line.ts";
import { collectChallengerSamples, type ChallengerSample } from "./challenger-samples.ts";
import { screenNumbers } from "./number-gate.ts";

// ── 账本快照（observe） ─────────────────────────────────────────

/** 一次诊断吃的全部上下文。字段都是「展示原文」，数字原样来自文件，不加工。 */
export type LedgerSnapshot = {
  at: string;
  /** 因子层：最近一批判决，每因子一行。 */
  factorLines: string[];
  /** 因子层：批次数 / 最近批日期 / 样本天数。 */
  factorMeta: string;
  /** 队列现状统计（活因子/待验/已过/坟墓各几个）。 */
  queueLines: string[];
  /** 死因档案聚合（necropsyLines 输出）。 */
  necropsy: string[];
  /** 策略层：冠军参数。 */
  championLines: string[];
  /** 策略层：挑战者名单与状态。 */
  chalLines: string[];
  /** 策略层：挑战者纸面样本进度（账本 variant 行数，已平仓/持仓/最近建仓）。 */
  chalSampleLines: string[];
  /** 策略层：策略闸状态。 */
  gateLines: string[];
  /** AI 自身：近几轮两层进化的成败史。 */
  selfHistory: string[];
  /** 市场证据：VT 工具矿山拉的当日 A 股快照（涨跌幅/成交额头部）。空数组 = 工具离线，诊断照常跑。 */
  marketEvidence: string[];
};

/** 一行市场快照 → 中文摘要（代码 名称 涨跌幅 成交额亿）。 */
export function summarizeMarketRow(r: Record<string, unknown>): string {
  const code = String(r.code ?? "?");
  const name = String(r.name ?? "?");
  const pct = typeof r.change_pct === "number" ? (r.change_pct / 100).toFixed(2) : "?";
  const amountYi = typeof r.amount === "number" ? (r.amount / 1e8).toFixed(1) : "?";
  return `${code} ${name} ${pct}% · 成交 ${amountYi} 亿`;
}

/**
 * 从 VT 工具矿山拉当日市场证据（纯函数：把工具返回的 JSON 文本变成行）。
 * 解析失败/返回 ok:false → 空数组（证据是增强项，不是必需品）。
 */
export function evidenceOf(raw: string, maxRows = 10): string[] {
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; data?: { rows?: Record<string, unknown>[] } };
    if (parsed.ok === false || !Array.isArray(parsed.data?.rows)) return [];
    return parsed.data.rows.slice(0, maxRows).map(summarizeMarketRow);
  } catch {
    return [];
  }
}

/**
 * 行业板块排行（get_sector_info mode=ranking）→ 行。change_pct 已是百分数，不除 100。
 * 解析失败/ok:false → 空数组。
 */
export function sectorEvidenceOf(raw: string, maxRows = 8): string[] {
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; data?: { boards?: Record<string, unknown>[] } };
    if (parsed.ok === false || !Array.isArray(parsed.data?.boards)) return [];
    return parsed.data.boards.slice(0, maxRows).map((b) => {
      const name = String(b.board_name ?? "?");
      const pct = typeof b.change_pct === "number" ? b.change_pct.toFixed(2) : "?";
      const up = typeof b.up_count === "number" ? b.up_count : "?";
      const down = typeof b.down_count === "number" ? b.down_count : "?";
      return `${name} ${pct}%（${up}涨/${down}跌）`;
    });
  } catch {
    return [];
  }
}

/**
 * 龙虎榜（get_dragon_tiger）→ 按净买额排序取前列。net_buy 单位元 → 亿。
 * 解析失败/ok:false → 空数组。
 */
export function dragonTigerEvidenceOf(raw: string, maxRows = 5): string[] {
  try {
    const parsed = JSON.parse(raw) as { ok?: boolean; data?: { appearances?: Record<string, unknown>[] } };
    if (parsed.ok === false || !Array.isArray(parsed.data?.appearances)) return [];
    return [...parsed.data.appearances]
      .sort((a, b) => Number(b.net_buy ?? 0) - Number(a.net_buy ?? 0))
      .slice(0, maxRows)
      .map((a) => {
        const name = String(a.name ?? a.code ?? "?");
        const pct = typeof a.change_pct === "number" ? a.change_pct.toFixed(2) : "?";
        const netYi = typeof a.net_buy === "number" ? (a.net_buy / 1e8).toFixed(1) : "?";
        return `${name} ${pct}% · 净买 ${netYi} 亿`;
      });
  } catch {
    return [];
  }
}

/**
 * 三源并发取当日市场证据：头部个股截面 + 行业板块强弱 + 龙虎榜热钱方向。
 * 每源独立容错——任何一路挂了只少一段，不拖死整轮提议；
 * 全部离线时返回空数组，提议照常跑（证据是校准项不是依赖项）。
 *
 * 三路**串行**而不是并发：实测并发会在东财侧触发 IP 限流（Connection
 * aborted / RemoteDisconnected），证据全灭。每路之间让 VT 自己的
 * per-host 节流先冷却一下，慢几秒换稳定拿全。
 */
export async function gatherVtEvidence(): Promise<string[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { invokeVtTool } = await import("./vt-tools.ts");
  const settle = async <T,>(p: Promise<T>): Promise<[string | null, T | null]> => {
    try {
      return [null, await p];
    } catch (e) {
      return [e instanceof Error ? e.message : String(e), null];
    }
  };
  const out: string[] = [];
  const [, screenRaw] = await settle(invokeVtTool("screen_market", { market: "a", top_n: 10 }, 60_000));
  const s = screenRaw ? evidenceOf(screenRaw, 10) : [];
  if (s.length > 0) out.push("【头部个股截面】", ...s);
  const [, sectorRaw] = await settle(invokeVtTool("get_sector_info", { mode: "ranking", limit: 8 }, 60_000));
  const b = sectorRaw ? sectorEvidenceOf(sectorRaw, 8) : [];
  if (b.length > 0) out.push("【行业板块今日强弱】", ...b);
  const [, dtRaw] = await settle(invokeVtTool("get_dragon_tiger", { date: today }, 60_000));
  const d = dtRaw ? dragonTigerEvidenceOf(dtRaw, 5) : [];
  if (d.length > 0) out.push("【龙虎榜净买前列】", ...d);
  return out;
}

/** 一条因子判决 → 一行摘要（t 值、过几关、DSR 运气线）。 */
export function summarizeRunRow(r: FactorRunRow): string {
  const gates = Object.values(r.gates).filter(Boolean).length;
  const dsr = r.dsr ? `，DSR ${(r.dsr.value * 100).toFixed(0)}%${r.dsr.survives ? "（过运气线）" : `（运气线 ${(r.dsr.expectedMax * 100).toFixed(0)}% 未过）`}` : "";
  return `- ${r.name}（${r.factor}）：t=${r.t.toFixed(2)}，6 关过 ${gates}/6${dsr}`;
}

/** 队列统计 → 几行中文。 */
export function summarizeQueue(entries: { status: string }[]): string[] {
  const count = (s: string) => entries.filter((e) => e.status === s).length;
  const alive = entries.length - count("tombstone");
  return [
    `- 队列共 ${entries.length} 条，活着 ${alive}（待验 ${count("pending")} / 测过 ${count("tested")} / 已过 6 关 ${count("passed")}），坟墓 ${count("tombstone")}`,
  ];
}

/**
 * 挑战者纸面样本 → 每挑战者一行进度（已平仓/持仓/最近建仓/距 Welch 差几笔）。
 * 纯函数：账本行由调用方收齐传入。诊断之前看不到这块，会把「攒样本速度」
 * 说成「无法核实」——账本里明明有 variant 行，喂给它。
 */
export function summarizeChallengerSamples(
  challengers: { id: string; name: string }[],
  variantTrades: { variant: string; exit: number | null; date: string }[],
): string[] {
  return challengers.slice(-20).map((c) => {
    const mine = variantTrades.filter((t) => t.variant === c.id);
    if (mine.length === 0) {
      return `- ${c.name}（${c.id}）：账本里还看不到它的纸面样本（开跑以来可能没有成交过）`;
    }
    const closed = mine.filter((t) => t.exit != null).length;
    const open = mine.length - closed;
    const last = mine.reduce((a, t) => (t.date > a ? t.date : a), "");
    const need = CHALLENGER_RULE.minTrades;
    return `- ${c.name}（${c.id}）：纸面样本 ${mine.length} 笔（已平仓 ${closed} / 持仓 ${open}），最近建仓 ${last}，Welch 判决要 ${need} 笔已平仓${closed >= need ? "，已够格" : `，还差 ${need - closed} 笔`}`;
  });
}

// ── 诊断 prompt（纯函数） ───────────────────────────────────────

/** 把账本快照组装成诊断 prompt。只陈述事实 + 要 JSON，不诱导结论。 */
export function buildDiagnosisPrompt(snap: LedgerSnapshot): string {
  return [
    "你是这个 A 股量化系统的 AI 管家。下面是整个系统的最新账本。你的任务是诊断，不是行动——输出一份诊断报告，人类会读它并决定下一步。",
    "",
    "【因子层：最近一批 6 关判决】",
    snap.factorLines.join("\n") || "- （还没有判决数据）",
    "",
    `【因子层：历史规模】${snap.factorMeta}`,
    "",
    "【待验队列现状】",
    snap.queueLines.join("\n"),
    "",
    "【死因档案（被淘汰因子的败因）】",
    snap.necropsy.join("\n") || "- （档案是空的）",
    "",
    "【策略层：实盘冠军参数】",
    snap.championLines.join("\n"),
    "",
    "【策略层：挑战者（纸面攒样本中）】",
    snap.chalLines.join("\n") || "- （没有在跑的挑战者）",
    ...(snap.chalSampleLines.length > 0
      ? ["", "挑战者纸面样本进度（账本 variant 行数，攒够才能 Welch 判决）：", ...snap.chalSampleLines]
      : []),
    "",
    "【策略层：策略闸】",
    snap.gateLines.join("\n"),
    "",
    "【AI 自身：近几轮进化成败】",
    snap.selfHistory.join("\n") || "- （还没有记录）",
    "",
    "【当日市场证据（Vibe-Trading 工具拉的实时快照）】",
    snap.marketEvidence.length > 0
      ? [...snap.marketEvidence, "", "注意：这是当日截面快照，只用来校准「现在市场处于什么状态」，不要当成历史规律引用。"].join("\n")
      : "- （工具离线或没拉到，基于账本诊断即可）",
    "",
    "输出要求：只输出一个 JSON 对象，不要输出任何别的文字。结构：",
    '{',
    '  "summary": "一句话总评：整个系统现在最该关注的一件事",',
    '  "factorLayer": "因子层诊断：哪类因子在失效/生效，死因档案里有没有共性，队列是不是健康",',
    '  "strategyLayer": "策略层诊断：挑战者攒样本速度、冠军参数有没有该警惕的迹象、策略闸状态",',
    '  "suggestions": ["建议动作，1~3 条，每条一句。只能是「提议新因子/提名挑战者/请求人工检查」这类不碰判决规则的动作"],',
    '  "ruleChangeRequests": ["规则变更请求：如果你觉得某条判决规则（6 关阈值/Welch t 值/淘汰次数）不合理，写在这里并给理由；没有就空数组。注意：你只能请求，人类批了才生效"]',
    '}',
    "",
    "铁律：1) 所有判断必须引用账本里的具体数字，不许泛泛而谈；2) 不许给出任何具体股票的买卖建议；3) 不许假设账本里没有的数据。",
    RED_LINE_PROMPT,
  ].join("\n");
}

// ── 诊断报告解析（纯函数） ─────────────────────────────────────

export type AgentDiagnosis = {
  summary: string;
  factorLayer: string;
  strategyLayer: string;
  suggestions: string[];
  ruleChangeRequests: string[];
};

/** 从模型输出里抠 JSON：找第一个 { 到最后一个 }，解析失败返回 null。 */
export function extractJson(raw: string): string | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  return raw.slice(start, end + 1);
}

/**
 * 校验诊断 JSON：五个字段类型对就收（缺的补默认），完全不是对象返回 null。
 * 宽松校验——这是展示层不是判决层，人读的时候会自己判断成色。
 */
export function parseDiagnosis(raw: string): AgentDiagnosis | null {
  const text = extractJson(raw);
  if (!text) return null;
  try {
    const d = JSON.parse(text) as Record<string, unknown>;
    if (typeof d !== "object" || d === null) return null;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const arr = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    return {
      summary: str(d.summary),
      factorLayer: str(d.factorLayer),
      strategyLayer: str(d.strategyLayer),
      suggestions: arr(d.suggestions),
      ruleChangeRequests: arr(d.ruleChangeRequests),
    };
  } catch {
    return null;
  }
}

// ── VT7：诊断报告的数字核验（展示侧标注，非阻断） ─────────────

export type DiagnosisNumberCheck = { ungrounded: string[] };

/**
 * 诊断报告引用的每个数字，应能在本轮账本快照里找到出处。
 * 借 Vibe grounding gate 的思想，但只落在诊断面：报告照常落地，无出处的数字
 * 列进 numberCheck 给人看——AI 自查「前视/编数」的第一步。
 *
 * ⚠️ 同款局限照写在这：只核对「数字在快照里出现过」，不核对「用在了对的地方」。
 *    而且这是标注不是拦截：诊断里合法但快照里没原文的数（比如快照没有挑战者时
 *    引用 Welch 的 30 笔阈值）也会被标出，人读的时候自行判断成色。
 */
export function verifyDiagnosisNumbers(d: AgentDiagnosis, snap: LedgerSnapshot): DiagnosisNumberCheck {
  const corpus = [
    ...snap.factorLines, snap.factorMeta, ...snap.queueLines, ...snap.necropsy,
    ...snap.championLines, ...snap.chalLines, ...snap.chalSampleLines,
    ...snap.gateLines, ...snap.selfHistory, ...snap.marketEvidence,
  ];
  const ungrounded: string[] = [];
  for (const field of [d.summary, d.factorLayer, d.strategyLayer, ...d.suggestions, ...d.ruleChangeRequests]) {
    ungrounded.push(...screenNumbers(field, corpus).replaced);
  }
  return { ungrounded: [...new Set(ungrounded)].slice(0, 10) };
}

// ── 收集 + 运行（server-only：fs + fetch） ──────────────────────

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data");
}

export const agentDiagnosisPath = () => posixJoin(dataDir(), "agent-diagnosis.json");

/** 读最近一次诊断报告（文件没有/坏了 → null）。给页面用。 */
export async function readAgentDiagnosis(): Promise<(AgentDiagnosis & { at: string; numberCheck?: DiagnosisNumberCheck | null }) | null> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(agentDiagnosisPath(), "utf8")) as AgentDiagnosis & { at?: unknown; numberCheck?: DiagnosisNumberCheck | null };
    if (typeof parsed.summary === "string" && typeof parsed.at === "string") return parsed as AgentDiagnosis & { at: string; numberCheck?: DiagnosisNumberCheck | null };
  } catch {
    // 还没诊断过，正常。
  }
  return null;
}

/**
 * 最近一次诊断的 suggestions，给因子/策略提议 prompt 当 plan 层输入——
 * 诊断（observe）→ 建议（plan）→ 提议通道（act）的自动接线，不用人逐条手抄。
 * 读不到/没有建议返回 []：诊断是增强项不是依赖项，提议照跑。
 * 每条带诊断日期，免得模型把陈旧建议当当下指令。
 */
export async function fetchDiagnosisHints(): Promise<string[]> {
  try {
    const diag = await readAgentDiagnosis();
    if (!diag || diag.suggestions.length === 0) return [];
    const day = diag.at.slice(0, 10);
    return diag.suggestions.map((s) => `- ${s}（诊断 ${day}）`);
  } catch {
    return [];
  }
}

/** 把整个账本读成快照。任何一块读失败都降级为空（诊断不能因为一块挂了而跑不了）。 */
export async function collectLedgerSnapshot(): Promise<LedgerSnapshot> {
  const runs = await readFactorRuns();
  const { entries } = await readQueue();
  const chalFile = await readChallengers();
  const champions = await readChampions();
  const log = await readAILog();
  const styleName = (id: string) => STYLES.find((s) => s.id === id)?.name ?? id;

  const batch = runs.batch;
  const factorMeta = batch
    ? `共 ${runs.batches.length} 批判决；最近一批 ${batch.at.slice(0, 10)}，${batch.rows.length} 个因子，样本 ${batch.nDays} 个交易日`
    : "还没有判决数据";

  const championLines = ACTIVE_STYLES.map((style) => {
    const version = champions[style];
    if (!version) return `- ${styleName(style)}：代码默认参数（持有${holdOf(style)}天）`;
    const promoted = chalFile.list.find((c) => c.id === version);
    if (!promoted) return `- ${styleName(style)}：参数版本「${version}」找不到记录，按默认对待`;
    return `- ${styleName(style)}：${promoted.name}（持有${promoted.holdDays ?? holdOf(style)}天 / 止损${promoted.stopPct ?? "内置"}% / 目标${promoted.targetPct ?? "内置"}%）`;
  });

  const chalLines = chalFile.list
    .slice(-20)
    .map((c) => `- ${c.name}（${c.id}）：挑战「${styleName(c.style)}」，状态 ${c.status}，${c.since} 开跑${c.source === "ai" ? "，AI 提名" : ""}`);

  // 挑战者纸面样本：全用户账本里 variant=挑战者id 的行（采集逻辑在
  // challenger-samples.ts，strategy-ai 也用同一份）。账本读失败降级为空——
  // 诊断不能因为一块挂了而跑不了，只是这条进度行缺位。
  let chalSamples: ChallengerSample[] = [];
  try {
    chalSamples = await collectChallengerSamples();
  } catch {
    chalSamples = [];
  }
  const chalSampleLines = summarizeChallengerSamples(chalFile.list, chalSamples);

  const gates = await readStrategyGates();
  const gateLines = Object.entries(gates).map(([style, g]) =>
    `- ${styleName(style)}：${g.state === "disabled" ? `停用中（第 ${g.strikes} 次，冷却 ${g.cooldownDays} 交易日）` : "假释观察中"}，${g.reason}`,
  );

  const stats = evolveStats(log, entries, chalFile.list);
  const selfHistory = [
    `- 因子层进化 ${stats.factorRounds} 轮，策略层 ${stats.strategyRounds} 轮（账本前 ${Math.min(log.length, 8)} 条）`,
    ...log.slice(-8).map((e) => `- ${e.at.slice(0, 16).replace("T", " ")} ${e.layer} ${e.trigger}：${e.ok ? "ok" : `失败（${e.error ?? "未知"}）`}，提议 ${e.proposed.length}`),
  ];

  // 市场证据（增强项）：VT 工具矿山拉当日 A 股头部快照。离线/超时/解析失败
  // 都降级为空数组——诊断不能因为工具矿山塌了而缺席。
  let marketEvidence: string[] = [];
  try {
    const { invokeVtTool } = await import("./vt-tools.ts");
    const raw = await invokeVtTool("screen_market", { market: "a", top_n: 10 }, 60_000);
    marketEvidence = evidenceOf(raw);
  } catch {
    marketEvidence = [];
  }

  return {
    at: new Date().toISOString(),
    factorLines: (batch?.rows ?? []).map(summarizeRunRow),
    factorMeta,
    queueLines: summarizeQueue(entries),
    necropsy: necropsyLines(await readTombstones()),
    championLines,
    chalLines,
    chalSampleLines,
    gateLines,
    selfHistory,
    marketEvidence,
  };
}

export type AgentLoopResult = {
  ok: boolean;
  diagnosis: AgentDiagnosis | null;
  error?: string;
};

/**
 * 跑一轮诊断：收集账本 → 组 prompt → 调 AI → 校验 JSON → 落报告 + 记账。
 * 只诊断不行动；失败也记 ai-log（layer=agent），静默缺席比诊断不出更害人。
 */
export async function runAgentDiagnosis(trigger: "manual" | "auto" = "manual"): Promise<AgentLoopResult> {
  const at = new Date().toISOString();
  const logFail = async (error: string): Promise<AgentLoopResult> => {
    const result: AgentLoopResult = { ok: false, diagnosis: null, error };
    await appendAILog({ at, layer: "agent", trigger, ok: false, proposed: [], rejected: [], error });
    return result;
  };

  const config = await readAIConfig();
  if (!config) return logFail("AI 接口还没配置（/ai 页填 baseUrl / apiKey / model）");

  const snap = await collectLedgerSnapshot();
  let raw: string;
  try {
    raw = await callAIWithFallback(buildDiagnosisPrompt(snap), { layer: "agent", trigger });
  } catch (error) {
    return logFail(error instanceof Error ? error.message : String(error));
  }

  const diagnosis = parseDiagnosis(raw);
  if (!diagnosis) {
    return logFail(`AI 返回不是合法诊断 JSON（原文前 200 字：${raw.trim().slice(0, 200) || "空白"}）`);
  }

  // VT7：数字核验是展示侧标注，任何失败都不许拖垮诊断报告本身。
  let numberCheck: DiagnosisNumberCheck | null = null;
  try {
    numberCheck = verifyDiagnosisNumbers(diagnosis, snap);
  } catch {
    numberCheck = null;
  }

  const { mkdir, writeFile } = await fsApi();
  await mkdir(posixDirname(agentDiagnosisPath()), { recursive: true });
  await writeFile(agentDiagnosisPath(), JSON.stringify({ at, ...diagnosis, numberCheck }, null, 2));
  await appendAILog({
    at,
    layer: "agent",
    trigger,
    ok: true,
    proposed: [],
    rejected: [],
    note:
      numberCheck && numberCheck.ungrounded.length > 0
        ? `${diagnosis.summary}｜数字核验：${numberCheck.ungrounded.length} 个数无出处（${numberCheck.ungrounded.join("、")}）`
        : diagnosis.summary,
  });
  return { ok: true, diagnosis };
}
