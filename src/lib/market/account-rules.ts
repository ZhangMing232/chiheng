/**
 * 这个文件是干什么的：
 * 实盘账户的**交易权限**规则（2026-11-18 用户提供三个账户档案）。
 *
 * 为什么要有它：翻倍引擎给出买卖计划前，必须先判「这只票哪个账户能买」。
 * 给错账户的票 = 计划作废（比如科创板 688 的票，只有国泰海通能买）。
 * 这是硬约束，不是建议。
 */

/** 账户 id。 */
export type AccountId = "国泰海通" | "东莞证券" | "广发证券";

/** 账户能交易的板块。 */
export type Board = "main" | "chinext" | "star" | "bse";

const ACCOUNT_BOARDS: Record<AccountId, Board[]> = {
  国泰海通: ["main", "chinext", "star", "bse"],
  东莞证券: ["main", "chinext"],
  广发证券: ["main", "chinext"],
};

/** 股票代码 → 板块。带 sh/sz/bj 前缀的 id。 */
export function boardOf(id: string): Board {
  const bare = id.replace(/^(sh|sz|bj)/i, "");
  if (id.startsWith("bj") || bare.startsWith("8") || bare.startsWith("4") || bare.startsWith("92")) return "bse";
  if (id.startsWith("sh688") || id.startsWith("sh689")) return "star";
  if (bare.startsWith("300") || bare.startsWith("301")) return "chinext";
  return "main";
}

/** 某账户能否交易某只票（带 sh/sz/bj 前缀的 id）。 */
export function canTrade(account: AccountId, id: string): boolean {
  return (ACCOUNT_BOARDS[account] ?? []).includes(boardOf(id));
}

/** 一只票能被哪些账户交易。空数组 = 没账户能买（不该出现在计划里）。 */
export function tradableAccounts(id: string): AccountId[] {
  return (["国泰海通", "东莞证券", "广发证券"] as AccountId[]).filter((a) => canTrade(a, id));
}

/** 计划里推荐买卖时，附带该票的可交易账户（给用户看）。 */
export function accountHint(id: string): string {
  const accounts = tradableAccounts(id);
  if (accounts.length === 0) return "无账户可交易（权限不足）";
  return accounts.join(" / ");
}
