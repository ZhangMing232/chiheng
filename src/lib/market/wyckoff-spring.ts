/**
 * 这个文件是干什么的：
 * 威科夫 Spring（假跌破）的**事件检测**，产出连续强度值，供因子检验和回测选股共用。
 *
 * 你需要知道的：
 *
 * 1. **为什么放这里而不放 factors.ts**：`Factor.get` 的契约是「只从 MetricRow 取值，
 *    不碰原始 K 线」。Spring 最深要回看 i-65 天的 K 线，天然违反该契约。
 *    这个文件不 import 任何东西，`node --test` 能直跑。
 *
 * 2. **🔴 本文件刻意偏离威科夫原文两处，都是实测标定的**（详见 VOL_RATIO_CAP 的注释）。
 *    原文说 Spring 当日应**缩量**至均量 30~50%；实测按原文做是**负收益**，
 *    分档单调递增到「放量」那组最强。所以这里不设缩量硬闸，量比越大越好。
 *    **别看着别扭就"修正"回原文**——那是把一个已验证的负收益条件请回来。
 *
 * 3. **无前视是铁律**：`detectWyckoffSpring(rows, i, limitPct)` 只读 rows[0..i]。
 *    两个滚动窗口都是**右开**的：
 *      - 区间低点 [j-RANGE_WIN, j) —— **含 j 会让 depth 恒 ≤0、Spring 永不触发**
 *      - 均量     [j-VOL_WIN, j)     —— **含 j 会让放量日量比恒等于 1**
 *    这两个坑在统计上的表现都是「因子完全不触发」，不报错、人眼看不出来，
 *    所以 wyckoff-spring.test.ts 里有专门的测试钉死它们。
 *
 * ── 标定纪律（这一段不许删）──
 * 本文件的阈值来自一次样本标定。纪律：
 *   1. 每个阈值**只标定一次**。现在的值就是终值。
 *   2. 改动任何一个阈值 = 提出一个新假设，必须：重跑 BT_FACTOR 的 6 关、
 *      跑一遍敏感性矩阵、在 baseline 里写清改了什么、为什么、以及改了之后
 *      G1~G6 的原话。**跑完发现「原来那个更好」就改回去，并在注释里记一句。**
 *   3. 严禁网格搜索权重（W_*）。权重搜索 = 偷偷多测几百个因子，
 *      而 G5 Bonferroni 的 N 仍按 1 个算 —— 这是项目纪律明令禁止的。
 *   4. 如果 6 关不过，正确动作是**如实记录「不过」**并继续找别的信号，
 *      不是调阈值调到过。
 */

/** 一根日 K 的最小形状。故意不 import types.ts 的 Bar：这个文件要能独立单测。 */
export type SpringBar = { o: number; c: number; h: number; l: number; v: number };

// ─────────── 阈值常量。每个都写清标定依据，改动即改假设 ───────────

/**
 * 区间窗口：往前看多少根 K 线定义「吸筹区」。
 * 标定依据：实测 win=40 / 60 / 120 三档，40 和 120 都翻号，只有 60 稳
 * （spread +0.52%, t=2.84；前半段 +0.75/t=3.41，后半段 +0.36/t=1.37）。
 * 别试别的值——试了就叫调参。
 */
export const RANGE_WIN = 60;

/**
 * 时效窗口：Spring 发生后，第几天还算「刚发生」。
 * 标定依据：实测 lookback=3 后段翻号；5/6/8/10 都稳，取 6（威科夫原文说 1~3 天，取两倍）。
 */
export const LOOKBACK = 6;

/** 跌破深度下限。标定依据：下限放宽是实测结论——A 股噪音大，0.5%~1% 区间样本最多（4072 笔）且稳定。 */
export const DEPTH_MIN = 0.005;

/**
 * 跌破深度上限 8%。**这一条是数据质量闸，不是经济逻辑闸。**
 * 已知脏 bar：sh601091 2026-09-18 的 o=15 c=57.77（单日 +177%），以及真实跌停穿下沿。
 * 上限把两者一起挡掉。放宽它 = 让脏数据进来。
 */
export const DEPTH_MAX = 0.08;

/**
 * 下影线占全幅比例下限 0.4。
 * 标定依据：实测 0.3 后段翻号，0.5/0.6 更差，0.4 是拐点。
 * 注意**不是越长越好**——无实体的高分几乎全是崩盘日，所以上面配 DEPTH_MAX 兜底。
 */
export const WICK_MIN = 0.4;

/** 量比窗口。含今日会让放量日量比恒等于 1，所以窗口右开。 */
export const VOL_WIN = 20;

/**
 * 量比封顶。**🔴 这里刻意偏离威科夫原文。**
 * 原文说 Spring 当日应缩量至均量 30~50%；按原文实现实测是**负收益**。
 * 按前瞻 10 日超额分档：
 *   量比 <0.5    −0.54%  t=−1.00  (n=189)   ← 原文说的区间，负收益
 *   量比 0.5-0.7 +0.21%  t=+0.75  (n=816)
 *   量比 0.7-0.9 +0.38%  t=+1.75  (n=1201)
 *   量比 ≥0.9   +1.27%  t=+7.88  (n=2515)   ← 最强
 * 单调递增。解释：A 股假跌破当天缩量说明**没人接盘**；放量长下影才说明
 * **有资金主动接货**。所以不设缩量硬闸，≥0.9 起算强，2.0 以上饱和不奖励天量。
 */
export const VOL_RATIO_CAP = 2;

/**
 * 强度权重。**预注册值，不是网格搜索拟合的**（纪律第 3 条）。
 * 四项各司其职：depth 看假跌破的深度，wick 看收回的力度，量比看有没有资金接，
 * 收阳看当天多空谁赢了。
 */
export const W_DEPTH = 0.35;
export const W_WICK = 0.35;
export const W_VOL = 0.2;
export const W_BULL = 0.1;

/**
 * 时效衰减：每过一天，强度乘 (1 − RECENCY_DECAY)。
 *
 * ⚠️ **这里有一个诚实的张力，不要装作没有**：标定时按「距上次 Spring 天数」分组的
 * 前瞻 10 日超额是**递增**的（day0 +0.79% / day3 +1.62% / day4 +1.96%），
 * 而这个衰减项是**递减**的，两者方向相反。
 * 我的读法是：因子检验量的是「第 i 天收盘起算的 10 日超额」，策略量的是
 * 「第 i 天收盘买入」，窗口对齐方式不同，两者可以同时成立——**但这是推测，未经验证**。
 * 处理：衰减系数进敏感性矩阵第一优先级，并把 age 作为独立维度扫一遍。
 * 如果扫出来 age≥3 反而更好，正确做法是**改结论并重跑 6 关**，不是把系数调小。
 */
export const RECENCY_DECAY = 0.06;

/** 检测结果。strength ∈ [0,1]，age ∈ [0, LOOKBACK-1]。 */
export type SpringHit = {
  strength: number;
  /** Spring 发生在 i 往前几天。0 = 就是今天。 */
  age: number;
  /** Spring 那一根 K 线的最低价 = 结构失效位 = 止损价。 */
  springLow: number;
  /** 跌破深度（小数，0.03 = 3%）。 */
  depth: number;
  /** 下影线占全幅比例。 */
  wick: number;
  /** 当日量比（已封顶 VOL_RATIO_CAP）。 */
  volRatio: number;
  /** 区间高度 = 区间高 − 区间低，威科夫量幅目标用。 */
  rangeHeight: number;
};

/** 区间 [from, to) 的最低价。**to 右开**。手写循环，避免 Math.min(...map) 每次分配数组。 */
function lowOf(rows: SpringBar[], from: number, to: number): number {
  let m = Infinity;
  for (let k = from; k < to; k += 1) if (rows[k].l < m) m = rows[k].l;
  return m;
}

/** 区间 [from, to) 的最高价。**to 右开**。 */
function highOf(rows: SpringBar[], from: number, to: number): number {
  let m = -Infinity;
  for (let k = from; k < to; k += 1) if (rows[k].h > m) m = rows[k].h;
  return m;
}

/** 区间 [from, to) 的成交量之和。**to 右开** —— 含今日会让放量日量比恒等于 1。 */
function sumVol(rows: SpringBar[], from: number, to: number): number {
  let s = 0;
  for (let k = from; k < to; k += 1) s += rows[k].v;
  return s;
}

/**
 * 这一根是不是封死跌停。
 *
 * 为什么必须排除：跌停穿下沿在威科夫里是 SC（供给出现）破坏，语义和 Spring 相反。
 * 实测加不加这道闸统计上一样（spread 都 +0.39%）——**是为了逻辑正确，不是为了提升效果**。
 *
 * ⚠️ **已知近似：回测里判不出 ST 股。** 线上用 limitTag(quote) 靠 Quote.name 识别 ST
 * （5% 跌幅），回测没有 name，只能按代码判板（ST 走 10%）。结果是**回测里 ST 股的
 * 跌停闸偏松**：一只真 ST 股跌 5% 封死，回测算「只跌了 5%，没到板」。这类票会混进
 * Spring 样本。K 线不带 ST 标记，本轮无法修。
 */
function isSealedDown(rows: SpringBar[], j: number, limitPct: number): boolean {
  if (j < 1) return false;
  const prev = rows[j - 1].c;
  const bar = rows[j];
  if (!(prev > 0)) return false;
  const down = Math.round(prev * (1 - limitPct / 100) * 100) / 100;
  if (!(down > 0)) return false;
  const drop = ((prev - bar.c) / prev) * 100;
  // 留 0.5 个点容差挡四舍五入；再要求最高价也在板下 = 真的封死了，不是砸下去又拉回来
  return drop <= limitPct + 0.5 && bar.c <= down + 0.01 && bar.h <= down + 0.01;
}

/** 第 j 根单独看是不是一个 Spring。**只用 rows[0..j]**。拆出来是为了让单测能逐条钉判定条件。 */
export function isSpringAt(
  rows: SpringBar[],
  j: number,
  limitPct: number,
): { depth: number; wick: number; volRatio: number; rangeLow: number; rangeHeight: number } | null {
  // 数据不足：既要有区间低点 [j-60, j)，也要有均量 [j-20, j)
  if (j < RANGE_WIN || j < VOL_WIN) return null;

  // 区间低点。**窗口右开，绝不能含 j** —— 含了 j 则 low <= rows[j].l，depth 恒 <= 0，永不触发。
  const rangeLow = lowOf(rows, j - RANGE_WIN, j);
  if (!(rangeLow > 0)) return null;
  const rangeHigh = highOf(rows, j - RANGE_WIN, j);

  const bar = rows[j];
  if (!(bar.h > bar.l)) return null; // 一字板 / 残缺 K，无振幅可言

  const depth = (rangeLow - bar.l) / rangeLow;
  // 上限 DEPTH_MAX 是脏 bar 和真跌停的护栏，别当成经济逻辑去放宽
  if (depth < DEPTH_MIN || depth > DEPTH_MAX) return null;

  const wick = (Math.min(bar.o, bar.c) - bar.l) / (bar.h - bar.l);
  if (wick < WICK_MIN) return null;

  // 收回条件：**只要求收在区间低点之上**。若要求「回到区间 30% 位置」，
  // 样本从 475 砍到 0 —— 那是求新高，不是 Spring。
  if (!(bar.c > rangeLow)) return null;

  // 量比。窗口右开 [j-20, j)，**不含今日**，否则放量日量比恒等于 1（静默失效）。
  const vol20 = sumVol(rows, j - VOL_WIN, j);
  if (!(vol20 > 0)) return null;
  const volRatio = Math.min(bar.v / (vol20 / VOL_WIN), VOL_RATIO_CAP);

  // 跌停闸：语义排除 SC 破坏，不是为了提效果
  if (isSealedDown(rows, j, limitPct)) return null;

  return { depth, wick, volRatio, rangeLow, rangeHeight: rangeHigh - rangeLow };
}

/**
 * 最近 LOOKBACK 个交易日里最强的那个 Spring。**只用 rows[0..i]，无前视。**
 *
 * limitPct 传 boardLimit(id, "")，name 传空串退化为按代码判板（见 isSealedDown 的已知近似）。
 * 返回 null = 这只票最近没有 Spring（因子检验里这是「该股该日不可分档」）。
 */
export function detectWyckoffSpring(rows: SpringBar[], i: number, limitPct: number): SpringHit | null {
  let best: SpringHit | null = null;
  // age=0 是今天，最强
  for (let age = 0; age < LOOKBACK; age += 1) {
    const j = i - age;
    if (j < RANGE_WIN || j < VOL_WIN) continue;
    const hit = isSpringAt(rows, j, limitPct);
    if (!hit) continue;

    // 强度 = 四项加权 × 时效衰减。权重是预注册值（见文件头纪律第 3 条）。
    const raw =
      (Math.min(hit.depth / DEPTH_MAX, 1) * W_DEPTH +
        Math.min(hit.wick, 1) * W_WICK +
        (hit.volRatio / VOL_RATIO_CAP) * W_VOL +
        (rows[j].c > rows[j].o ? W_BULL : 0));
    const strength = raw * (1 - RECENCY_DECAY * age);

    if (!best || strength > best.strength) {
      best = {
        strength,
        age,
        springLow: rows[j].l,
        depth: hit.depth,
        wick: hit.wick,
        volRatio: hit.volRatio,
        rangeHeight: hit.rangeHeight,
      };
    }
  }
  return best;
}