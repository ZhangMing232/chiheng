/**
 * 这个文件是干什么的：
 * 失败归因——回答「亏在哪、为什么这样会亏、下一步怎么办」。两条线：
 *
 * ① 逐笔亏损归因：按退出原因（止损 / 到期 / 目标）分 cause，并解释「这个机制
 *    为什么会吃掉钱」；跳空穿过止损单独拎出来，因为它让亏损超出计划。
 * ② 挑战者判决归因：每次 promote/reject/inconclusive 记一条结构化档案，说清
 *    「为什么转正 / 为什么淘汰」，append-only 落盘（仿 factor-tombstones）。
 *
 * 产出的归因段落喂给 AI 诊断 prompt（agent-loop），让优化循环先读懂失败、再出
 * 下一步建议——这就是「判决规则不要写死、按失败找原因」的数据底座。
 *
 * 你需要知道的（纪律，和 factor-tombstones 同规矩）：
 * - **老账没记退出原因**：2026-10-28 之前 settle 只落 exit/exitDate/exitKind，
 *   没落 reason。这类交易一律标 cause=unknown_legacy，明说「判不了、不下因果结论」，
 *   绝不拿价格反推一个像模像样的原因。——「拿不到 ≠ 没有」。
 * - 逐笔指数对照 v1 未接：不做「系统性回撤」标注，summary.missing 里明说缺什么。
 *   连亏方向已有 portfolio-health 的「对照指数看是系统性还是打法失灵」，两边互补。
 * - 纯函数（attribute* / summarize* / *Lines）不碰 fs，直接单测；
 *   append/read 在最外层，data 目录约定同 factor-tombstones。
 * - 浏览器兼容：node API 必须函数内动态 import，路径拼接用 posixJoin（见 challinfo 头注）。
 */

const fsApi = () => import("node:fs/promises");
/** POSIX 风格拼路径。不用 node:path——顶层 import 它会在客户端崩（同 challenger.ts 头注）。 */
const posixJoin = (...parts: string[]): string => parts.join("/");
import { netReturn } from "./journal-book.ts";

// ── 逐笔亏损归因 ──────────────────────────────────────────────────

/** 从账本里能拿到的交易最小结构（兼容旧账：exitReason 可能缺）。 */
export type AttributableTrade = {
  id: string;
  name?: string;
  entry?: number;
  exit?: number | null;
  stop?: number;
  target?: number;
  style?: string;
  variant?: string;
  /** 退出原因。老账没有这个字段——缺 = unknown_legacy，不猜。 */
  exitReason?: string;
};

/** 亏损原因分类。 */
export type LossCause =
  /** 止损按计划触发（成交价 ≈ 止损价）。 */
  | "stop_planned"
  /** 跳空低开穿过止损价，成交在止损下方——亏损超出计划。 */
  | "gap_down"
  /** 持有到期仍没走出来，按收盘价结掉——信号失效。 */
  | "time_exit"
  /** 老账没记退出原因，判不了。 */
  | "unknown_legacy";

export type TradeLossAttrib = {
  id: string;
  name?: string;
  style?: string;
  variant?: string;
  /** 扣费后净收益（百分数，-3.2 = 亏 3.2%）。 */
  retPct: number;
  cause: LossCause;
  /** 当天大盘也跌（markdown）→ 可能是系统性回撤而非选股问题。v1 常为 false（没接逐笔指数）。 */
  systematic: boolean;
  /** 为什么这样会导致亏损（给人和 AI 读的一句话因果）。 */
  causal: string;
  /** 退出日的大盘涨跌（%）。没有 = null（不拿 0 顶替）。 */
  marketRetPct: number | null;
};

/** 各 cause 的默认因果解释：机制层面「为什么会亏」。 */
const CAUSE_CAUSAL: Record<LossCause, string> = {
  stop_planned:
    "止损按计划触发，亏的是预设的那口风险。震荡市里止损常被正常波动反复打掉——如果这批止损单之后多数反弹，说明止损太紧、把波动当成了风险，不是选股错。",
  gap_down:
    "跳空低开直接穿过止损价，实际成交在止损下方，止损的保护被削弱——亏损超出计划，常见于突发利空 / 除权除息 / 停牌复牌，这类风险止损单本身防不住。",
  time_exit:
    "持有到期仍没走出来，按收盘价结掉——既不是止损也不是止盈，是入场信号在这轮没兑现（信号失效，不是风险控制问题）。",
  unknown_legacy:
    "老账没有记退出原因（2026-10-28 之前结算的交易未落 exitReason），无法判定是止损 / 到期 / 目标，只能看盈亏数字，不下因果结论。",
};

/**
 * 归因一笔已平仓交易。不是亏损（未平仓 / 净收益 ≥ 0）返回 null。
 * ctx.marketRetPct 可选：给了且大盘跌，就标 systematic 并在因果后面补一句。
 */
export function attributeTradeLoss(
  trade: AttributableTrade,
  ctx: { marketRetPct?: number | null } = {},
): TradeLossAttrib | null {
  if (trade.exit == null || typeof trade.entry !== "number") return null;
  const net = netReturn(trade.entry, trade.exit);
  if (net == null || net >= 0) return null;

  const reason = trade.exitReason ?? "";
  let cause: LossCause;
  if (reason === "stop") {
    // 成交价明显低于止损价（留 0.5% 容差挡四舍五入）→ 跳空穿止损。
    cause =
      trade.stop != null && trade.exit < trade.stop * 0.995 ? "gap_down" : "stop_planned";
  } else if (reason === "time") {
    cause = "time_exit";
  } else {
    // target 出场却亏钱（异常）或没有 reason（老账）→ 一律当判不了，不猜。
    cause = "unknown_legacy";
  }

  const marketRetPct = typeof ctx.marketRetPct === "number" ? ctx.marketRetPct : null;
  const systematic = marketRetPct != null && marketRetPct <= -0.5;
  const causal =
    systematic && cause !== "unknown_legacy"
      ? `${CAUSE_CAUSAL[cause]}当天大盘 ${marketRetPct!.toFixed(2)}%，亏损里含系统性回撤成分，换参数救不了，要看的是仓位/择时。`
      : CAUSE_CAUSAL[cause];

  return {
    id: trade.id,
    name: trade.name,
    style: trade.style,
    variant: trade.variant,
    retPct: +(net * 100).toFixed(2),
    cause,
    systematic,
    causal,
    marketRetPct,
  };
}

export type LossCauseSummary = {
  cause: LossCause;
  count: number;
  /** 平均净收益（百分数，负数）。 */
  avgRetPct: number;
  /** 最差的一笔（百分数，负数）。 */
  worstPct: number;
  /** 其中带系统性回撤标注的笔数。 */
  systematicCount: number;
  /** 最多 3 个样例（代码/名称/收益），给人看具体是哪几笔。 */
  examples: { id: string; name?: string; retPct: number }[];
  causal: string;
};

export type TradeLossSummary = {
  /** 有交易的总笔数（含盈利）。 */
  total: number;
  /** 亏损笔数。 */
  losses: number;
  byCause: LossCauseSummary[];
  /** 拿不到的数据（≠ 没有）。 */
  missing: string[];
};

/** 把逐笔归因聚合成按 cause 的汇总。没有亏损时 byCause 为空数组（不是 0 笔的假条目）。 */
export function summarizeTradeLosses(attribs: TradeLossAttrib[]): TradeLossSummary {
  const losses = attribs.length;
  const groups = new Map<LossCause, TradeLossAttrib[]>();
  for (const a of attribs) {
    const list = groups.get(a.cause) ?? [];
    list.push(a);
    groups.set(a.cause, list);
  }
  const byCause: LossCauseSummary[] = [...groups.entries()]
    .map(([cause, list]) => {
      const sum = list.reduce((s, a) => s + a.retPct, 0);
      return {
        cause,
        count: list.length,
        avgRetPct: +(sum / list.length).toFixed(2),
        worstPct: Math.min(...list.map((a) => a.retPct)),
        systematicCount: list.filter((a) => a.systematic).length,
        examples: list
          .slice()
          .sort((a, b) => a.retPct - b.retPct)
          .slice(0, 3)
          .map((a) => ({ id: a.id, name: a.name, retPct: a.retPct })),
        causal: CAUSE_CAUSAL[cause],
      };
    })
    .sort((a, b) => b.count - a.count);
  const missing: string[] = [];
  return { total: losses, losses, byCause, missing };
}

/** 归因汇总 → AI 诊断 prompt 段落（string[]，调用方直接展开拼）。没有亏损返回空数组。 */
export function lossAttribLines(summary: TradeLossSummary, maxCauses = 6): string[] {
  if (summary.losses === 0) return [];
  const header = `已平仓亏损 ${summary.losses} 笔，按亏损原因分：`;
  const lines = summary.byCause.slice(0, maxCauses).map((c) => {
    const ex =
      c.examples.length > 0
        ? `，例：${c.examples.map((e) => `${e.name ?? e.id} ${e.retPct}%`).join("、")}`
        : "";
    return `- ${CAUSE_LABEL[c.cause]} ×${c.count}（均 ${c.avgRetPct}%，最差 ${c.worstPct}%${ex}）`;
  });
  return [header, ...lines];
}

/** cause → 中文标签（面板与 prompt 共用，避免两处各写一遍）。 */
export const CAUSE_LABEL: Record<LossCause, string> = {
  stop_planned: "止损按计划触发",
  gap_down: "跳空穿止损",
  time_exit: "持有到期没走出来",
  unknown_legacy: "退出原因未记（老账）",
};

// ── 挑战者判决归因 ────────────────────────────────────────────────

export type ChallengerVerdictCause =
  /** 挑战者显著更好，转正——差异来自出场参数不是选股。 */
  | "promote_superior"
  /** 提前否决：建仓满时间盒后仍跑输冠军。 */
  | "reject_early_gap"
  /** 挑战者自身样本质量不过关（t ≤ 阈值）。 */
  | "reject_own_quality"
  /** 其他淘汰（兜底）。 */
  | "reject_other"
  /** 跑满上限仍分不出胜负。 */
  | "inconclusive_max_trades";

export const VERDICT_CAUSE_LABEL: Record<ChallengerVerdictCause, string> = {
  promote_superior: "显著更好·转正",
  reject_early_gap: "提前否决·跑输冠军",
  reject_own_quality: "自身质量不过关·淘汰",
  reject_other: "其他淘汰",
  inconclusive_max_trades: "跑满上限·分不出",
};

const VERDICT_CAUSAL: Record<ChallengerVerdictCause, string> = {
  promote_superior:
    "同一份选股名单、只换出场参数（持有天数/止损/目标），挑战者均值显著更高 → 收益差异来自出场参数，不是选股；转正后冠军换成这套参数。",
  reject_early_gap:
    "建仓满时间盒后纸面均值仍跑输冠军超过阈值 → 这组参数方向不对；时间盒已到，继续攒样本只是浪费，淘汰把名额让给新提名。",
  reject_own_quality:
    "挑战者自己这批已平仓样本 t ≤ 淘汰线 → 是这组参数本身在亏，不是「跟冠军比」的问题；先处理它自己的负 edge。",
  reject_other:
    "淘汰，但原因不在预登记的几类主因里，回溯 reason 原文看细节。",
  inconclusive_max_trades:
    "跑满上限笔数仍分不出胜负 → 这组参数与冠军无实质差异，停跑不再占样本。",
};

export type ChallengerVerdict = {
  /** ISO 时间。 */
  at: string;
  /** 交易日。 */
  day: string;
  id: string;
  style: string;
  name: string;
  action: "promote" | "reject" | "inconclusive";
  cause: ChallengerVerdictCause;
  /** judgeChallenger 给的原文理由（带数字）。 */
  reason: string;
  /** 为什么（机制层因果）。 */
  causal: string;
  chalN: number;
  champN: number;
  chalMeanPct: number | null;
  champMeanPct: number | null;
  /** 参数摘要（持X天 / 止损Y% / 目标Z%）。 */
  params: string;
};

/** 从 action + reason 文案反推 cause。reason 由 judgeChallenger 确定性生成，映射稳定。 */
export function verdictCauseOf(action: ChallengerVerdict["action"], reason: string): ChallengerVerdictCause {
  if (action === "promote") return "promote_superior";
  if (action === "inconclusive") return "inconclusive_max_trades";
  if (reason.includes("提前否决")) return "reject_early_gap";
  if (reason.includes("自身质量")) return "reject_own_quality";
  return "reject_other";
}

const meanPct = (rets: number[]): number | null =>
  rets.length > 0 ? +((rets.reduce((s, x) => s + x, 0) / rets.length) * 100).toFixed(2) : null;

/**
 * 组装一条挑战者判决档案。纯函数：champRets/chalRets 是调用方按
 * style:champion / style:chal.id 分好桶的逐笔净收益（和判决同一口径）。
 */
export function attributeChallengerVerdict(input: {
  chal: { id: string; style: string; name: string; holdDays?: number; stopPct?: number; targetPct?: number };
  action: ChallengerVerdict["action"];
  reason: string;
  champRets: number[];
  chalRets: number[];
  day: string;
  at?: string;
}): ChallengerVerdict {
  const { chal, action, reason, champRets, chalRets, day } = input;
  const cause = verdictCauseOf(action, reason);
  const params = [
    chal.holdDays != null ? `持${chal.holdDays}天` : null,
    chal.stopPct != null ? `止损${chal.stopPct}%` : null,
    chal.targetPct != null ? `目标${chal.targetPct}%` : null,
  ].filter(Boolean);
  return {
    at: input.at ?? new Date().toISOString(),
    day,
    id: chal.id,
    style: chal.style,
    name: chal.name,
    action,
    cause,
    reason,
    causal: VERDICT_CAUSAL[cause],
    chalN: chalRets.length,
    champN: champRets.length,
    chalMeanPct: meanPct(chalRets),
    champMeanPct: meanPct(champRets),
    params: params.length > 0 ? params.join(" / ") : "参数同冠军",
  };
}

/** 判决档案 → AI 诊断 prompt 段落。没有档案返回空数组。最多列 maxList 条（新的在前）。 */
export function challengerVerdictLines(verdicts: ChallengerVerdict[], maxList = 10): string[] {
  if (verdicts.length === 0) return [];
  const listed = [...verdicts].sort((a, b) => b.at.localeCompare(a.at)).slice(0, maxList);
  return [
    `挑战者判决档案 ${verdicts.length} 条（新的在前）：`,
    ...listed.map(
      (v) =>
        `- ${v.name}（${v.style}｜${v.params}）${VERDICT_CAUSE_LABEL[v.cause]}：挑战者 ${v.chalN} 笔均 ${v.chalMeanPct ?? "—"}% vs 冠军 ${v.champN} 笔 ${v.champMeanPct ?? "—"}%`,
    ),
  ];
}

// ── 文件 IO（append-only，server-only）───────────────────────────

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data");
}

const verdictPath = () => posixJoin(dataDir(), "backtest", "challenger-verdicts.jsonl");

/** 追加一批判决档案。读不到旧文件不影响追加（从头建）。 */
export async function appendChallengerVerdicts(records: ChallengerVerdict[]): Promise<void> {
  if (records.length === 0) return;
  const { appendFile, mkdir } = await fsApi();
  await mkdir(posixJoin(dataDir(), "backtest"), { recursive: true });
  await appendFile(verdictPath(), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

/** 读全部判决档案。文件不存在 / 坏了 → 空数组，绝不抛错（和 readTombstones 同一取舍）。 */
export async function readChallengerVerdicts(): Promise<ChallengerVerdict[]> {
  try {
    const { readFile } = await fsApi();
    const raw = await readFile(verdictPath(), "utf8");
    return raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as ChallengerVerdict);
  } catch {
    return [];
  }
}
