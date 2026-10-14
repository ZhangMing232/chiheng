/**
 * 这个文件是干什么的：
 * 涨停/炸板/跌停三个池的解析与统计（D9 信号层，对标 Vibe-Research 的打板层）。
 *
 * 接口来自 a-stock-data SKILL V3.10.2 §8.1（东财 push2ex 四池），
 * 赤轨侧只接**东财那三个池**（涨停/炸板/跌停），不接同花顺涨停揭秘——
 * 它的"涨停原因题材"是市场叙事不是核验过的因果，接了要在页面上标清性质，
 * 而这一步先不做，等信号页立起来再说。
 *
 * 实测（2026-10-14，当天）：涨停 36 只 / 炸板 24 只 / 跌停 11 只。
 *
 * 你需要知道的（口径，都是从它的坑 + 赤轨纪律来的）：
 * 1. **价格字段是 ×1000 的整数**（`p: 6300` = 6.30 元），解析时 ÷1000。
 *    它文档里写"已 ÷1000"指的是它的封装做了，原始值没有。
 * 2. **炸板池的涨跌幅是负的**（-8.93%）——涨停后开板回落。这不是 bug，
 *    页面要显示"曾是涨停、现在回落多少"，不能只显示涨幅。
 * 3. **连板数 `lbc` 在炸板/跌停池里是 null**——那两个池不排连板。
 *    页面显示"—"，不显示 0（0 会被读成"首板"）。
 * 4. 炸板率 = 炸板数 ÷（涨停数 + 炸板数）。炸板的票也曾涨停，
 *    所以分母是"曾经涨停过的全部"，不是涨停池单独一个。
 * 5. `zttj` 是 {days, ct}（N 天 M 板），**可能整个缺失**（跌停池实测是 {}），
 *    解析要容忍，别拿 `?.days ?? 0` 冒充"0 天"。
 */

export type PoolKind = "limitUp" | "broken" | "limitDown";

export type LimitUpRow = {
  id: string;
  code: string;
  name: string;
  price: number;
  /** 涨跌幅，百分数（炸板池通常是负的） */
  pct: number;
  /** 连板数（几连板）。炸板/跌停池没有 → null */
  streak: number | null;
  /** 炸板次数（涨停后开板几次） */
  breaks: number | null;
  /** 封板资金，元。没有 → null */
  sealFund: number | null;
  industry: string | null;
  /** "N天M板" 的原文，没有 → null */
  stat: string | null;
  kind: PoolKind;
};

/** 一只票在三个池里的呈现顺序：涨停 → 炸板 → 跌停。 */
export const POOL_LABEL: Record<PoolKind, string> = {
  limitUp: "涨停",
  broken: "炸板",
  limitDown: "跌停",
};

/** 内部 id：A 股六位代码加市场前缀。北交所 43/83/87/920 → bj，其余按 6/9 判沪、其余深。 */
export function rowIdOf(code: string): string {
  if (/^(43|83|87|920)/.test(code)) return `bj${code}`;
  if (/^(6|9)/.test(code)) return `sh${code}`;
  return `sz${code}`;
}

function numOr(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function strOr(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v.trim() : null;
}

/**
 * 解析一个池。坏行跳过并计数——**不因为一行脏数据毁掉整页**。
 * 价格为 0 或缺失的照样跳过（没有价格的涨停票没有意义）。
 */
export function parsePool(payload: unknown, kind: PoolKind): { rows: LimitUpRow[]; bad: number } {
  const pool = (payload as { data?: { pool?: unknown } } | null)?.data?.pool;
  if (!Array.isArray(pool)) return { rows: [], bad: 0 };
  const rows: LimitUpRow[] = [];
  let bad = 0;
  for (const raw of pool) {
    const p = (raw ?? {}) as Record<string, unknown>;
    const code = strOr(p.c);
    const name = strOr(p.n);
    const price = numOr(p.p);
    if (!code || !/^\d{6}$/.test(code) || !name || price == null || price <= 0) {
      bad += 1;
      continue;
    }
    const zttj = (p.zttj ?? {}) as Record<string, unknown>;
    const stat =
      numOr(zttj.days) != null && numOr(zttj.ct) != null
        ? `${numOr(zttj.days)}天${numOr(zttj.ct)}板`
        : null;
    rows.push({
      id: rowIdOf(code),
      code,
      name,
      price: price / 1000, // 原始值 ×1000（见文件头坑 1）
      pct: numOr(p.zdp) ?? 0,
      streak: numOr(p.lbc),
      breaks: numOr(p.zbc),
      sealFund: numOr(p.fund),
      industry: strOr(p.hybk),
      stat,
      kind,
    });
  }
  return { rows, bad };
}

/** 连板梯队：几连板有几只。`null` 连板数的（炸板/跌停池）不计入。 */
export function streakLadder(rows: readonly LimitUpRow[]): { streak: number; count: number }[] {
  const bucket = new Map<number, number>();
  for (const row of rows) {
    if (row.streak == null) continue;
    bucket.set(row.streak, (bucket.get(row.streak) ?? 0) + 1);
  }
  return [...bucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([streak, count]) => ({ streak, count }));
}

/**
 * 炸板率 = 炸板数 ÷（涨停数 + 炸板数）。
 * 炸板的票也曾涨停，所以分母是"曾经涨停过的全部"。
 * 两个池都是空时给 null——**不给 0**（0 会被读成"今天没炸板"）。
 */
export function breakRate(up: readonly LimitUpRow[], broken: readonly LimitUpRow[]): number | null {
  const total = up.length + broken.length;
  if (total === 0) return null;
  return broken.length / total;
}

/** 一页的汇总。三个池都空时给 null，页面显示"今天没数据"而不是全 0。 */
export type SignalSummary = {
  limitUp: number;
  broken: number;
  limitDown: number;
  breakRate: number | null;
  ladder: { streak: number; count: number }[];
  /** 封板资金最大的前几名（按 sealFund 降序，没有的排不进来） */
  topSealFund: LimitUpRow[];
  /** 行业分布前几名 */
  topIndustries: { industry: string; count: number }[];
};

export function summarize(
  up: readonly LimitUpRow[],
  broken: readonly LimitUpRow[],
  down: readonly LimitUpRow[],
): SignalSummary | null {
  if (up.length + broken.length + down.length === 0) return null;
  const industries = new Map<string, number>();
  for (const row of [...up, ...broken]) {
    if (!row.industry) continue;
    industries.set(row.industry, (industries.get(row.industry) ?? 0) + 1);
  }
  return {
    limitUp: up.length,
    broken: broken.length,
    limitDown: down.length,
    breakRate: breakRate(up, broken),
    ladder: streakLadder(up),
    topSealFund: [...up].filter((r) => r.sealFund != null).sort((a, b) => (b.sealFund ?? 0) - (a.sealFund ?? 0)).slice(0, 8),
    topIndustries: [...industries.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([industry, count]) => ({ industry, count })),
  };
}
