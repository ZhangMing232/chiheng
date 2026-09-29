/** 打开页面时只该做的一件事。止损优先于止盈，卖出优先于新的买入。 */
export function nowAction(input: {
  stopNames: string[];
  dueNames: string[];
  lockedCount: number;
  tail: boolean;
  marketOpen: boolean;
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
    return { title: "只买还没涨过参考价的", body: "标着「别追」的不要买。跌到止损价就卖，涨到目标价也卖。" };
  }
  if (input.tail) {
    return { title: "尾盘正在锁定买入价", body: "这一轮锁定之后，参考价不再改。" };
  }
  if (input.marketOpen) {
    return { title: "现在只观察，先别买", body: "买入价要到 14:40 以后才锁定。" };
  }
  return { title: "还没开盘", body: "下面是按偏好筛出来的观察，买入价还没锁定。" };
}
