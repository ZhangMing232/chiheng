/**
 * 因子注册表 + 6 关防过拟合判决。
 *
 * 为什么要有这个文件：
 * 以前因子检验（scripts/backtest.ts 的 BT_FACTOR 分支）里，8 个因子是一个
 * 硬编码的 `{ name, get }` 数组，跑完只输出「最高档-最低档」的 spread 和 t 值，
 * G1 单调性、G3 两段同号、G4 换样本、G5 Bonferroni、G6 可交易性全都靠人工
 * 分几次跑、再肉眼比对、手填进 baseline。这样既容易漏判，也容易「改阈值直到
 * 过关」而不自知。
 *
 * 这个文件干两件事：
 *   1. 把因子做成**带元信息的注册表**——每个因子在跑之前就声明它的方向假设
 *      和经济逻辑（预注册）。跑完再看哪个显著、再补理由，等于自己骗自己。
 *   2. 把 6 关判决做成**纯函数**——输入一个因子的分档结果，输出每关过没过。
 *      纯函数没有 fetch、没有环境变量、没有副作用，所以能直接单测。
 *
 * 纪律（和 README/baseline 一致，别改）：
 *   超额 ≠ 收益；|t| < 2 等于没测出来；两段翻号 = 不能用；禁调参过关。
 */

/** metrics() 的返回类型。因子 getter 只从这里面取值，不碰原始 K 线。 */
export interface MetricRow {
  c: number;
  prev: number;
  open: number;
  low: number;
  prevLow: number;
  /** 当日涨跌幅（%） */
  chg: number;
  /** 5/10/20/60 日涨跌幅（%）。数据不够时是 null，不是 0。 */
  d5: number | null;
  d10: number | null;
  d20: number | null;
  d60: number | null;
  /** 动量加速：d5 - d20。短期相对中期在加速还是减速。 */
  momAccel: number | null;
  /** RSI(14)，0~100。 */
  rsi14: number | null;
  /** 乖离率：c / MA20 - 1。离 20 日均线多远。 */
  bias20: number | null;
  /** 20/60 日收益率标准差（%）。低波动异象用的。 */
  std20: number | null;
  std60: number | null;
  /** 20 日振幅均值（%）：(h-l)/c 的平均。 */
  amp20: number | null;
  /** 量价相关：过去 20 日 成交量 与 当日收益率 的相关系数，-1~1。 */
  corrVRet: number | null;
  /** 缩量天数：过去 20 日里成交量低于其 20 日均量的天数。 */
  shrinkDays: number | null;
  /** 距 20 日高点：c / high20 - 1。0 就是正踩着高点。 */
  distHigh20: number | null;
  /** 距 60 日低点：c / low60 - 1。0 就是正趴在低点。 */
  distLow60: number | null;
  /** 布林 %B：(c - lower) / (upper - lower)，0=下轨，1=上轨。 */
  bollB: number | null;
  /** 20 日区间位置：(c - low20) / (high20 - low20)，0=区间最低，1=最高。 */
  rangePos20: number | null;
  volRatio: number;
  volShrink: number;
  amountWan: number;
  turnover: number | null;
  /** 流通市值快照（今天的，非历史）。拿不到是 null。 */
  floatCap: number | null;
  /** 当日下影线占比：(min(open,close) - low) / (high - low)。0~1，一字板无振幅时 null。 */
  lowerWick: number | null;
  /** 波动压缩：std20 / std60。越小表示短期波动相对长期在收缩。 */
  volCompress: number | null;
  /** 连跌天数：截至今日连续「收盘 < 前收」的天数。今日收阳则 0。 */
  downStreak: number;
  /** 最近 6 日内最强威科夫 Spring 的强度 0~1。null = 最近没有 Spring，不是 0。 */
  springStrength: number | null;
  /** 那个 Spring 距今几天。0 = 就是今天。null = 没有 Spring。 */
  springAge: number | null;
  /** Spring 那根 K 线的最低价 = 结构失效位 = 止损价。null = 没有 Spring。 */
  springLow: number | null;
  /** Spring 所在区间的区间高点（算威科夫量幅目标用）。null = 没有 Spring。 */
  springRangeHigh: number | null;
  /**
   * 基本面三因子（2026-10-10 接入，数据源 akshare 东财业绩报表 / tushare fina_indicator，
   * 按披露日 PIT 对齐，见 fundamentals.ts）。只在 BT_FACTOR 因子检验分支由回测脚本
   * 用 pitValue 注值；策略信号分支不注，这些字段是 null/undefined。
   * null = 那天市面上没有已披露的财报（上市前/还没出），不是 0。
   */
  fRoe?: number | null;
  fDtYoy?: number | null;
  fGm?: number | null;
}

/**
 * 一个因子。
 * direction 是**预注册的方向假设**：+1 表示「因子值越大，未来超额越高」，
 * -1 表示「因子值越小，未来超额越高」。它在跑之前就写好，跑完不许改。
 */
export type Factor = {
  id: string;
  name: string;
  category: "动量" | "反转" | "波动率" | "量能" | "形态" | "规模" | "基本面";
  direction: 1 | -1;
  rationale: string;
  /**
   * 因子家族（共线检查用）。同一族 = 算的是同一个东西的不同窗口/变体
   * （std20 和 std60、成交额和流通市值）。家族 + 方向都相同的因子同时活着，
   * 等于一个因子被计了好几次——factor-family.ts 会点名。
   * 这是注册表层的近似警告；真共线要看收益序列相关，那需要数据。
   */
  family?: string;
  get: (m: MetricRow) => number | null;
};

/**
 * 因子注册表。前 8 个是历史遗留（BT_FACTOR 分支原本就有的），get 逻辑一字不改，
 * 保证重跑老 8 因子和 baseline 对得上；后面的是新扩充的，全都只用 OHLCV 可算的指标。
 */
export const FACTORS: Factor[] = [
  { id: "chg", name: "当日涨幅", category: "反转", direction: -1, family: "涨幅", rationale: "A 股日内反转：当天涨多了，次日倾向回落。", get: (m) => m.chg },
  { id: "d5", name: "5日涨幅", category: "反转", direction: -1, family: "涨幅", rationale: "短期反转：5 日涨多的倾向回落（已知两段翻号，不可用）。", get: (m) => m.d5 },
  { id: "d10", name: "10日涨幅", category: "动量", direction: 1, family: "涨幅", rationale: "10 日动量：刚进动量区间，强者可能延续。", get: (m) => m.d10 },
  { id: "d20", name: "20日涨幅", category: "动量", direction: 1, family: "涨幅", rationale: "中期动量：20 日向上的趋势可能延续。", get: (m) => m.d20 },
  { id: "d60", name: "60日涨幅", category: "反转", direction: -1, family: "涨幅", rationale: "中期反转：跌得多的后面弹得快（唯一站得住的老信号）。", get: (m) => m.d60 },
  { id: "momAccel", name: "动量加速", category: "动量", direction: 1, family: "涨幅", rationale: "d5-d20：短期相对中期在加速，动能增强。", get: (m) => m.momAccel },
  { id: "rsi14", name: "RSI14", category: "反转", direction: -1, family: "RSI", rationale: "超买回落：RSI 过高是超买，倾向均值回归。", get: (m) => m.rsi14 },
  { id: "bias20", name: "乖离率", category: "反转", direction: -1, family: "乖离", rationale: "偏离 20 日均线过远会回归。", get: (m) => m.bias20 },
  { id: "std20", name: "20日波动率", category: "波动率", direction: -1, family: "低波", rationale: "低波动异象：低波动的票未来超额更高。", get: (m) => m.std20 },
  { id: "std60", name: "60日波动率", category: "波动率", direction: -1, family: "低波", rationale: "低波动异象（更长窗）。", get: (m) => m.std60 },
  { id: "amp20", name: "20日振幅", category: "波动率", direction: -1, family: "低波", rationale: "低振幅≈低波动，同一套异象逻辑。", get: (m) => m.amp20 },
  { id: "corrVRet", name: "量价相关", category: "量能", direction: 1, family: "量价相关", rationale: "量价配合：放量上涨比放量下跌更健康。", get: (m) => m.corrVRet },
  { id: "volRatio", name: "量比", category: "量能", direction: 1, family: "量比", rationale: "放量进攻：量比放大是资金进场的信号。", get: (m) => m.volRatio },
  { id: "volShrink", name: "量能萎缩", category: "量能", direction: -1, family: "缩量", rationale: "缩量=抛压衰竭，超跌后缩量容易反弹。", get: (m) => m.volShrink },
  { id: "shrinkDays", name: "缩量天数", category: "量能", direction: -1, family: "缩量", rationale: "缩量越久，抛压衰竭越充分。", get: (m) => m.shrinkDays },
  { id: "distHigh20", name: "距20日高点", category: "形态", direction: -1, family: "距离", rationale: "离 20 日高点越远越超跌，越该反弹。", get: (m) => m.distHigh20 },
  { id: "distLow60", name: "距60日低点", category: "形态", direction: -1, family: "距离", rationale: "越贴近 60 日低点越超跌。", get: (m) => m.distLow60 },
  { id: "bollB", name: "布林%B", category: "形态", direction: -1, family: "区间位置", rationale: "接近下轨是超卖，倾向反弹。", get: (m) => m.bollB },
  { id: "rangePos20", name: "区间位置", category: "形态", direction: -1, family: "区间位置", rationale: "20 日区间低位→超跌反弹。", get: (m) => m.rangePos20 },
  { id: "amountWan", name: "成交额", category: "规模", direction: -1, family: "规模", rationale: "冷门小成交额的票被忽视，可能有溢价。", get: (m) => m.amountWan },
  { id: "floatCap", name: "流通市值", category: "规模", direction: -1, family: "规模", rationale: "小市值效应（注意是今天快照，非历史）。", get: (m) => m.floatCap },
  { id: "c", name: "股价", category: "规模", direction: -1, family: "规模", rationale: "低价股效应。", get: (m) => m.c },
  { id: "lowerWick", name: "下影线占比", category: "形态", direction: -1, family: "下影线", rationale: "长下影线=当日下方有承接，超跌后倾向反弹。", get: (m) => m.lowerWick },
  { id: "volCompress", name: "波动压缩", category: "波动率", direction: -1, family: "低波", rationale: "短期波动相对长期收缩=蓄势，延续低波动异象。", get: (m) => m.volCompress },
  { id: "downStreak", name: "连跌天数", category: "反转", direction: -1, family: "连跌", rationale: "连续下跌越久越超跌，均值回归倾向越强。", get: (m) => m.downStreak },
  {
    id: "springStrength",
    name: "威科夫Spring",
    category: "形态",
    direction: 1,
    rationale:
      "威科夫 Spring（假跌破）：股价跌到吸筹区下沿之下、当天被拉回区间内，" +
      "是抛压被吸收的证据。判四件事同时成立——最低价跌破前 60 日低点 0.5%~8%、" +
      "收盘收回区间内、下影线占全幅 ≥40%、跌幅未封跌停（跌停穿下沿是 SC 破坏，语义相反）。" +
      "强度 = 跌破深度×0.35 + 下影线×0.35 + 量比×0.20 + 收阳×0.10，再乘时效衰减。" +
      "**本因子刻意偏离威科夫原文两处，别「修正」回去：**" +
      "（1）**不设缩量条件，且量比越大越好**——原文说 Spring 当日应缩量至均量 30~50%，" +
      "按原文实现实测是负收益（量比<0.5 时前瞻 10 日超额 -0.54%，t=-1.00），分档单调递增到" +
      "≥0.9 组 +1.27%（t=7.88）。A 股假跌破当天缩量说明没人接盘，放量长下影才说明有资金主动接货。" +
      "（2）**只要求收在区间低点之上**，不要求回到区间 30% 位置——后者会把样本从 475 砍到 0，那是求新高。" +
      "四项权重是预注册值不是网格搜索拟合的（权重搜索等于偷偷多测几百个因子而 Bonferroni 仍按 1 个算）。" +
      "选它的理由：上一版 wyckoffAccum（d60×(1−volShrink) 的简单乘积）t=-1.69 不过 G2，比两个单因子都弱——" +
      "威科夫的核心是结构与序列，不是同一时刻两个数值相乘。" +
      "⚠️ 已知局限：本因子强度集中在低价小市值票上，回测侧 tradable（股价≥4、市值≥40亿）" +
      "会挡掉顶档相当一部分，G6 有真实挂点风险。若 G6 不过，解读是「超额集中在我们买不到的小票上」，" +
      "**不是「把闸门调低就能过」**——闸门对应真实下单约束。",
    get: (m) => m.springStrength,
  },
  {
    id: "f_roe",
    name: "净资产收益率",
    category: "基本面",
    direction: 1,
    family: "基本面",
    rationale:
      "质量因子：ROE 高的公司资本回报好，A 股长线定价偏有效，盈利质量应兑现为超额。" +
      "数据源 akshare 东财业绩报表（tushare 积分补齐后同源切换），**按披露日 PIT 对齐**——" +
      "t 日只用 ann_date <= t 的财报，4 月发的年报不许用在 1 月选股上（前视）。" +
      "⚠️ 预登记局限：ROE 静态偏慢，季度间跳变少，横截面区分度可能不够；" +
      "且年报/一季报披露集中，大部分交易日取值不变，6 关检验见真章。",
    get: (m) => m.fRoe ?? null,
  },
  {
    id: "f_dtyoy",
    name: "净利润同比",
    category: "基本面",
    direction: 1,
    family: "基本面",
    rationale:
      "成长因子：净利润同比增速高 = 基本面在改善，动量的基本面版本。" +
      "东财口径是净利润-同比增长(%)（tushare 版是扣非口径，两边切换时注意口径差，" +
      "同一因子数据集换了口径要重新过 6 关）。PIT 对齐同 f_roe。" +
      "⚠️ 预登记局限：同比基数效应大（扭亏股同比爆表但质量差），高增速档可能混进低质量票，" +
      "正好和 f_roe 互为补充——但同属基本面家族，factor-family 会点名它们，别当两个独立证据。",
    get: (m) => m.fDtYoy ?? null,
  },
  {
    id: "f_gm",
    name: "销售毛利率",
    category: "基本面",
    direction: 1,
    family: "基本面",
    rationale:
      "盈利质量因子：毛利率高 = 有定价权/成本优势，是 ROE 的上游驱动。" +
      "原计划的负债率因子（f_debt，方向 -1）因 akshare 东财业绩报表无资产负债率字段暂缓，" +
      "改用同接口可得的毛利率顶上；tushare 积分够 2000 后 fetch-fundamentals.ts 补 debt 再议。" +
      "PIT 对齐同 f_roe。毛利率季度间极稳，预登记判断：横截面区分度可能偏弱，6 关见真章。",
    get: (m) => m.fGm ?? null,
  },
];

/** 一次因子检验里，单个因子的分档结果（某一段区间、某一份样本）。 */
export type FactorRun = {
  /** 每档的平均超额，从因子值最低档到最高档。长度 = buckets。 */
  bucketMeans: number[];
  /** 最高档 - 最低档的平均超额。 */
  meanSpread: number;
  /** spread 的 t 值。 */
  t: number;
  /** 有效交易日数（当天能分档的天数）。 */
  nDays: number;
  /** 顶档票里被可交易闸（低价/市值/涨跌停）挡掉的比例，G6 用。 */
  topBlockedRatio: number;
};

export type DailyRow = { vals: (number | null)[]; ex: number; tradable?: boolean };

/**
 * 纯函数：把「每天每只票的因子取值 + 未来 N 天超额」分档，算每个因子的分档结果。
 *
 * daily 外层是交易日，内层是当天每只票。vals 长度 = 因子数，ex 是未来 N 天超额
 * （已经减掉同期全池）。分档逻辑和原来 BT_FACTOR 分支一字不差，只是抽出来可测。
 */
export function analyzeFactors(daily: DailyRow[][], factorCount: number, buckets = 5): FactorRun[] {
  const out: FactorRun[] = [];
  for (let f = 0; f < factorCount; f += 1) {
    const sum = new Array(buckets).fill(0);
    let days = 0;
    const spreads: number[] = [];
    let topTotal = 0;
    let topBlocked = 0;
    for (const today of daily) {
      const usable = today.filter((r) => r.vals[f] != null);
      if (usable.length < buckets * 10) continue;
      usable.sort((a, b) => (a.vals[f] as number) - (b.vals[f] as number));
      const q = Math.floor(usable.length / buckets);
      const meanOf = (slice: DailyRow[]) => slice.reduce((s, r) => s + r.ex, 0) / slice.length;
      const low = usable.slice(0, q);
      const high = usable.slice(usable.length - q);
      for (let b = 0; b < buckets; b += 1) {
        const slice = usable.slice(b * q, b === buckets - 1 ? usable.length : (b + 1) * q);
        if (slice.length > 0) sum[b] += meanOf(slice);
      }
      spreads.push(meanOf(high) - meanOf(low));
      topTotal += high.length;
      topBlocked += high.filter((r) => r.tradable === false).length;
      days += 1;
    }
    const each = sum.map((s) => s / Math.max(1, days));
    const meanSpread = spreads.reduce((s, v) => s + v, 0) / Math.max(1, spreads.length);
    const sd =
      spreads.length > 1
        ? Math.sqrt(spreads.reduce((s, v) => s + (v - meanSpread) ** 2, 0) / (spreads.length - 1))
        : 0;
    const t = sd > 0 ? meanSpread / (sd / Math.sqrt(spreads.length)) : 0;
    out.push({
      bucketMeans: each,
      meanSpread,
      t,
      nDays: days,
      topBlockedRatio: topTotal > 0 ? topBlocked / topTotal : 1,
    });
  }
  return out;
}

export type Gate = { pass: boolean; detail: string };

/** Spearman 秩相关（对并列值取平均秩）。返回 -1~1。 */
function spearman(x: number[], y: number[]): number {
  const rank = (arr: number[]) => {
    const order = arr.map((v, i) => [v, i] as [number, number]).sort((a, b) => a[0] - b[0]);
    const r = new Array(arr.length).fill(0);
    for (let i = 0; i < order.length; i += 1) {
      let j = i;
      while (j + 1 < order.length && order[j + 1][0] === order[i][0]) j += 1;
      const avgRank = (i + j) / 2 + 1;
      for (let k = i; k <= j; k += 1) r[order[k][1]] = avgRank;
      i = j;
    }
    return r;
  };
  const rx = rank(x);
  const ry = rank(y);
  const n = x.length;
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (rx[i] - mx) * (ry[i] - my);
    dx += (rx[i] - mx) ** 2;
    dy += (ry[i] - my) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

/**
 * G1 单调性：分档均值是否随档位单调，且方向符合预注册假设。
 * 用 Spearman 秩相关衡量单调程度，阈值 MONO_MIN 是预注册判据。
 */
export const MONO_MIN = 0.8;
export function gateMonotonic(means: number[], direction: 1 | -1): Gate {
  if (means.length < 3) return { pass: false, detail: "档位不足 3，判不了单调" };
  const rs = spearman(means.map((_, i) => i), means);
  const dirOk = Math.sign(rs) === direction;
  const pass = dirOk && Math.abs(rs) >= MONO_MIN;
  return {
    pass,
    detail: `Spearman=${rs.toFixed(2)}，方向${dirOk ? "符合" : "不符合"}预注册${direction > 0 ? "正向" : "反向"}`,
  };
}

/** G2：|t| ≥ 2 才算测出了东西。 */
export const T_MIN = 2;
export function gateT(t: number): Gate {
  return { pass: Math.abs(t) >= T_MIN, detail: `t=${t.toFixed(2)}` };
}

/**
 * G3 段一致性：前后两段 spread 同号，且各自 |t| ≥ 1。
 * 两段都显著、都同号，才不是「只在某段行情好看」。
 */
export const HALF_T_MIN = 1;
export function gateHalves(first: FactorRun, second: FactorRun): Gate {
  const sameSign = Math.sign(first.meanSpread) === Math.sign(second.meanSpread) && first.meanSpread !== 0;
  const bothStrong = Math.abs(first.t) >= HALF_T_MIN && Math.abs(second.t) >= HALF_T_MIN;
  const pass = sameSign && bothStrong;
  return {
    pass,
    detail: `前 ${(first.meanSpread * 100).toFixed(2)}%(${first.t.toFixed(2)}) / 后 ${(second.meanSpread * 100).toFixed(2)}%(${second.t.toFixed(2)})${sameSign ? "" : "（翻号）"}`,
  };
}

/**
 * G4 换样本：换一批互不重叠的股票，spread 仍同号且 |t| ≥ 2。
 * 用来排除「结论只在这一批票上成立」。
 */
export function gateResample(base: FactorRun, offset: FactorRun): Gate {
  const sameSign = Math.sign(base.meanSpread) === Math.sign(offset.meanSpread) && base.meanSpread !== 0;
  const pass = sameSign && Math.abs(offset.t) >= T_MIN;
  return {
    pass,
    detail: `原 ${(base.meanSpread * 100).toFixed(2)}% / 换样本 ${(offset.meanSpread * 100).toFixed(2)}%(${offset.t.toFixed(2)})${sameSign ? "" : "（翻号）"}`,
  };
}

/** 标准正态分位数（Acklam 近似）。p 是右尾概率，返回 z（P(Z > z) = p）。 */
export function zCritical(p: number): number {
  if (!(p > 0 && p < 1)) return NaN;
  // Acklam 近似是逆累积分布（返回 z 使 P(Z<=z)=pLeft）。
  // 这里 p 是右尾概率，所以先转成左尾累积概率 1-p。
  const pLeft = 1 - p;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  const pHigh = 1 - pLow;
  let q: number;
  if (pLeft < pLow) {
    q = Math.sqrt(-2 * Math.log(pLeft));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (pLeft <= pHigh) {
    q = pLeft - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }
  q = Math.sqrt(-2 * Math.log(1 - pLeft));
  return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
}

/**
 * G5 Bonferroni：按「已测因子总数 N」收紧阈值，α = 0.05。
 * N 越大临界 t 越高——这会让原来 t≈2.8 的信号在 N 变大后自己降级，这是对的。
 */
export const ALPHA = 0.05;
export function bonferroniThreshold(nTested: number): number {
  return zCritical(ALPHA / 2 / Math.max(1, nTested));
}
export function gateBonferroni(t: number, nTested: number): Gate {
  const crit = bonferroniThreshold(nTested);
  return {
    pass: Math.abs(t) >= crit,
    detail: `|t|= ${t.toFixed(2)} vs 临界 ${crit.toFixed(2)}（N=${nTested}）`,
  };
}

/**
 * G6 可交易性：顶档（最该买的那批）有多少比例被真实可交易闸（ST/低价/市值/涨跌停）
 * 挡掉。挡掉太多，说明「纸面上最好的一档」在实盘根本买不到，信号不可交易。
 */
export const TRADABLE_MAX_BLOCKED = 0.5;
export function gateTradable(blockedRatio: number): Gate {
  const pass = blockedRatio <= TRADABLE_MAX_BLOCKED;
  return { pass, detail: `顶档被挡 ${(blockedRatio * 100).toFixed(0)}%（阈值 ≤${(TRADABLE_MAX_BLOCKED * 100).toFixed(0)}%）` };
}

/** 把一组已按因子值排序的票切成 buckets 档，返回顶档减底档的超额。样本不足返回 null。 */
function spreadOf(sorted: DailyRow[], buckets: number): number | null {
  if (sorted.length < buckets) return null;
  const q = Math.floor(sorted.length / buckets);
  const lo = sorted.slice(0, q);
  const hi = sorted.slice(sorted.length - q);
  const mean = (s: DailyRow[]) => s.reduce((a, r) => a + r.ex, 0) / s.length;
  return mean(hi) - mean(lo);
}

/**
 * 缩量天数归因（研究性诊断，不进 6 关）：
 * 回答「shrinkDays 是不是 d60 的马甲」。如果是，它俩横截面高度相关，
 * 且把 d60 分档中性化之后，shrinkDays 的独立超额会缩到接近 0。
 * 同时按时间切成几段，看顶-底 spread 的翻号发生在哪一段——是不是和
 * 60 日反转同一波「环境变了」。
 *
 * daily 是 analyzeFactors 的输入（每交易日 × 每只票的因子值 + 未来超额）。
 * fShrink / fD60 是这两个因子在 vals 里的下标。
 */
export function diagnoseShrinkDays(
  daily: DailyRow[][],
  fShrink: number,
  fD60: number,
  buckets = 5,
  segments = 6,
) {
  const corrPerDay: number[] = [];
  const spreadPerDay: number[] = [];
  const neutSpreadPerDay: number[] = [];
  // 每天的 (在 daily 里的下标, 顶-底 spread)，给「精确到交易日」用。
  const spreadSeries: { idx: number; spread: number }[] = [];

  for (let di = 0; di < daily.length; di += 1) {
    const today = daily[di];
    const usable = today.filter((r) => r.vals[fShrink] != null && r.vals[fD60] != null);
    if (usable.length < buckets * 10) continue;

    corrPerDay.push(
      spearman(
        usable.map((r) => r.vals[fShrink] as number),
        usable.map((r) => r.vals[fD60] as number),
      ),
    );

    const byShrink = [...usable].sort((a, b) => (a.vals[fShrink] as number) - (b.vals[fShrink] as number));
    const sp = spreadOf(byShrink, buckets);
    if (sp != null) {
      spreadPerDay.push(sp);
      spreadSeries.push({ idx: di, spread: sp });
    }

    // d60 分档中性化后，档内 shrinkDays 的 spread 平均
    const byD60 = [...usable].sort((a, b) => (a.vals[fD60] as number) - (b.vals[fD60] as number));
    const qd = Math.floor(byD60.length / buckets);
    const perBucket: number[] = [];
    for (let b = 0; b < buckets; b += 1) {
      const slice = byD60.slice(b * qd, b === buckets - 1 ? byD60.length : (b + 1) * qd);
      const sub = [...slice].sort((a, b) => (a.vals[fShrink] as number) - (b.vals[fShrink] as number));
      const s = spreadOf(sub, buckets);
      if (s != null) perBucket.push(s);
    }
    if (perBucket.length > 0) neutSpreadPerDay.push(perBucket.reduce((a, v) => a + v, 0) / perBucket.length);
  }

  const avg = (l: number[]) => (l.length ? l.reduce((a, b) => a + b, 0) / l.length : 0);
  const corrAll = avg(corrPerDay);

  const segLen = Math.ceil(corrPerDay.length / segments);
  const corrSeg: number[] = [];
  const spreadSeg: number[] = [];
  for (let s = 0; s < segments; s += 1) {
    const c = corrPerDay.slice(s * segLen, (s + 1) * segLen);
    const p = spreadPerDay.slice(s * segLen, (s + 1) * segLen);
    if (c.length) corrSeg.push(avg(c));
    if (p.length) spreadSeg.push(avg(p));
  }

  const m = avg(neutSpreadPerDay);
  const sd =
    neutSpreadPerDay.length > 1
      ? Math.sqrt(neutSpreadPerDay.reduce((s, v) => s + (v - m) ** 2, 0) / (neutSpreadPerDay.length - 1))
      : 0;
  const neutT = sd > 0 ? m / (sd / Math.sqrt(neutSpreadPerDay.length)) : 0;

  return {
    corrAll,
    corrSeg,
    spreadSeg,
    spreadSeries,
    neutSpread: m,
    neutT,
    neutDays: neutSpreadPerDay.length,
  };
}

/**
 * 「缩量 + 止跌」复合诊断（研究性，不进 6 关）。
 * 背景：shrinkDays 单因子约四成交易日失效，失效期和全池方向无关。假设失效来自
 * 「缩量里混着还在阴跌的票」——缩量有两种，抛压衰竭（好）和无人问津（坏），
 * 单看缩量分不出来。这里加一个「当日止跌」（收涨 chg > 0）条件，看能不能把
 * 坏的滤掉。
 *
 * 每天把票按 shrinkDays 分档取顶档（缩量最多），再按是否止跌劈两半，输出两半
 * 各自的平均超额。关键看「止跌 - 不止跌」的溢价是不是稳定为正——尤其在最长
 * 的翻号段（缩量整体失效时）里，止跌组是不是还扛得住。
 */
export function diagnoseShrinkBull(daily: DailyRow[][], fShrink: number, fChg: number, buckets = 5) {
  const byDay: { idx: number; topBull: number | null; topBear: number | null; topAll: number | null; bullN: number; bearN: number }[] = [];
  for (let di = 0; di < daily.length; di += 1) {
    const today = daily[di];
    const usable = today.filter((r) => r.vals[fShrink] != null);
    if (usable.length < buckets * 10) continue;
    const sorted = [...usable].sort((a, b) => (a.vals[fShrink] as number) - (b.vals[fShrink] as number));
    const q = Math.floor(sorted.length / buckets);
    const top = sorted.slice(sorted.length - q);
    const bulls = top.filter((r) => (r.vals[fChg] ?? 0) > 0);
    const bears = top.filter((r) => (r.vals[fChg] ?? 0) <= 0);
    const mean = (s: DailyRow[]) => (s.length ? s.reduce((a, r) => a + r.ex, 0) / s.length : null);
    byDay.push({
      idx: di,
      topBull: mean(bulls),
      topBear: mean(bears),
      topAll: mean(top),
      bullN: bulls.length,
      bearN: bears.length,
    });
  }
  return byDay;
}
