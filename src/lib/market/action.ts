/** 打开页面时只该做的一件事。止损优先于止盈，卖出优先于新的买入。 */
export function nowAction(input: {
  stopNames: string[];
  dueNames: string[];
  lockedCount: number;
  tail: boolean;
  marketOpen: boolean;
  /** 休市时用来区分还没开盘和午间。 */
  pause?: string;
}): { title: string; body: string } {
  if (input.stopNames.length > 0) {
    return {
      title: `先止损 ${input.stopNames.join("、")}`,
      body: "现价已经到止损价。先砍掉，再看别的。",
    };
  }
  if (input.dueNames.length > 0) {
    return {
      title: `先卖 ${input.dueNames.join("、")}`,
      body: "现价已经到目标卖出价。卖完再看新的买入。",
    };
  }
  if (input.lockedCount > 0) {
    return { title: "只买还没涨过参考价的", body: "标着「别追」的不要买。跌回启动幅度就止损，20 日涨到策略上限就止盈。" };
  }
  if (input.tail) {
    return { title: "尾盘可以买了", body: "现价打到买入价就记入。次日补涨也从 14:30 开始。" };
  }
  if (input.marketOpen) {
    return { title: "现在只观察", body: "现价打到这只股票的买入价才记入，没到不要买。" };
  }
  if (input.pause === "午间休市") {
    return { title: "午间休市", body: "下午 13:00 开盘后再看。买入价还没到的，先别买。" };
  }
  return { title: input.pause || "还没开盘", body: "下面是观察。开盘后，现价打到买入价才记入。" };
}
