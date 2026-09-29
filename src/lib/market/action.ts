/** 打开页面时只该做的一件事。止损优先于卖出，卖出优先于新的买入。 */
export function nowAction(input: {
  stopNames: string[];
  dueNames: string[];
  openCount: number;
  tailHalf: boolean;
  marketOpen: boolean;
  relay: boolean;
  /** 休市时用来区分还没开盘和午间。 */
  pause?: string;
}): { title: string; body: string } {
  if (input.stopNames.length > 0) {
    return {
      title: `先止损 ${input.stopNames.join("、")}`,
      body: "现价已经到止损价，而且不是买入当天。先卖出，再看别的。",
    };
  }
  if (input.dueNames.length > 0) {
    return {
      title: `先卖 ${input.dueNames.join("、")}`,
      body: "现价已经到卖出价，而且不是买入当天。卖完再看新的买入。",
    };
  }
  if (input.pause === "午间休市") {
    return { title: "午间休市", body: "下午 13:00 再看。现价没打到买入价的，先别买。" };
  }
  if (!input.marketOpen && !input.tailHalf) {
    return { title: input.pause || "还没开盘", body: "下面是观察。开盘后，现价打到买入价才记入。" };
  }
  if (input.relay && input.marketOpen && !input.tailHalf) {
    return { title: "补涨还是预览", body: "14:30 之前名单和价格都会变。现在标的是预估价，先别买。" };
  }
  if (input.relay && input.tailHalf && input.marketOpen) {
    return { title: "尾盘确认补涨", body: "14:30 的名单已经冻结。现价还在买入价上、又没涨停的才记入，下一交易日卖。" };
  }
  if (input.marketOpen) {
    return { title: "现价到了才买", body: "打到买入价就记入。没到这个价不要买。买入当天不能卖。" };
  }
  const held = input.openCount > 0 ? `这套还有 ${input.openCount} 只持仓。` : "这套今天没有新的持仓。";
  return { title: "已收盘", body: `${held}没打到买入价的不算。` };
}