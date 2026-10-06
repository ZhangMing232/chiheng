/**
 * 这个文件是干什么的：
 * 账本里「一天」和「一笔」的形状。从 web 版的 src/lib/paper.ts 拆出来的。
 *
 * 为什么要拆：
 * paper.ts 里这两个类型是和 zustand 的 store 写在一起的（浏览器本地持久化用的）。
 * 小程序里没有 zustand，账本存云数据库，也用不上那套 store——但**形状的定义
 * 必须一模一样**，否则搬过来的 journal-book / lab / positions 会算出不一样的数。
 * 所以类型单独拆出来，两边共用同一份定义。
 */

export type PaperTrade = {
  id: string;
  code: string;
  name: string;
  entry: number;
  stop?: number;
  target?: number;
  style?: "early" | "trend" | "breakout" | "value" | "relay" | "rebound";
  hold?: number;
  exit: number | null;
  exitDate: string | null;
};

export type PaperDay = {
  date: string;
  savedAt: number;
  signalTime: string;
  status?: "provisional" | "locked";
  ruleVersion?: number;
  indexEntry: number | null;
  indexExit: number | null;
  trades: PaperTrade[];
};
