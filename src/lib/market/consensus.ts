/**
 * 这个文件是干什么的：
 * 一致预期的聚合（D1）。从东财研报接口返回的一堆个股研报里，算出
 * **机构数、一致预期 EPS、前瞻 CAGR、分歧**——这是估值 SOP 的主干（前瞻 PE、PEG）。
 *
 * 学 Vibe-Research 的 valuation SKILL.md §3「一致预期的可信度」：
 *   - 机构数 ≥ 3 → 正常用，列「机构数 · 区间」
 *   - 机构数 < 3 → 标「一致预期不可靠」，可算但判读降级
 *   - 分歧 max/min ≥ 2 → 明示「分歧 ≥ 2 倍，PEG/区间按 min–max 各算一遍」
 *
 * 你需要知道的（纪律）：
 * 1. **同一机构取最新一份**：一个券商对同一只票一年可能发多份研报（上调/下调），
 *    全算进去等于把过期的预测和新的混在一起。按 publishDate 取每机构最新。
 * 2. **前瞻 CAGR 是唯一的预测，最软**：它分母是分析师对明年的猜测，周期一转
 *    E 被下修，CAGR 跳升。任何 PEG 判读必须同时给「前瞻 vs TTM 是否对得上」。
 * 3. 数字一律经聚合函数产出，不手写。
 */

export type ConsensusReport = {
  orgName: string;
  publishDate: string;
  /** 评级，如「买入」「增持」「中性」 */
  rating: string;
  thisYearEps: number | null;
  nextYearEps: number | null;
  nextTwoYearEps: number | null;
  thisYearPe: number | null;
  nextYearPe: number | null;
  nextTwoYearPe: number | null;
};

export type ConsensusRead = {
  /** 每个机构最新一份的研报（去重后） */
  latest: ConsensusReport[];
  /** 机构数（去重 orgName） */
  nInstitutions: number;
  /** 一致预期 EPS：各机构最新预测的均值 */
  epsThisYear: number | null;
  epsNextYear: number | null;
  epsNextTwoYear: number | null;
  /** 前瞻 CAGR = 明年 EPS ÷ 今年 EPS − 1 */
  forwardCagr: number | null;
  /** 分歧 = 各机构今年 EPS 的 max ÷ min。null = 样本不足 2 */
  dispersion: number | null;
  /** 一致预期是否可信（机构数 ≥ 3） */
  reliable: boolean;
  gaps: string[];
};

const MIN_INSTITUTIONS = 3;

function num(v: number | null): number | null {
  return v != null && Number.isFinite(v) ? v : null;
}

/** 每个机构取最新一份（按 publishDate）。同机构同名才算同一家。 */
export function latestPerInstitution(reports: readonly ConsensusReport[]): ConsensusReport[] {
  const byOrg = new Map<string, ConsensusReport>();
  for (const r of reports) {
    if (!r.orgName) continue;
    const cur = byOrg.get(r.orgName);
    if (!cur || r.publishDate > cur.publishDate) byOrg.set(r.orgName, r);
  }
  return [...byOrg.values()].sort((a, b) => a.publishDate.localeCompare(b.publishDate));
}

function mean(values: readonly (number | null)[]): number | null {
  const usable = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (usable.length === 0) return null;
  return usable.reduce((s, v) => s + v, 0) / usable.length;
}

/**
 * 聚合一致预期。输入是东财研报列表（可能上百条），输出可判读的一致预期。
 */
export function aggregateConsensus(reports: readonly ConsensusReport[]): ConsensusRead {
  const latest = latestPerInstitution(reports);
  const n = latest.length;
  const gaps: string[] = [];

  const epsThisYear = mean(latest.map((r) => r.thisYearEps));
  const epsNextYear = mean(latest.map((r) => r.nextYearEps));
  const epsNextTwoYear = mean(latest.map((r) => r.nextTwoYearEps));

  const forwardCagr = epsThisYear != null && epsNextYear != null && epsThisYear > 0 ? epsNextYear / epsThisYear - 1 : null;

  const thisYearValues = latest.map((r) => num(r.thisYearEps)).filter((v): v is number => v != null && v > 0);
  let dispersion: number | null = null;
  if (thisYearValues.length >= 2) {
    const max = Math.max(...thisYearValues);
    const min = Math.min(...thisYearValues);
    dispersion = min > 0 ? max / min : null;
  }

  const reliable = n >= MIN_INSTITUTIONS;
  if (n === 0) gaps.push("没有这只票的机构预测（东财研报接口没有返回预测）");
  else if (!reliable) gaps.push(`只有 ${n} 家机构给了预测（< ${MIN_INSTITUTIONS}），一致预期不可靠，判读降级`);
  if (dispersion != null && dispersion >= 2) gaps.push(`机构预测分歧 ${dispersion.toFixed(1)} 倍（≥ 2 倍），PEG 应按 min–max 各算一遍，别看均值`);
  if (forwardCagr == null && epsThisYear != null) gaps.push("今年或明年 EPS 缺失，前瞻 CAGR 算不出");

  return { latest, nInstitutions: n, epsThisYear, epsNextYear, epsNextTwoYear, forwardCagr, dispersion, reliable, gaps };
}
