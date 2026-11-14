/**
 * 这个文件是干什么的：
 * 分时点 → 分钟级蜡烛的聚合（纯函数）。腾讯 day/query 每分钟只给单点价格
 * （HHMM price volume amount），没有 OHLC——把 N 个分钟点聚成一根蜡烛：
 * open=窗口第一笔、close=窗口最后一笔、high/low=窗口极值。
 *
 * 你需要知道的：
 * 1. 这是**派生 OHLC**：源数据是逐分钟快照价，不是真实的分钟竞价四价。
 *    5 分钟粒度下与真实蜡烛的偏差极小（窗口内最多 5 个采样点），但口径上是
 *    「聚合近似」，页脚要照实说。
 * 2. 纯函数零 IO，直接单测。points 少于窗口大小 → 一根蜡烛都出不来 → 空数组
 *    （调用方显示分时，不显示蜡烛）。
 */

export type MinuteCandle = {
  /** 窗口第一分钟的 HHMM。 */
  time: string;
  o: number;
  c: number;
  h: number;
  l: number;
};

/** 分时点 → N 分钟蜡烛。bucketMinutes 至少 2（1 分钟 = 每根只有一笔，画不出实体）。 */
export function minuteCandles(points: { time: string; price: number }[], bucketMinutes = 5): MinuteCandle[] {
  if (bucketMinutes < 2 || points.length < bucketMinutes) return [];
  const candles: MinuteCandle[] = [];
  for (let i = 0; i + bucketMinutes <= points.length; i += bucketMinutes) {
    const win = points.slice(i, i + bucketMinutes);
    candles.push({
      time: win[0].time,
      o: win[0].price,
      c: win[win.length - 1].price,
      h: Math.max(...win.map((w) => w.price)),
      l: Math.min(...win.map((w) => w.price)),
    });
  }
  return candles;
}

/** HHMM → 「HH:MM」。 */
export function hhmm(time: string): string {
  return /^\d{4}$/.test(time) ? `${time.slice(0, 2)}:${time.slice(2)}` : time;
}
