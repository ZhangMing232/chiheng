/**
 * 这个文件是干什么的：
 * 产业链 SOP（对标 Vibe-Research `company-research` 的 industry 阶段 + `industry.ts`
 * 的产业标签挂载）。回答一个问题：**这只票所在的行业，最近几个月价格和资金在往哪走。**
 *
 * 它给得出什么（都是真数据）：
 * - 个股 → 东财三级行业（D6，496 个板块反查）
 * - 该行业板块的月度序列：月度涨跌、月度主力净流入、月均换手（D5，日线+资金流聚合）
 * - 一个方向读数：升温 / 降温 / 背离 / 不明
 *
 * 它给不出什么（**别拿别的词糊过去**）：
 * - **上下游关系**。Vibe 的产业标签表是「算力链 → GPU 租金 / 台系月营收 / Kalshi 合约」
 *   这种上下游硬数据，那是人工维护的产业认知 + 海外数据源。赤轨两样都没有：
 *   免费源里拿不到分行业的价格/库存/capex，产业链上下游的映射表也没有知识库可用。
 *   **编一张上下游表就是编数据，所以不做**——这个阶段只说行业自身，不说链条位置。
 * - 行业景气度。手里是量价与资金维度的数，撑不起「景气」这个词，只说温度。
 *
 * 纪律（和事件研究同源）：
 * - 只描述过去，不预测，不给买卖暗示。finding 里不出现「该买/该卖/看好」。
 * - 数字先进 evidence 再进 finding（数字闸门会查），所以方向读数不重复数字，
 *   只说方向和「依据见上方月度表」。
 * - 缺分类 / 缺月度数据 → 写缺口，不许拿空数组冒充「没有」。
 */

// 只 import 类型，不 import 运行时值：research.ts 会 import 本模块的 industryStage，
// 从它取值会形成循环依赖（模块还没求值完就读常量）
import type { Evidence, Finding, StageResult } from "./research.ts";
import { CONFIRMED, INFERRED } from "./research-tiers.ts";
import { finestIndustry, type IndustryIndex } from "./industry.ts";
import { recentMonths, thermometer, type IndustryMonth } from "./industry-monthly.ts";

export const SOURCE_INDUSTRY = "东财三级行业（m:90+t:2，scripts/fetch-industry.mjs）";
export const SOURCE_MONTHLY = "东财板块日线+资金流（scripts/fetch-industry-monthly.mjs）";

/** 读几个月。3 个月是能看出方向又不至于把季节性和长假混进来的折中。 */
export const THERMO_MONTHS = 3;

export type BoardMonthly = { code: string; name: string; months: IndustryMonth[] };

export type IndustryStageInput = {
  id: string;
  name: string;
  /** D6 分类索引。null = 没抓过，写缺口。 */
  index: IndustryIndex | null;
  /** D5 该板块的月度序列。null = 没抓过，写缺口。 */
  monthly: BoardMonthly | null;
};

export function industryStage(input: IndustryStageInput): StageResult {
  const gaps: string[] = [];
  const evidence: Evidence[] = [];
  const findings: Finding[] = [];

  const board = input.index ? finestIndustry(input.index, input.id)[0] ?? null : null;
  if (!input.index) gaps.push("行业分类没抓过（跑 scripts/fetch-industry.mjs），这只票的行业归属无法确认");
  else if (!board) gaps.push(`${input.name} 不在行业分类表里（可能是新股或未纳入东财行业板块）`);

  if (board) {
    evidence.push({ label: "所属行业", value: board.name, source: SOURCE_INDUSTRY, tier: CONFIRMED });
    evidence.push({ label: "分类数据日期", value: input.index!.updatedAt, source: SOURCE_INDUSTRY, tier: CONFIRMED });
    // 多归属且剪不掉的情况如实说：这只票同时挂在两条链上，行业读数本身就含糊
    const all = input.index!.bySymbol[input.id] ?? [];
    if (all.length > 1) {
      evidence.push({
        label: "其他归属",
        value: all
          .filter((b) => b.code !== board.code)
          .map((b) => b.name)
          .join(" / "),
        source: SOURCE_INDUSTRY,
        tier: CONFIRMED,
      });
      gaps.push("这只票同时挂在多个行业板块下且无法判断粗细，行业读数按最细那层给，但归属本身是含糊的");
    }
    findings.push({
      text: `${input.name} 归在「${board.name}」（东财三级行业分类，不是申万——申万官网分类接口已下线）。`,
      tier: CONFIRMED,
    });
  }

  if (!input.monthly) {
    gaps.push(board ? `「${board.name}」的月度数据没抓过（跑 scripts/fetch-industry-monthly.mjs）` : "行业月度数据没抓过");
  } else {
    const months = recentMonths(input.monthly.months, THERMO_MONTHS);
    if (months.length === 0) {
      gaps.push(`「${input.monthly.name}」没有足够的完整月份（月份数据不足或都还在进行中），给不出方向读数`);
    } else {
      for (const m of months) {
        evidence.push({
          label: `${m.month} 月度涨跌`,
          value: m.chgPct == null ? "缺上月基准" : `${m.chgPct.toFixed(2)}%`,
          source: SOURCE_MONTHLY,
          tier: CONFIRMED,
        });
        evidence.push({
          label: `${m.month} 主力净流入`,
          value: m.mainNet == null ? "资金流缺失" : `${(m.mainNet / 1e8).toFixed(2)} 亿`,
          source: SOURCE_MONTHLY,
          tier: CONFIRMED,
        });
      }
      const t = thermometer(input.monthly.months, THERMO_MONTHS);
      if (t.direction !== "不明") {
        const ups = months.filter((m) => (m.chgPct ?? 0) > 0).length;
        const downs = months.filter((m) => (m.chgPct ?? 0) < 0).length;
        const nets = months.map((m) => m.mainNet).filter((v): v is number => v != null);
        const money =
          nets.length === 0
            ? "资金流缺失，方向只读价格"
            : `主力净流入 ${nets.filter((v) => v > 0).length} 个月、净流出 ${nets.filter((v) => v < 0).length} 个月`;
        evidence.push({
          label: `近 ${months.length} 个完整月`,
          value: `上涨 ${ups} 个月、下跌 ${downs} 个月；${money}`,
          source: SOURCE_MONTHLY,
          tier: CONFIRMED,
        });
        findings.push({
          text: `行业温度计读数为「${t.direction}」：近 ${months.length} 个完整月里价格与主力资金${
            t.direction === "背离" ? "方向相反" : "同向"
          }，依据见上方月度表。这是量价与资金维度的读数，不等于行业景气度，也只描述过去。`,
          tier: INFERRED,
        });
      } else {
        gaps.push("近几个月方向读不出来（价格或资金缺失，或涨跌月份打平），不硬给方向");
      }
    }
  }

  return {
    id: "industry",
    title: "行业与产业链",
    question: "这只票所在行业，最近几个月价格和资金在往哪走？",
    evidence,
    findings,
    gaps,
    derived: [],
  };
}
