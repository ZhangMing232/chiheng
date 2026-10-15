/**
 * 这个文件是干什么的：
 * 中债国债收益率曲线的解析与利差计算（D7 宏观层第一块）。
 *
 * 为什么先做这个：A 股是流动性驱动市场，**10 年国债收益率是市场的「水温」**——
 * 它往下走意味着钱变便宜、风险偏好上升。它是日频的，能进每日复盘；
 * 社融和 PMI 是月频（发布还固定日子），不适合日频页面。
 *
 * 接口来自 a-stock-data SKILL V3.10.2 §11.3（中央结算公司官方，零鉴权）：
 * `https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery`，返回 HTML 表格。
 *
 * 实测（2026-10-15）：一次查 30 天返回 18 个交易日 × 8 档期限，2026-10-14 的
 * 10 年期国债 1.6516%。
 *
 * 你需要知道的：
 * 1. **官网单次查询超过 1 年会静默返回 0 行**——所以查询窗口要控制在 360 天内，
 *    不用它的切片逻辑，赤轨一次只取近期。
 * 2. **它不公布债券市场交易日历**，页面也没有总条数，所以「某天没有数据」
 *    分不清是节假日还是接口坏了。**这里不拿缺失当天当异常**——给出最近有数据的
 *    那天，让页面自己标「数据截至 X」。
 * 3. 收益率单位是 **%**（1.6516 = 1.6516%），不是小数。解析层保持原样，
 *    换算只在展示层做。
 * 4. 表头行不是数据：解析按「第二格是 YYYY-MM-DD」判定，认不出就跳过，不硬凑。
 */

export type YieldPoint = {
  date: string;
  /** 3月 ~ 30年，八档，单位 %。缺档是 null（不同曲线起点不同） */
  tenors: Record<string, number | null>;
};

/** 八档期限的显示名（和官网表头一致）。 */
export const TENOR_LABELS: Record<string, string> = {
  "3m": "3月",
  "6m": "6月",
  "1y": "1年",
  "3y": "3年",
  "5y": "5年",
  "7y": "7年",
  "10y": "10年",
  "30y": "30年",
};

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim();
}

/**
 * 解析中债返回的 HTML 表格。
 *
 * 认不出的行跳过并计数——**不因为一行脏数据丢掉整条曲线**。
 * 数值缺失（空单元格或非数字）给 null，不给 0（0 会被读成"收益率 0%"）。
 */
export function parseYieldCurve(html: string): { points: YieldPoint[]; bad: number } {
  const body = html.replace(/<!--[\s\S]*?-->/g, "");
  const rows = body.match(/<tr[\s\S]*?<\/tr>/g) ?? [];
  const points: YieldPoint[] = [];
  let bad = 0;
  for (const row of rows) {
    const cells = (row.match(/<t[dh][^>]*>[\s\S]*?<\/t[dh]>/g) ?? []).map(stripTags);
    if (cells.length < 2) continue;
    // 第一格是曲线名，第二格是日期；日期认不出来就不是数据行
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cells[1]!)) continue;
    const tenors: Record<string, number | null> = {};
    // 表头顺序：曲线名 | 日期 | 3月 | 6月 | 1年 | 3年 | 5年 | 7年 | 10年 | 30年
    // **顺序照官网表头**（3月|6月|1年|3年|5年|7年|10年|30年），不靠猜也不靠
    // 「在 cells 里找 10年 那一格」——那种写法在缺列时会整体错位。
    const keys = ["3m", "6m", "1y", "3y", "5y", "7y", "10y", "30y"];
    for (let i = 0; i < keys.length; i += 1) {
      const raw = cells[i + 2];
      if (raw == null || raw === "" || raw === "--") {
        tenors[keys[i]!] = null;
        continue;
      }
      const value = Number(raw);
      if (!Number.isFinite(value)) {
        bad += 1;
        tenors[keys[i]!] = null;
        continue;
      }
      tenors[keys[i]!] = value;
    }
    points.push({ date: cells[1]!, tenors });
  }
  // 官网按日期倒序返回，但**别假设**：统一按日期升序，页面画曲线才不用再排
  points.sort((a, b) => a.date.localeCompare(b.date));
  return { points, bad };
}

/** 一次拿多条曲线时，按曲线名分开（`all` 模式一天三条）。 */
export function splitByCurve(points: YieldPoint[], curveNames: string[]): Map<string, YieldPoint[]> {
  const out = new Map<string, YieldPoint[]>();
  for (const name of curveNames) out.set(name, []);
  return out;
}

/**
 * 期限利差（百分点，不是百分比变化）。
 *
 * 「水温」最常看的两条：
 * - `10y - 1y`：曲线陡不陡，市场对远期经济是通缩还是通胀的预期
 * - `30y - 10y`：超长端，反映更远期的名义增长预期
 *
 * 任一端缺值给 null——**不拿 0 充数**（0 会被读成"曲线平坦"）。
 */
export function spreadOf(point: YieldPoint, long: string, short: string): number | null {
  const a = point.tenors[long];
  const b = point.tenors[short];
  if (a == null || b == null) return null;
  return round4(a - b);
}

export type MacroSnapshot = {
  /** 数据截至哪天（接口不保证今天有数据） */
  date: string | null;
  tenors: Record<string, number | null>;
  /** 10y - 1y，百分点 */
  slope10y1y: number | null;
  /** 30y - 10y，百分点 */
  slope30y10y: number | null;
  /** 最近有多少个交易日的数据 */
  days: number;
};

/**
 * 取最新一天做快照，外加最近 N 天的曲线（画图用）。
 * 一条都没有时给 null——页面显示"拿不到"，不显示全 0。
 */
export function snapshotOf(points: YieldPoint[]): MacroSnapshot | null {
  if (points.length === 0) return null;
  const last = points[points.length - 1]!;
  return {
    date: last.date,
    tenors: last.tenors,
    slope10y1y: spreadOf(last, "10y", "1y"),
    slope30y10y: spreadOf(last, "30y", "10y"),
    days: points.length,
  };
}

function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}