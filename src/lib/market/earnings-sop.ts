/**
 * 这个文件是干什么的：
 * 财报口径的可执行部分。手册是 `docs/EARNINGS.md`。
 *
 * 学 Vibe-Research 的 `earnings-analysis` SKILL.md（82 行），但**按赤轨的数据现实
 * 大幅裁剪**：它的核心是「累计值 → 单季 → TTM → 同比」的拆解链，每一步都要有绝对值
 * 科目（营收 / 归母 / 扣非 / EPS）。赤轨的东财业绩报表**只有三个比率**
 * （roe / dtYoy / gm）+ debt（恒为 null）——没有绝对值，所以：
 *
 *   ❌ 做不了：quarterize（单季拆解）、TTM 求和、环比、单季同比、所有 ratio
 *   ✅ 做得了：**累计口径的比率序列 + 转向判断**
 *
 * 转向判断恰好是它「最新期看转向」那条判读的赤轨版，而且由代码定、可单测。
 *
 * 你需要知道的（纪律）：
 * 1. **序列必须按公告日期排序，不按报告期**。同一报告期可能补披露、修正，
 *    后公告的修正前面的——按报告期排会把修正版排到旧版后面（PIT 的老坑）。
 * 2. 转向判断只描述「发生了什么」，**不推测原因**（毛利率下滑是降价还是成本涨，
 *    比率里看不出来，要三表明细，而赤轨没有）。
 * 3. 少于 2 个报告期就不判断，写缺口。
 */

/** 一个报告期的比率快照。字段名与 data/backtest/fundamentals.json 一致。 */
export type EarningsPoint = {
  /** 公告日期（PIT 的关键：只能用公告日 ≤ 当日的数据） */
  ann: string;
  /** 报告期，如 20260930 */
  period: string;
  roe: number | null;
  /** 净利润同比增长（%），累计口径 */
  dtYoy: number | null;
  /** 销售毛利率（%） */
  gm: number | null;
  debt: number | null;
};

export type EarningsTurn = {
  label: string;
  /** 发生了什么（代码判的事实） */
  verdict: string;
  /** 必须叠加的反证/局限 */
  caution: string;
};

export type EarningsRead = {
  /** 按公告日期升序（旧的在前） */
  points: EarningsPoint[];
  latest: EarningsPoint | null;
  turns: EarningsTurn[];
  gaps: string[];
};

/** 按公告日期排序。同一天多条（补披露）保留全部，让调用方看见。 */
export function sortByAnn(rows: readonly EarningsPoint[]): EarningsPoint[] {
  return [...rows].sort((a, b) => a.ann.localeCompare(b.ann));
}

/** 连续 n 期同号（正/负）？数据不够返回 false。 */
function sameSignRun(values: readonly (number | null)[], n: number, positive: boolean): boolean {
  const usable = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (usable.length < n) return false;
  const tail = usable.slice(-n);
  return tail.every((v) => (positive ? v > 0 : v < 0));
}

/** 连续 n 期下滑？ */
function fallingRun(values: readonly (number | null)[], n: number): boolean {
  const usable = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (usable.length < n) return false;
  const tail = usable.slice(-n);
  for (let i = 1; i < tail.length; i += 1) if (!(tail[i]! < tail[i - 1]!)) return false;
  return true;
}

/**
 * 读一组报告期，给出转向判断。
 *
 * 判断全部基于**累计口径的比率**，所以每条 caution 都要提醒这一点——
 * 累计口径的方向和单季方向可能不同（它 SOP §3 的季节性那条，赤轨没数据拆，
 * 只能靠提醒）。
 */
export function readEarnings(rows: readonly EarningsPoint[]): EarningsRead {
  const points = sortByAnn(rows);
  const gaps: string[] = [];
  if (points.length === 0) {
    return { points, latest: null, turns: [], gaps: ["没有这只票的财报数据（跑过 scripts/fetch-fundamentals.py 才有）"] };
  }
  if (points.length < 2) gaps.push("只有一个报告期，看不出趋势，转向判断不成立");

  const latest = points[points.length - 1] ?? null;
  const dtYoys = points.map((p) => p.dtYoy);
  const gms = points.map((p) => p.gm);
  const roes = points.map((p) => p.roe);

  const turns: EarningsTurn[] = [];

  if (points.length >= 2) {
    if (sameSignRun(dtYoys, 2, true)) {
      turns.push({
        label: "净利润同比",
        verdict: "最近两期累计口径的净利润同比都为正",
        caution: "累计口径。同比转正可能来自低基数，不一定是经营改善；要看单季得有三表明细，赤轨没有",
      });
    }
    if (dtYoys[dtYoys.length - 1] != null && dtYoys[dtYoys.length - 2] != null) {
      const now = dtYoys[dtYoys.length - 1]!;
      const before = dtYoys[dtYoys.length - 2]!;
      if (before > 0 && now < 0) {
        turns.push({
          label: "净利润同比转负",
          verdict: "最近一期累计口径的净利润同比由正转负",
          caution: "这是本期最硬的转向信号；但仍是累计口径，单季可能已经先转负或后转负",
        });
      }
    }
    if (fallingRun(gms, 2)) {
      turns.push({
        label: "毛利率",
        verdict: "最近两期毛利率连续下滑",
        caution: "比率里看不出是降价还是成本涨，要三表明细；赤轨只有这一个比率",
      });
    }
    if (fallingRun(roes, 2)) {
      turns.push({
        label: "ROE",
        verdict: "最近两期 ROE 连续下滑",
        caution: "ROE 下滑可能来自利润率、周转或杠杆，三者分不清（杜邦拆解需要三表）",
      });
    }
  }

  if (latest?.debt == null) gaps.push("资产负债率东财这个接口不给（恒为 null），偿债能力这一段是空的");
  return { points, latest, turns, gaps };
}

/** 给 AI prompt 的财报口径段。 */
export const EARNINGS_SOP = [
  "## 财报口径（照 docs/EARNINGS.md）——注意这是**裁剪版**：原口径的单季拆解/TTM/三表交叉都需要",
  "绝对值科目和三表明细，赤轨都没有。你只能做累计口径的转向判断，做不了拆解。缺的那块是能力缺口。",
  "1. 赤轨只有三个**累计口径的比率**：净利润同比、毛利率、ROE。没有营收/净利润绝对值，",
  "   所以**不许提单季、环比、TTM、PE 分子那些赤轨算不出的东西**。",
  "2. 序列按**公告日期**排（不是报告期）——补披露会修正前面的记录。",
  "3. 转向判断只描述「发生了什么」，**不推测原因**：毛利率下滑是降价还是成本涨，比率里看不出来。",
  "4. 「同比连续为正」要提醒可能来自低基数；「转负」是更硬的信号。",
  "5. 数字只能来自证据，不许编；缺的写「未获取」。",
].join("\n");
