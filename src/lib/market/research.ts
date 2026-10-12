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
import { rankPhrase, type ValuationPosition } from "./pe-history.ts";

/** 四档可信度（学 Vibe-Research `orchestrator/src/finance/inference_tiers.ts`，同一组词）。 */
export const RESEARCH_TIERS = ["已披露证实", "有依据的推断", "未核实线索", "被反证"] as const;
export type ResearchTier = (typeof RESEARCH_TIERS)[number];
/** 唯一允许没有依据的一档。其余三档都从真实数据算出，所以 tile 由代码给不出 KAfka。 */
export const UNVERIFIED: ResearchTier = "未核实线索";
export const CONFIRMED: ResearchTier = "已披露证实";

export type Evidence = {
  label: string;
  value: string;
  /** 这条数从哪来。写接口/文件名，不写「内部数据」这种找不到人的话。 */
  source: string;
  tier: ResearchTier;
};

export type Finding = { text: string; tier: ResearchTier };

export type StageId = (typeof STAGE_IDS)[number];

export type StageResult = {
  id: StageId;
  title: string;
  /** 这一阶段回答的问题。写在页面上，读者先看问题再看答案。 */
  question: string;
  evidence: Evidence[];
  findings: Finding[];
  gaps: string[];
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
};

export type ResearchReport = {
  symbol: string;
  name: string;
  stages: StageResult[];
  /** 全报告级别的缺口（标的没找到之类）。 */
  gaps: string[];
  /** 被红线拦下的条数。>0 说明写 prompt / 模板的人越线了。 */
  blocked: number;
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
  };
}

function priceStage(input: ResearchInput): StageResult {
  const { quote } = input;
  const gaps: string[] = [];
  const evidence: Evidence[] = [];
  if (!quote) {
    gaps.push("没有行情，价格位置无从判断");
    return { id: "price", title: "价格位置", question: "现在站在什么位置上？", evidence, findings: [], gaps };
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
  return { id: "price", title: "价格位置", question: "现在站在什么位置上，贵了还是便宜了多久？", evidence, findings, gaps };
}

function capitalStage(input: ResearchInput): StageResult {
  const { quote } = input;
  const gaps: string[] = [];
  const evidence: Evidence[] = [];
  if (!quote) {
    gaps.push("没有行情，当日资金无从判断");
    return { id: "capital", title: "资金与成交", question: "今天谁在买？", evidence, findings: [], gaps };
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
  };
}

function catalystStage(input: ResearchInput): StageResult {
  const { articles } = input;
  const gaps: string[] = [];
  const evidence: Evidence[] = [];
  if (articles.length === 0) {
    gaps.push("没有拉到这只票的资讯或公告，催化剂与风险这一段是空的");
    return { id: "catalyst", title: "催化剂与风险", question: "最近发生了什么，哪些是已经证实的？", evidence, findings: [], gaps };
  }
  const good = articles.filter((a) => a.tone === "good").length;
  const bad = articles.filter((a) => a.tone === "bad").length;
  const anns = articles.filter((a) => a.kind === "ann").length;
  evidence.push({ label: "公告条数", value: String(anns), source: SOURCE_NEWS, tier: CONFIRMED });
  evidence.push({ label: "偏利好", value: String(good), source: SOURCE_NEWS, tier: CONFIRMED });
  evidence.push({ label: "偏利空", value: String(bad), source: SOURCE_NEWS, tier: CONFIRMED });
  for (const item of articles.slice(0, 5)) {
    evidence.push({ label: item.time.slice(0, 10), value: item.title, source: SOURCE_NEWS, tier: CONFIRMED });
  }
  const findings: Finding[] = [
    {
      text: "利好利空按标题用词自动分档，机器读不出反讽和否认；这一档只是线索，不代表已核实。",
      tier: UNVERIFIED,
    },
  ];
  return {
    id: "catalyst",
    title: "催化剂与风险",
    question: "最近发生了什么，哪些只是线索？",
    evidence,
    findings,
    gaps,
  };
}

function valuationStage(input: ResearchInput): StageResult {
  const { quote, valuation } = input;
  const gaps: string[] = [];
  const evidence: Evidence[] = [];
  if (!quote) {
    gaps.push("没有行情，估值锚算不出来");
    return { id: "valuation", title: "估值锚", question: "贵不贵，相对于什么？", evidence, findings: [], gaps };
  }
  const q = quote;
  if (q.pe == null) gaps.push("没有市盈率（亏损或未给出）");
  else evidence.push({ label: "市盈率 TTM", value: `${q.pe.toFixed(2)} 倍`, source: SOURCE_QUOTE, tier: CONFIRMED });
  if (q.pb == null) gaps.push("没有市净率");
  else evidence.push({ label: "市净率", value: `${q.pb.toFixed(2)} 倍`, source: SOURCE_QUOTE, tier: CONFIRMED });

  // 历史分位来自 baostock 序列（学 Vibe-Research：分位在 calc 层算，不在取数层做）。
  // 有序列就给位置；没有就明说没有，**不许拿当日 PE 绝对值反推一个假分位**。
  const findings: Finding[] = [];
  if (valuation?.peRank != null) {
    evidence.push({
      label: "PE_TTM 历史位置",
      value: rankPhrase(valuation.peRank),
      source: `baostock 序列 ${valuation.fetchedAt}（${valuation.points} 个交易日）`,
      tier: CONFIRMED,
    });
  }
  if (valuation?.pbRank != null) {
    evidence.push({
      label: "PB 历史位置",
      value: rankPhrase(valuation.pbRank),
      source: `baostock 序列 ${valuation.fetchedAt}（${valuation.points} 个交易日）`,
      tier: CONFIRMED,
    });
  }
  if (valuation?.peRank != null || valuation?.pbRank != null) {
    findings.push({
      text: "分位说的是它相对自己过去贵贱的位置：「贵」不等于会跌，「便宜」不等于会涨，这只是位置描述。",
      tier: CONFIRMED,
    });
  } else {
    gaps.push(
      "缺历史 PE 分位：这只票还没跑过 baostock 抓取脚本（scripts/fetch-pe-history.py），" +
        "只有当日 PE 的绝对值，看不出它在自己历史上排第几",
    );
  }
  return { id: "valuation", title: "估值锚", question: "贵不贵，相对于历史和自己？", evidence, findings, gaps };
}

/**
 * 第六阶段：裁决点。
 *
 * 只写「什么事实出现会让当前判断站不住」，不写「该怎么做」。
 * 这两句话长得很像，区别只有一行字，所以这一阶段的产出同样要过红线。
 */
function verdictStage(input: ResearchInput): StageResult {
  const { quote } = input;
  const gaps: string[] = [];
  const evidence: Evidence[] = [];
  if (!quote) {
    gaps.push("没有行情，裁决点无从给出");
    return { id: "verdict", title: "裁决点", question: "什么事实出现会让现在这套说法站不住？", evidence, findings: [], gaps };
  }
  const watch: string[] = [];
  if (quote.d20 != null) watch.push("近 20 日涨幅的方向掉头");
  watch.push("主力净流入连续 3 日同向");
  watch.push("出现带否决性措辞的公告（退市、立案、业绩预告下修）");
  const findings: Finding[] = [
    {
      text: `推翻当前描述的观察点：${watch.join("；")}。这些是「看到就该重看一遍」的条件，不是行动指令。`,
      tier: UNVERIFIED,
    },
  ];
  return {
    id: "verdict",
    title: "裁决点",
    question: "什么事实出现会让现在这套说法站不住？",
    evidence,
    findings,
    gaps,
  };
}

const STAGES: Record<StageId, (input: ResearchInput) => StageResult> = {
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
  const stages = STAGE_IDS.map((id) => {
    const stage = STAGES[id](input);
    const findings = stage.findings.map((finding) => {
      const res = screenAdvice(finding.text);
      if (res.ok) return finding;
      blocked += 1;
      return {
        text: `（这句被红线拦下：${res.hits[0] ?? "疑似给出投资动作"}。赤轨不给买卖建议，只给数据、框架、情景概率和裁决点）`,
        tier: finding.tier,
      };
    });
    return { ...stage, findings };
  });

  return {
    symbol: input.quote?.code ?? "",
    name: input.quote?.name ?? "",
    stages,
    gaps,
    blocked,
  };
}
