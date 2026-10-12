/**
 * 这个文件是干什么的：
 * 回测请求闸口 + 费用 drag 对照 + 来源标注的纯函数库。
 *
 * 你需要知道的：
 * 学 Vibe-Research 的 backtest/gate.py「三问闸口」：回测开跑之前，先回答三个问题——
 * 样本够不够、数据覆盖够不够、已知近似说清了没有。答得出来 → 输出 Plan（照跑）；
 * 答不出来 → 输出 Refusal（带 reason + remedy），**没有带一堆警告勉强跑的第三种**。
 * 闸口只输出决定，不碰网络不碰文件，所以能单测。
 *
 * 费用 drag 对照（cost_compare）：同一套交易跑两遍，一遍有费用一遍费用清零，
 * 两者之差就是费用吃掉的收益。只看有费收益会高估策略，drag 单独列出来才诚实。
 *
 * 来源标注（raw_ref）：每笔交易记录带来源指针（哪个 K 线缓存文件 @ 哪个信号日），
 * 事后复核能回到原始 bar，不靠记忆。
 */

/** 闸口输入：全部来自回测脚本 main() 里已经算出来的量，闸口不自己取数。 */
export type GateInput = {
  /** 打算抽多少只（BT_SAMPLE） */
  sampleRequested: number;
  /** 新浪股票池实际拿到多少只代码 */
  universeGot: number;
  /** 等距抽样后实际进池多少只 */
  sampleGot: number;
  /** loadKlines 之后拿到日线的只数 */
  klinesGot: number;
  /** 回测窗口要求的最少 bar 数（引擎里 idx<61 跳过，即至少 62 根） */
  minBarsRequired: number;
  /** 抽样里满足最少 bar 数的只数（预热 guard 的「实际 bar 数」） */
  sampleWithEnoughBars: number;
  /** 换手率闸本次是否生效（floatcap 缓存存在且没被 BT_TURNOVER=0 关掉） */
  turnoverGateActive: boolean;
  /** 用户是不是显式关掉了换手率闸（BT_TURNOVER=0）——这是合法的对照实验，不拒 */
  turnoverGateForcedOff: boolean;
};

export type GateDecision =
  | { kind: "plan"; plan: string[] }
  | { kind: "refusal"; reason: string; remedy: string };

/**
 * 三问闸口。判定规则（写成 RULE 常量，改判据先改这里，和 factors.ts 同规矩）：
 * R1 样本量：sampleGot < 50 → 统计上翻不出水花，拒。
 * R2 覆盖率：klinesGot < sampleGot 的一半 → 一半票没数据，结论不可外推，拒。
 * R3 预热：sampleWithEnoughBars < sampleGot 的一半 → 大部分票 bar 数不够 62 根，
 *    跑出来的交易集中在少数新上市票上，拒。
 * 换手率闸没生效不拒（引擎已大声提示），但 Plan 里必须带这条，让读者带着数读结果。
 */
export function decideGate(input: GateInput): GateDecision {
  const R1_MIN_SAMPLE = 50;
  const R2_MIN_COVER = 0.5;
  const R3_MIN_WARM = 0.5;

  if (input.sampleGot < R1_MIN_SAMPLE) {
    return {
      kind: "refusal",
      reason: `抽样只拿到 ${input.sampleGot} 只（要求 ≥ ${R1_MIN_SAMPLE}），样本量不足以做统计结论`,
      remedy: "检查新浪股票池接口是否截断（翻页失败）；或调大 BT_SAMPLE；或去掉 BT_CAP 过滤",
    };
  }
  const cover = input.sampleGot > 0 ? input.klinesGot / input.sampleGot : 0;
  if (cover < R2_MIN_COVER) {
    return {
      kind: "refusal",
      reason: `日线覆盖率 ${(cover * 100).toFixed(0)}%（${input.klinesGot}/${input.sampleGot}，要求 ≥ 50%），一半以上的票没有数据`,
      remedy: "检查网络与腾讯 K 线接口可达性；或先小样本 BT_SAMPLE=50 验证链路再放大",
    };
  }
  const warm =
    input.sampleGot > 0 ? input.sampleWithEnoughBars / input.sampleGot : 0;
  if (warm < R3_MIN_WARM) {
    return {
      kind: "refusal",
      reason: `预热不足：只有 ${input.sampleWithEnoughBars}/${input.sampleGot} 只满足最少 ${input.minBarsRequired} 根 bar，交易将集中在少数新上市票上`,
      remedy: "缩短 LOOKBACK 窗口；或换一批上市时间更长的样本（BT_OFFSET）",
    };
  }

  const plan = [
    `样本：股票池 ${input.universeGot} 只，等距抽样 ${input.sampleGot} 只，日线命中 ${input.klinesGot} 只`,
    `预热：${input.sampleWithEnoughBars} 只满足最少 ${input.minBarsRequired} 根 bar（占 ${(warm * 100).toFixed(0)}%）`,
    input.turnoverGateActive
      ? "换手率闸：已生效（floatcap 缓存命中）"
      : input.turnoverGateForcedOff
        ? "换手率闸：被 BT_TURNOVER=0 显式关闭，本次是有意对照，别拿它下结论"
        : "换手率闸：未生效（floatcap 缓存缺失）——放量突破结果偏宽松，先跑 scripts/build-floatcap.mjs",
  ];
  return { kind: "plan", plan };
}

/** 最小可回放的 trades 摘要（闸口/对照只关心这些字段，不依赖脚本的 Trade 类型）。 */
export type TradeLite = {
  id: string;
  date: string;
  /** 单笔收益率（有费或免费口径，由调用方区分） */
  ret: number;
  /** 来源标注：哪个数据文件 @ 哪个信号日。空串 = 老产物没带 ref，不编造。 */
  ref?: string;
};

export type CostDragRow = {
  key: string;
  label: string;
  n: number;
  avgWithFee: number | null;
  avgFree: number | null;
  /** 费用吃掉的平均单笔收益；任一侧没交易就是 null（缺的样子就是缺） */
  drag: number | null;
};

/**
 * 费用 drag 对照：同一策略两笔账（有费/免费）并排，drag = 有费均值 − 免费均值。
 * 笔数不一致时不强行配对——只比各自均值（每笔都扣了同样的费率，均值差就是费率差），
 * 但笔数差要在行里露出来（n 两侧本来就分开显示）。
 */
export function costDragRows(
  labels: Record<string, string>,
  withFee: Record<string, TradeLite[]>,
  free: Record<string, TradeLite[]>,
): CostDragRow[] {
  const rows: CostDragRow[] = [];
  for (const key of Object.keys(labels)) {
    const a = withFee[key] ?? [];
    const b = free[key] ?? [];
    const avg = (ts: TradeLite[]) => (ts.length > 0 ? ts.reduce((s, t) => s + t.ret, 0) / ts.length : null);
    const avgWithFee = avg(a);
    const avgFree = avg(b);
    rows.push({
      key,
      label: labels[key],
      n: a.length,
      avgWithFee,
      avgFree,
      drag: avgWithFee != null && avgFree != null ? avgWithFee - avgFree : null,
    });
  }
  return rows;
}

/** 格式化 drag 表的一行（脚本直接打印；纯函数方便测试钉死格式）。 */
export function formatDragRow(row: CostDragRow): string {
  const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(2)}%`);
  return (
    row.label.padEnd(14) +
    String(row.n).padEnd(6) +
    pct(row.avgWithFee).padStart(9) +
    pct(row.avgFree).padStart(9) +
    (row.drag == null ? "—" : `${(row.drag * 100).toFixed(3)}%`).padStart(11)
  );
}

/**
 * 来源标注：一笔交易所用 K 线对应的缓存文件 + 信号日。
 * 集中在这里生成，格式全站一处定义（UI-STANDARD 的文案单点纪律同源）。
 */
export function klineRef(cacheDir: string, id: string, signalDate: string): string {
  return `${cacheDir}/${id}.json@${signalDate}`;
}
