/**
 * 已摘牌因子档案（2026-11-05 立）。
 *
 * 「摘牌」不是删除：`FACTORS` 里 4 个定义一字不动地留着（含 get 和预注册方向），
 * 只是不再进入每轮的 6 关检验。想恢复，从这里删掉对应 id 即可——不需要重写因子。
 *
 * 为什么不留着当「未测」：这 4 个不是「暂时没数据、等等就有」，而是**已实查确认
 * 当前拿不到**（数据源停披露 / 历史只留 6 天 / 横截面结构性不够）。每天挂一行
 * 「未测 · 数据缺失」既不是信息，还会让 AI 反复把它们当新方向提。
 * 摘牌后它们在页面上单独一档，原因、证据、恢复条件全写着——**不是藏起来**。
 *
 * 用户纪律：「拿不到 ≠ 没有」。所以这里记的是「为什么拿不到」和「什么条件下能恢复」，
 * 不是「这个思路没用」。历史批次（factor-runs.jsonl）里的旧行原样保留，当时的
 * 「未测」是当时的真实状态，不回改。
 */

export type RetiredKind = "no-source" | "structural";

export type RetiredFactor = {
  id: string;
  name: string;
  at: string;
  kind: RetiredKind;
  /** 一句话，页面上给人看的。 */
  reason: string;
  /** 实查证据（接口、条数、日期），免得以后有人凭印象说「应该能接」。 */
  evidence: string;
  /** 什么条件下可以摘回来重新注册。 */
  reviveWhen: string;
};

export const RETIRED_FACTORS: RetiredFactor[] = [
  {
    id: "north_amount",
    name: "北向成交额",
    at: "2026-11-05",
    kind: "no-source",
    reason: "🔴 数据源停披露：沪深港通 2024-08 起不再公布北向每日资金数据，当前回测窗口内没有任何可得的历史序列。",
    evidence:
      "东财 push2his kamt.kline 历史接口实测返回 0 条；tushare moneyflow_hsgt 这个 token 无权限（积分不够，全线 403）。",
    reviveWhen: "有第三方付费/存档的北向逐日成交额历史（含个股或至少能摊到个股的口径）时重新注册。",
  },
  {
    id: "news_tone",
    name: "快讯情绪",
    at: "2026-11-05",
    kind: "no-source",
    reason: "🔴 历史接不了：免费快讯源只留约 6 天，回测要的是一年以上的逐日横截面。",
    evidence:
      "新浪 7×24 feed 翻到第 100 页就是 2026-10-30，再往后返回同一批数据；东财快讯 sortEnd 游标翻不了历史（每页都一样）；tushare news 无权限。",
    reviveWhen: "买到带历史归档的新闻/快讯库（能按日回放到每只票的情绪分）时重新注册。",
  },
  {
    id: "hot_seats",
    name: "游资热度",
    at: "2026-11-05",
    kind: "structural",
    reason: "⚠️ 数据接上了，但横截面结构性不够：龙虎榜能买的票太少，分 5 档要求 ≥50 只有效样本都凑不齐；且 G4 换样本必然把上榜票全换掉（测的是另一个东西）。",
    evidence:
      "data/risk/hotmoney/ 352 个有效日、名称→代码映射 100% 命中；但每天上榜 ~426 只 → 能映射 159 → 剔掉 ST/退市/北交所后**能买的只剩 ~80 只**，1200 只样本里捞到 ~36 只。",
    reviveWhen: "样本池换成「只在龙虎榜股票内检验」并单独设计 G4（同池内换日期而非换票）时重新注册——不是补数据能解决的。",
  },
  {
    id: "hot_netbuy",
    name: "游资净买",
    at: "2026-11-05",
    kind: "structural",
    reason: "⚠️ 同游资热度：龙虎榜横截面只有 ~80 只能买的票，凑不齐分档样本，G4 换样本也失去意义。",
    evidence: "与 hot_seats 同源同限制，见该条证据。",
    reviveWhen: "同 hot_seats：需要改检验设计（榜内样本 + 同池换时间），不是补数据。",
  },
];

export const RETIRED_IDS: ReadonlySet<string> = new Set(RETIRED_FACTORS.map((r) => r.id));

/**
 * 已摘牌因子对应的**表达式变量名**（factor-expr.ts 的 MetricRow 字段）。
 *
 * 这些变量还在编译器白名单里（删了会让旧队列条目的表达式突然编不过），
 * 但回测里它们恒为 null：用了它们的因子每轮都是 nDays=0 的「未测」。
 * 所以要在**提议端**显式拦住——AI 提一个永远测不出来的因子，白费一轮检验，
 * 还会在界面上多一行「未测」，把「拿不到」又演成「没效果」。
 *
 * 拦截时要把原因说全（见 retiredVarReason），不是静默编译失败。
 * 恢复时从这里删掉变量名即可。
 */
export const RETIRED_VARS: ReadonlySet<string> = new Set([
  "northAmount",
  "newsTone",
  "hotSeatCount",
  "hotNetBuy",
]);

/** 给提案被拒时的理由：既说不能用，也说为什么、什么条件下能解禁。 */
export function retiredVarReason(used: string[]): string {
  const hits = RETIRED_FACTORS.filter((r) =>
    used.some((v) => (r.id === "north_amount" && v === "northAmount")
      || (r.id === "news_tone" && v === "newsTone")
      || ((r.id === "hot_seats" || r.id === "hot_netbuy") && (v === "hotSeatCount" || v === "hotNetBuy"))),
  );
  const brief = hits.map((r) => `${r.name}（${r.kind === "no-source" ? "数据源已停披露/无历史" : "横截面结构性不够"}）`).join("、");
  return `表达式用了已摘牌的变量 ${used.join("/")}：${brief || "数据当前不可得"}。` +
    `这些字段在回测里恒为 null，因子会永远判「未测」——不是测了没效果。` +
    `请换可用字段；解禁条件见 /factors/gates 页底部「已摘牌因子」。`;
}
