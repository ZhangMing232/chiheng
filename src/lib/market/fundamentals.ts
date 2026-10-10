/**
 * 这个文件是干什么的：
 * 基本面数据的共享类型 + PIT 对齐纯函数。财报因子能不能进 6 关检验，
 * 命脉在一个问题上：**t 日那天，这条财报披露了吗？**
 *
 * 学 deepseek-harness-quant 的铁律（它把 PIT 写进 README 第一层）：财报按
 * 披露日（ann_date）入账，不按报告期（end_date）——按报告期对齐 = 前视，
 * 回测收益全虚高（4 月发的年报用在 1 月的选股上）。
 *
 * 你需要知道的：
 * 1. pitValue 是纯函数：给定一只票的披露序列和日期，返回那天市面上
 *    最新的一条。没披露过 → null，不是 0。
 * 2. 数据从哪来：scripts/fetch-fundamentals.ts 调 tushare 的 fina_indicator
 *    （按报告期全市场批量，8 个季度 ≈ 8 次调用），落 data/backtest/fundamentals.json。
 * 3. 字段口径：roe=净资产收益率(%)，dtYoy=扣非净利润同比(%)，debt=资产负债率(%)。
 *    tushare 没披露（上市前/字段缺失）是 null。
 */

/** 一条已披露的基本面记录。ann = 披露日 YYYYMMDD。 */
export type FundamentalRecord = {
  ann: string;
  roe: number | null;
  dtYoy: number | null;
  debt: number | null;
};

/** code（sh600519 格式）→ 披露序列，按 ann 升序。 */
export type FundamentalMap = Record<string, FundamentalRecord[]>;

/** fetch-fundamentals.ts 落盘的文件形状。 */
export type FundamentalFile = {
  fetchedAt: string;
  /** 覆盖了哪些报告期 YYYYMMDD。 */
  periods: string[];
  byCode: FundamentalMap;
};

/**
 * t 日市面上最新的一条已披露记录。
 * records **必须按 ann 升序**（fetch 脚本落盘时已排好，热路径 7 万次调用
 * 不再每次重排）——乱序传入是调用方 bug，结果未定义，silently 错。
 */
export function pitValue(records: FundamentalRecord[] | undefined, date: string): FundamentalRecord | null {
  if (!records || records.length === 0) return null;
  let best: FundamentalRecord | null = null;
  for (const r of records) {
    if (r.ann <= date) best = r;
    else break;
  }
  return best;
}

/** 从落盘文件里取某个 code 的序列；文件缺/格式坏都当「没有基本面数据」。 */
export function recordsOf(file: FundamentalFile | null, code: string): FundamentalRecord[] | undefined {
  return file?.byCode?.[code];
}

/**
 * 最近 N 个季度的报告期 YYYYMMDD 列表（从新到旧，含可能还没披露完的最新季）。
 * 纯函数放这里而不是 fetch 脚本里——脚本末尾有 main() 副作用，import 进测试
 * 会真的发起抓取（factors-view.ts 记过同一个坑）。
 */
export function recentQuarters(now = new Date(), n = 8): string[] {
  // 季度末日：Q1=0331 / Q2=0630 / Q3=0930 / Q4=1231——写错一天 tushare 就查空。
  const END = ["0331", "0630", "0930", "1231"];
  const out: string[] = [];
  let y = now.getFullYear();
  let q = Math.floor(now.getMonth() / 3); // 0..3，当前这个季度（可能还没完）
  for (let i = 0; i < n; i += 1) {
    out.push(`${y}${END[q]}`);
    q -= 1;
    if (q < 0) {
      q = 3;
      y -= 1;
    }
  }
  return out;
}
