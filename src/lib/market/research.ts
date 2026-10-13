/**
 * 这个文件是干什么的：
 * 个股研判流水线——学 Vibe-Research 的 `company-research` 六阶段 SOP 改的赤轨版。
 * 一阶段只回答一个问题，每阶段的产物只有三样：证据（带来源）、发现（带可信度档）、
 * 缺口（明确写缺什么）。它的目的不是给结论，而是把「知道什么、凭什么知道、还不知道什么」
 * 三件事分开摆出来。
 *
 * 你需要知道的（纪律）：
 * 1. **这是研究，不是建议**。每条 finding 产出后都过 red-line 的 `screenAdvice`：
 *    命中就换成占位句并留一条说明，**不静默删除**——读者有权知道这里少了一句话。
 *    现在模板句干净，护栏看着多余；等 AI 产出接进来（第二批），它才开始真正干活。
 *    这是「先装护栏再通车」，不是过度设计。
 * 2. **四档可信度沿用 Vibe-Research 的 inference_tiers**：已披露证实 / 有依据的推断 /
 *    未核实线索 / 被反证。不用「高/中/低」——那三个词没有主语，读者分不清信的是
 *    数据还是某人的判断。
 * 3. **拿不到就写缺口**，不许补 0 或拿空数组冒充「没有」。和 factors-view 同源的铁律：
 *    缺的数据和「确认没有」是两件事，不许用前者冒充后者。
 * 4. **有价值数据才用**：新浪源的 d5/d10/d20/d60 整批为 null（主源降级时
 *    会出现），这里一律当缺口，不当 0%。
 * 5. 纯函数：不碰 fs / fetch，取数由调用方负责，直接单测。
 */

import type { Quote } from "./types.ts";
import type { StockArticle } from "./news.ts";
import { screenAdvice } from "./red-line.ts";
import { makeCalculation, makeEvidence, formatChain, verifyChain } from "./evidence.ts";
import { screenNumbers } from "./number-gate.ts";
import { valuationJudgement } from "./valuation-sop.ts";
import { decisionPointsFrom } from "./catalyst-sop.ts";
import { readEarnings, type EarningsPoint } from "./earnings-sop.ts";
import { readFinancials, type FinancialRow } from "./financials.ts";
import type { ConsensusRead } from "./consensus.ts";
import type { KnowledgeFile } from "./knowledge.ts";
import { checkOldPoints } from "./knowledge.ts";
import { technicalIndicators, type KlineRow } from "./indicators.ts";
import { rankPhrase, type ValuationPosition } from "./pe-history.ts";

/** 四档可信度（学 Vibe-Research `orchestrator/src/finance/inference_tiers.ts`，同一组词）。 */
export const RESEARCH_TIERS = ["已披露证实", "有依据的推断", "未核实线索", "被反证"] as const;
export type ResearchTier = (typeof RESEARCH_TIERS)[number];
/** 唯一允许没有依据的一档。其余三档都从真实数据算出，所以 tile 由代码给不出 KAfka。 */
export const UNVERIFIED: ResearchTier = "未核实线索";
export const CONFIRMED: ResearchTier = "已披露证实";
/** 由代码按规则推出、但不是原始数据本身。估值判读落在这档。 */
export const INFERRED: ResearchTier = "有依据的推断";

export type Evidence = {
  label: string;
  value: string;
  /** 这条数从哪来。写接口/文件名，不写「内部数据」这种找不到人的话。 */
  source: string;
  tier: ResearchTier;
};

export type Finding = { text: string; tier: ResearchTier };

/**
 * 经过运算得出的数字，带引用链（P0-3 证据层）。
 *
 * 只有「不是直接读来、而是算出来的」数字才配拥有它。直接读来的数（收盘价、市值）
 * 本身就是证据，套一层计算记录没有意义。
 */
export type DerivedNumber = {
  label: string;
  value: string;
  tier: ResearchTier;
  evidenceId: string;
  calcId: string;
  /** 人话版引用路径，复核时照着它走回原始序列 */
  chain: string;
};

export type StageId = (typeof STAGE_IDS)[number];

export type StageResult = {
  id: StageId;
  title: string;
  /** 这一阶段回答的问题。写在页面上，读者先看问题再看答案。 */
  question: string;
  evidence: Evidence[];
  findings: Finding[];
  gaps: string[];
  /** 算出来的数字。空数组 = 这个阶段没有运算产物。 */
  derived: DerivedNumber[];
};

export const STAGE_IDS = ["identity", "price", "capital", "catalyst", "valuation", "verdict"] as const;

export type ResearchInput = {
  /** null = 没拿到行情，此时所有阶段都只能出缺口 */
  quote: Quote | null;
  articles: StockArticle[];
  /**
   * 估值历史位置（PE/PB 分位）。来自 pe-history.ts + baostock。
   * 不给 = 这只票还没跑过抓取脚本，估值阶段会照实写成缺口；
   * **不许用当日 PE 绝对值反推一个假分位**。
   */
  valuation?: ValuationPosition | null;
  /**
   * 财报比率序列（累计口径的 dtYoy/gm/roe + 公告日期）。
   * 不给 = 没跑过抓取脚本或这只票没数据，催化剂阶段会写缺口。
   */
  earnings?: readonly EarningsPoint[] | null;
  /**
   * baostock 三表（D2：净利润/营收/EPS/杜邦/现金流 + 公告日期）。
   * 有它就能做单季/TTM/杜邦拆解；没有就退回只用比率转向判断。
   */
  financials?: readonly FinancialRow[] | null;
  /** 一致预期（D1：机构数 / 一致预期 EPS / 前瞻 CAGR / 分歧）。估值阶段算前瞻 PE 和 PEG。 */
  consensus?: ConsensusRead | null;
  /** 旧知识档案（A5）。有它就先核对上次的预警，旧结论只当待验证项不当事实。 */
  knowledge?: KnowledgeFile | null;
  /** 日线 K 线（前复权，fetch-kline.py 抓的）。技术指标的原料，没有就写缺口。 */
  klines?: readonly KlineRow[] | null;
};

export type ResearchReport = {
  symbol: string;
  name: string;
  stages: StageResult[];
  /** 全报告级别的缺口（标的没找到之类）。 */
  gaps: string[];
  /** 被红线拦下的条数。>0 说明写 prompt / 模板的人越线了。 */
  blocked: number;
  /** 被数字闸门换掉的数字个数。>0 = 有数字在材料里找不到出处。 */
  numbersReplaced: number;
  /**
   * 引用链健康度（P0-3）。
   * dangling 非空 = 有数字声称基于某条证据，而那条证据不在账里——
   * 比没有引用更糟，因为它伪装成有据可查。正常必须是空数组。
   */
  chain: { evidence: number; calculations: number; dangling: string[] };
};

const SOURCE_QUOTE = "行情快照（腾讯/新浪）";
const SOURCE_NEWS = "个股资讯与公告（巨潮 + 东财兜底）";

/** 百分比带符号。null 当缺口，由调用方处理。 */
function pct(value: number | null): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function identityStage(input: ResearchInput): StageResult {
  const { quote } = input;
  const gaps: string[] = [];
  if (!quote) gaps.push("没有拿到这只票的行情，身份无从确认");
  const q = quote;
  const evidence: Evidence[] = [];
  if (q) {
    evidence.push({ label: "代码", value: q.code, source: SOURCE_QUOTE, tier: CONFIRMED });
    evidence.push({ label: "板块", value: q.board, source: SOURCE_QUOTE, tier: CONFIRMED });
    evidence.push({ label: "流通市值", value: `${q.floatCap.toFixed(0)} 亿`, source: SOURCE_QUOTE, tier: CONFIRMED });
    evidence.push({ label: "换手率", value: `${q.turnover.toFixed(2)}%`, source: SOURCE_QUOTE, tier: CONFIRMED });
    if (q.st) gaps.push("这是 ST 或带退市风险标的，研发投入不在我们的选股范围里");
  }
  return {
    id: "identity",
    title: "标的身份",
    question: "这到底是什么票，多大规模，能不能纳入研究范围？",
    evidence,
    findings: q
      ? [{ text: `${q.name}（${q.code}）在 ${q.board} 上市，流通市值 ${q.floatCap.toFixed(0)} 亿。`, tier: CONFIRMED }]
      : [],
    gaps,
    derived: [],
  };
}

function priceStage(input: ResearchInput): StageResult {
  const { quote } = input;
  const gaps: string[] = [];
  const evidence: Evidence[] = [];
  if (!quote) {
    gaps.push("没有行情，价格位置无从判断");
    return { id: "price", title: "价格位置", question: "现在站在什么位置上？", evidence, findings: [], gaps, derived: [] };
  }
  const q = quote;
  const rows: [string, number | null][] = [
    ["今日", q.chg],
    ["近 5 日", q.d5],
    ["近 20 日", q.d20],
    ["近 60 日", q.d60],
    ["今年以来", q.ytd],
  ];
  for (const [label, value] of rows) {
    const text = pct(value);
    if (text == null) gaps.push(`${label}涨幅缺失（行情源降级时会整批没有，不是 0%）`);
    else evidence.push({ label, value: text, source: SOURCE_QUOTE, tier: CONFIRMED });
  }
  evidence.push({ label: "振幅", value: `${q.amp.toFixed(2)}%`, source: SOURCE_QUOTE, tier: CONFIRMED });
  evidence.push({ label: "量比", value: q.volRatio.toFixed(2), source: SOURCE_QUOTE, tier: CONFIRMED });

  const findings: Finding[] = [];
  if (q.d60 != null) {
    const trend = q.d60 > 0 ? "上升" : "下降";
    findings.push({
      text: `近 60 日累计 ${pct(q.d60)}，处于${trend}区间；这是描述位置，不代表位置本身会延续。`,
      tier: CONFIRMED,
    });
  }
  // 技术指标（A1）：有 K 线就算 MACD/KDJ/RSI/BOLL。**只摆数不做解读**——
  // 指标层不许出现「金叉买入」这类信号（indicators.ts 头注释的纪律），
  // 方向判断留给读者，赤轨只负责把数算对。
  if (input.klines && input.klines.length > 0) {
    const ind = technicalIndicators(input.klines);
    const SRC = "baostock 日线（前复权，scripts/fetch-kline.py）";
    if (ind.status === "ok") {
      evidence.push({ label: "K 线根数", value: `${ind.points} 根（${ind.window![0]}~${ind.window![1]}）`, source: SRC, tier: CONFIRMED });
      evidence.push({
        label: "MACD",
        value: `dif ${ind.macd!.dif.toFixed(3)} / dea ${ind.macd!.dea.toFixed(3)} / hist ${ind.macd!.hist.toFixed(3)}`,
        source: SRC,
        tier: CONFIRMED,
      });
      evidence.push({
        label: "KDJ",
        value: ind.kdj ? `K ${ind.kdj.k.toFixed(1)} / D ${ind.kdj.d.toFixed(1)} / J ${ind.kdj.j.toFixed(1)}` : "算不出",
        source: SRC,
        tier: CONFIRMED,
      });
      evidence.push({
        label: "RSI",
        value: `6 日 ${ind.rsi!.rsi6?.toFixed(1) ?? "—"} / 12 日 ${ind.rsi!.rsi12?.toFixed(1) ?? "—"} / 24 日 ${ind.rsi!.rsi24?.toFixed(1) ?? "—"}`,
        source: SRC,
        tier: CONFIRMED,
      });
      evidence.push({
        label: "BOLL",
        value: ind.boll ? `上 ${ind.boll.upper.toFixed(2)} / 中 ${ind.boll.middle.toFixed(2)} / 下 ${ind.boll.lower.toFixed(2)}（带宽 ${ind.boll.bandwidthPct.toFixed(1)}%）` : "算不出",
        source: SRC,
        tier: CONFIRMED,
      });
      findings.push({
        text: "技术指标只是数值（MACD/KDJ/RSI/BOLL，口径与 Vibe-Research 逐字对齐）。赤轨不解读方向——「金叉」「超买」这类判断留给读者，指标层不许给信号。",
        tier: CONFIRMED,
      });
    } else if (ind.status === "not_meaningful") {
      gaps.push(`K 线不足 ${ind.points} 根，技术指标不可靠（跑 scripts/fetch-kline.py 补齐）`);
    } else {
      gaps.push(`K 线数据有问题：${ind.reason ?? "未知"}——指标没算，比算错强`);
    }
  } else {
    gaps.push("没有日线 K 线（跑 scripts/fetch-kline.py），技术指标这一段是空的");
  }

  return { id: "price", title: "价格位置", question: "现在站在什么位置上，贵了还是便宜了多久？", evidence, findings, gaps, derived: [] };
}

function capitalStage(input: ResearchInput): StageResult {
  const { quote } = input;
  const gaps: string[] = [];
  const evidence: Evidence[] = [];
  if (!quote) {
    gaps.push("没有行情，当日资金无从判断");
    return { id: "capital", title: "资金与成交", question: "今天谁在买？", evidence, findings: [], gaps, derived: [] };
  }
  const q = quote;
  const inflowYi = q.inflow / 10_000;
  evidence.push({
    label: "主力净流入",
    value: `${inflowYi >= 0 ? "+" : ""}${inflowYi.toFixed(3)} 亿`,
    source: SOURCE_QUOTE,
    tier: CONFIRMED,
  });
  evidence.push({ label: "成交额", value: `${(q.amount / 10_000).toFixed(2)} 亿`, source: SOURCE_QUOTE, tier: CONFIRMED });
  gaps.push("只有当日主力净额，缺个股历史资金流序列（东财单只 history 上限 120 天，未接入本页）");
  return {
    id: "capital",
    title: "资金与成交",
    question: "今天谁在买，成交额撑得住吗？",
    evidence,
    findings: [],
    gaps,
    derived: [],
  };
}

function catalystStage(input: ResearchInput): StageResult {
  const { articles } = input;
  const gaps: string[] = [];
  const evidence: Evidence[] = [];
  const findings: Finding[] = [];

  // 财报转向判断放在最前面：它不依赖资讯拉没拉到。
  // 放在 articles 分支之后会被「没拉到资讯」的提前返回挡住——2026-10-12 实测踩过，
  // 结果一只有财报但没资讯的票，催化剂阶段什么都没说出来。
  if (input.earnings && input.earnings.length > 0) {
    const read = readEarnings(input.earnings);
    for (const turn of read.turns) findings.push({ text: `${turn.label}：${turn.verdict}。${turn.caution}`, tier: INFERRED });
    for (const gap of read.gaps) if (!gaps.includes(gap)) gaps.push(gap);
  } else if (!(input.financials && input.financials.length > 0)) {
    // 三表也没有时才说「没有财报数据」——financials 本身就是财报数据，别重复报缺
    gaps.push("没有这只票的财报数据（跑 scripts/fetch-fundamentals.py 后重试）");
  }

  // 三表拆解（D2）：有 baostock 三表就做单季/TTM/杜邦/利润质量，这是比率转向判断
  // 之上更完整的一层。没有三表就退回只用比率（不硬凑）。
  // 关键：**数字先摆成 evidence 再下结论**——数字闸门要求每个出现在结论里的数
  // 都能在证据里找到出处，直接写进 findings 会被当成「没出处的数」换掉（踩过）。
  if (input.financials && input.financials.length > 0) {
    const fr = readFinancials(input.financials);
    const SRC = "baostock 三表（scripts/fetch-three-sheets.py）";
    if (fr.ttmNetProfit != null) {
      evidence.push({ label: "TTM 净利润", value: `${(fr.ttmNetProfit / 1e8).toFixed(0)} 亿`, source: SRC, tier: CONFIRMED });
      findings.push({ text: `TTM 净利润是滚动四个单季之和，不是某单季或某半年。`, tier: CONFIRMED });
    }
    if (fr.latestYoy != null) {
      evidence.push({ label: "最新单季净利润同比", value: `${(fr.latestYoy * 100).toFixed(1)}%`, source: SRC, tier: CONFIRMED });
      findings.push({ text: "最新单季同比是对去年同期单季，不是累计口径。", tier: INFERRED });
    }
    if (fr.dupont) {
      const d = fr.dupont;
      const value = `ROE ${(d.roe! * 100).toFixed(1)}% = 净利率 ${(d.nitogr! * 100).toFixed(1)}% × 周转 ${d.assetTurn!.toFixed(2)} × 权益乘数 ${d.assetToEquity!.toFixed(2)}`;
      evidence.push({ label: "杜邦拆解", value, source: SRC, tier: CONFIRMED });
      findings.push({ text: "ROE 可拆成净利率 × 周转 × 权益乘数，三者分别对应赚钱能力、经营效率、杠杆。", tier: CONFIRMED });
    }
    if (fr.cfoToNp != null) {
      evidence.push({ label: "经营现金流 / 净利润", value: fr.cfoToNp.toFixed(2), source: SRC, tier: CONFIRMED });
      findings.push({ text: fr.cfoToNp < 1 ? "经营现金流没跟上净利润，利润质量待查。" : "经营现金流覆盖了净利润，利润有现金支撑。", tier: CONFIRMED });
    }
    for (const gap of fr.gaps) if (!gaps.includes(gap)) gaps.push(gap);
  }

  if (articles.length === 0) {
    gaps.push("没有拉到这只票的资讯或公告，催化剂与风险这一段是空的");
    return { id: "catalyst", title: "催化剂与风险", question: "最近发生了什么，哪些是已经证实的？", evidence, findings, gaps, derived: [] };
  }
  findings.push({
    text: "利好利空按标题用词自动分档，机器读不出反讽和否认；这一档只是线索，不代表已核实。",
    tier: UNVERIFIED,
  });
  const good = articles.filter((a) => a.tone === "good").length;
  const bad = articles.filter((a) => a.tone === "bad").length;
  const anns = articles.filter((a) => a.kind === "ann").length;
  evidence.push({ label: "公告条数", value: String(anns), source: SOURCE_NEWS, tier: CONFIRMED });
  evidence.push({ label: "偏利好", value: String(good), source: SOURCE_NEWS, tier: CONFIRMED });
  evidence.push({ label: "偏利空", value: String(bad), source: SOURCE_NEWS, tier: CONFIRMED });
  for (const item of articles.slice(0, 5)) {
    evidence.push({ label: item.time.slice(0, 10), value: item.title, source: SOURCE_NEWS, tier: CONFIRMED });
  }
  return {
    id: "catalyst",
    title: "催化剂与风险",
    question: "最近发生了什么，哪些只是线索？",
    evidence,
    findings,
    gaps,
    derived: [],
  };
}

function valuationStage(input: ResearchInput): StageResult {
  const { quote, valuation } = input;
  const gaps: string[] = [];
  const evidence: Evidence[] = [];
  const derived: DerivedNumber[] = [];
  if (!quote) {
    gaps.push("没有行情，估值锚算不出来");
    return { id: "valuation", title: "估值锚", question: "贵不贵，相对于什么？", evidence, findings: [], gaps, derived };
  }
  const q = quote;
  if (q.pe == null) gaps.push("没有市盈率（亏损或未给出）");
  else evidence.push({ label: "市盈率 TTM", value: `${q.pe.toFixed(2)} 倍`, source: SOURCE_QUOTE, tier: CONFIRMED });
  if (q.pb == null) gaps.push("没有市净率");
  else evidence.push({ label: "市净率", value: `${q.pb.toFixed(2)} 倍`, source: SOURCE_QUOTE, tier: CONFIRMED });

  // 历史分位来自 baostock 序列（学 Vibe-Research：分位在 calc 层算，不在取数层做）。
  // 有序列就给位置；没有就明说没有，**不许拿当日 PE 绝对值反推一个假分位**。
  //
  // P0-3：分位是「算出来的数」，所以它带引用链——一条证据（序列里最新那个点）
  // + 一条计算（percentileRank）。页面上点得开，复核时能走回原始 bar。
  const findings: Finding[] = [];
  const latest = valuation?.latest ?? null;
  if (valuation?.peRank != null && latest?.peTTM != null) {
    const ev = makeEvidence({
      source: `baostock 序列 data/fundamentals/pe-${q.code}.json`,
      symbol: q.code,
      field: "peTTM",
      period: `${valuation.window?.from ?? "?"}~${valuation.window?.to ?? "?"}`,
      unit: "倍",
      adjustment: "none",
      asOf: latest.date,
      value: latest.peTTM,
    });
    const calc = makeCalculation({
      fn: "percentileRank",
      inputs: { points: valuation.points, value: latest.peTTM },
      inputsRefs: [ev.id],
      output: { value: Math.round(valuation.peRank * 100) / 100, unit: "分位", status: "ok" },
    });
    derived.push({
      label: "PE_TTM 历史位置",
      value: rankPhrase(valuation.peRank),
      tier: CONFIRMED,
      evidenceId: ev.id,
      calcId: calc.id,
      chain: formatChain(calc),
    });
  }
  if (valuation?.pbRank != null && latest?.pbMRQ != null) {
    const ev = makeEvidence({
      source: `baostock 序列 data/fundamentals/pe-${q.code}.json`,
      symbol: q.code,
      field: "pbMRQ",
      period: `${valuation.window?.from ?? "?"}~${valuation.window?.to ?? "?"}`,
      unit: "倍",
      adjustment: "none",
      asOf: latest.date,
      value: latest.pbMRQ,
    });
    const calc = makeCalculation({
      fn: "percentileRank",
      inputs: { points: valuation.points, value: latest.pbMRQ },
      inputsRefs: [ev.id],
      output: { value: Math.round(valuation.pbRank * 100) / 100, unit: "分位", status: "ok" },
    });
    derived.push({
      label: "PB 历史位置",
      value: rankPhrase(valuation.pbRank),
      tier: CONFIRMED,
      evidenceId: ev.id,
      calcId: calc.id,
      chain: formatChain(calc),
    });
  }

  if (valuation?.peRank != null || valuation?.pbRank != null) {
    // 判读由代码给（valuation-sop.ts），不交给 AI——「PE 低 PB 高」这种周期底部
    // 特征最容易被读反，规则能钉死的就别靠模型。
    const judged = valuationJudgement(valuation.peRank, valuation.pbRank);
    findings.push({
      text: "分位说的是它相对自己过去贵贱的位置：「贵」不等于会跌，「便宜」不等于会涨，这只是位置描述。",
      tier: CONFIRMED,
    });
    if (judged) findings.push({ text: `${judged.verdict}。${judged.caution}`.trim(), tier: INFERRED });
  } else {
    gaps.push(
      "缺历史 PE 分位：这只票还没跑过 baostock 抓取脚本（scripts/fetch-pe-history.py），" +
        "只有当日 PE 的绝对值，看不出它在自己历史上排第几",
    );
  }
  // 一致预期（D1）：有机构预测就能算前瞻 PE 和 PEG，把估值从「只答历史分位」
  // 升级到「答贵不贵」。数字照例先摆 evidence 再下结论。
  if (input.consensus && input.consensus.nInstitutions > 0) {
    const c = input.consensus;
    const SRC = "东财研报接口（consensus-store.ts）";
    if (q.price != null && c.epsThisYear != null && c.epsThisYear > 0) {
      const fwdPe = q.price / c.epsThisYear;
      evidence.push({ label: "前瞻 PE（现价 ÷ 一致预期 EPS）", value: `${fwdPe.toFixed(1)} 倍`, source: SRC, tier: CONFIRMED });
      if (c.forwardCagr != null && c.forwardCagr > 0) {
        const peg = fwdPe / (c.forwardCagr * 100);
        evidence.push({ label: "PEG（前瞻 PE ÷ 前瞻增速）", value: peg.toFixed(2), source: SRC, tier: CONFIRMED });
        findings.push({
          text:
            peg < 1
              ? "PEG 偏低，增长能消化估值；但这结论是预测给的——CAGR 一旦下修 PEG 就跳升。"
              : peg > 2
                ? "PEG 偏高，估值没被增长消化；除非有不可替代性被定价（产业链那层），否则要问为什么这么贵。"
                : "PEG 中性，估值与增速大致匹配。",
          tier: INFERRED,
        });
      }
    }
    evidence.push({ label: "一致预期 EPS", value: `今年 ${c.epsThisYear?.toFixed(2) ?? "—"} / 明年 ${c.epsNextYear?.toFixed(2) ?? "—"} 元`, source: SRC, tier: CONFIRMED });
    evidence.push({ label: "预测机构数", value: String(c.nInstitutions), source: SRC, tier: CONFIRMED });
    if (c.dispersion != null) evidence.push({ label: "预测分歧（max/min）", value: `${c.dispersion.toFixed(2)} 倍`, source: SRC, tier: CONFIRMED });
    for (const gap of c.gaps) if (!gaps.includes(gap)) gaps.push(gap);
  } else {
    gaps.push("没有机构预测（一致预期），前瞻 PE 和 PEG 算不出——估值只能答历史分位，答不了「贵不贵」");
  }

  return { id: "valuation", title: "估值锚", question: "贵不贵，相对于历史和自己？", evidence, findings, gaps, derived };
}

/**
 * 第六阶段：裁决点。
 *
 * 只写「什么事实出现会让当前判断站不住」，不写「该怎么做」。
 * 这两句话长得很像，区别只有一行字，所以这一阶段的产出同样要过红线。
 */
function verdictStage(input: ResearchInput, prior: readonly StageResult[] = []): StageResult {
  const { quote } = input;
  const gaps: string[] = [];
  const evidence: Evidence[] = [];
  if (!quote) {
    gaps.push("没有行情，裁决点无从给出");
    return { id: "verdict", title: "裁决点", question: "什么事实出现会让现在这套说法站不住？", evidence, findings: [], gaps, derived: [] };
  }
  // 裁决点由代码从前面各阶段的证据推导（catalyst-sop.ts），不手写——
  // 手写列表会漏（没考虑某个阶段有没有证据），而且无法单测。
  const points = decisionPointsFrom(prior);
  const findings: Finding[] = points.map((p) => ({
    text: `观察「${p.object}」：${p.threshold}（来源 ${p.source}，${p.nextAt}）。触发后：${p.effect}`,
    tier: UNVERIFIED,
  }));

  // 旧预警核对（A5 知识档案）：上次说的「盯什么」，这次回答「应验了没」。
  // 旧结论只当待验证项——冲突时以本次实时数据为准，这条纪律写进 knowledge.ts 头注释。
  if (input.knowledge) {
    const checks = checkOldPoints(input.knowledge, input.quote ?? null, input.valuation ?? null);
    for (const c of checks) {
      const tag = c.status === "triggered" ? "上次的预警已应验" : c.status === "watching" ? "上次的预警还没触发" : "旧预警待人工核对";
      findings.push({ text: `${tag}：「${c.point.object}」——${c.detail}`, tier: INFERRED });
    }
  }
  return {
    id: "verdict",
    title: "裁决点",
    question: "什么事实出现会让现在这套说法站不住？",
    evidence,
    findings,
    gaps,
    derived: [],
  };
}

const STAGES: Record<StageId, (input: ResearchInput, prior?: readonly StageResult[]) => StageResult> = {
  identity: identityStage,
  price: priceStage,
  capital: capitalStage,
  catalyst: catalystStage,
  valuation: valuationStage,
  verdict: verdictStage,
};

export const STAGE_TITLE: Record<StageId, string> = {
  identity: "标的身份",
  price: "价格位置",
  capital: "资金与成交",
  catalyst: "催化剂与风险",
  valuation: "估值锚",
  verdict: "裁决点",
};

/**
 * 跑一遍六阶段。
 *
 * 每条 finding 产出后过红线：命中就换成占位句，并在 blocked 里计数。
 * 占位句写「为什么这句没出来」，不写「已删除」——后者是又一个黑箱。
 */
export function runResearch(input: ResearchInput): ResearchReport {
  const gaps: string[] = [];
  if (!input.quote && input.articles.length === 0) gaps.push("既没有行情也没有资讯，这只票目前什么都查不到");

  let blocked = 0;
  let numbersReplaced = 0;
  // verdict 要读前面阶段的证据来推导裁决点，所以它必须最后算
  const priorStages = STAGE_IDS.filter((id) => id !== "verdict").map((id) => STAGES[id](input));
  const verdict = STAGES.verdict(input, priorStages);

  const stages = [...priorStages.map((stage) => {
    const base = stage;
    // 数字闸门的材料 = 这一阶段自己摆出来的证据和缺口。
    // 结论里出现材料里没有的数字 → 换成（略※）。模板句现在都干净（测试钉着），
    // 这道闸是给将来接进来的 AI 产出用的——护栏先装好再通车。
    // 材料要连 derived 的值一起给：估值判读文本里的分位数来自 derived，
    // 漏了它会被数字闸门当成没出处的数换掉（2026-10-12 实测踩过）。
    const sources = [...base.evidence.map((e) => e.value), ...base.derived.map((d) => d.value), ...base.gaps];
    const findings = base.findings.map((finding) => {
      const res = screenAdvice(finding.text);
      if (!res.ok) {
        blocked += 1;
        return {
          text: `（这句被红线拦下：${res.hits[0] ?? "疑似给出投资动作"}。赤轨不给买卖建议，只给数据、框架、情景概率和裁决点）`,
          tier: finding.tier,
        };
      }
      const screened = screenNumbers(finding.text, sources);
      if (screened.replaced.length > 0) numbersReplaced += screened.replaced.length;
      return { ...finding, text: screened.text };
    });
    return { ...base, findings };
  }), verdict];

  // 引用链自检：把每个 derived 的证据和计算都摊平成一张 DAG，查悬空引用。
  // 这一步是给报告自己做的——读者看到的每个分位数都能走回原始序列。
  const chainItems = stages.flatMap((stage) =>
    stage.derived.flatMap((d) => [
      { id: d.evidenceId, inputsRefs: [] as string[] },
      { id: d.calcId, inputsRefs: [d.evidenceId] },
    ]),
  );
  const chainCheck = verifyChain(chainItems);

  return {
    symbol: input.quote?.code ?? "",
    name: input.quote?.name ?? "",
    stages,
    gaps,
    blocked,
    numbersReplaced,
    chain: {
      evidence: chainItems.filter((item) => item.inputsRefs.length === 0).length,
      calculations: chainItems.filter((item) => item.inputsRefs.length > 0).length,
      dangling: chainCheck.dangling,
    },
  };
}


/**
 * 从一次研判生成知识档案（A5）。
 *
 * 存什么：强结论 + 裁决点（待验证的预言）+ 关键快照（d20 和分位档位，
 * 核对旧预警要用）。reportId 用于回溯到 data/reports/ 的原文。
 */
export function knowledgeFromReport(
  report: ResearchReport,
  reportId: string,
  quote: Quote | null,
  valuation: ValuationPosition | null,
): KnowledgeFile {
  const conclusions: string[] = [];
  for (const stage of report.stages) {
    for (const f of stage.findings) {
      if (f.tier === INFERRED || f.tier === CONFIRMED) conclusions.push(f.text);
    }
  }
  return {
    // 键必须带市场前缀（sh600519），和其他 store 的 byCode 键一致——见 KnowledgeFile.symbol 注释
    symbol: quote?.id ?? report.symbol,
    name: report.name,
    savedAt: new Date().toISOString(),
    reportId,
    conclusions,
    points: decisionPointsFrom(report.stages.filter((s) => s.id !== "verdict")),
    snapshot: { d20: quote?.d20 ?? null, peRank: valuation?.peRank ?? null, pbRank: valuation?.pbRank ?? null },
  };
}
