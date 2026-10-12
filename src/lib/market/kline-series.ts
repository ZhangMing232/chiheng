/**
 * 这个文件是干什么的：
 * K 线蜡烛图的纯数据层：把 Bar[] 提成 ECharts 要的两组 series 数据
 * （蜡烛 + 成交量），顺手算 MA5/MA10。纯函数，单测钉口径。
 *
 * 你需要知道的（学 Vibe-Research 的 KlineCard，但数据形状按赤轨自己的 Bar 来）：
 * - 蜡烛一根是 [open, close, low, high] 四元组——ECharts 的固定顺序，close 在
 *   open 后面、low/high 收尾，写反了蜡烛颜色全反（阳变阴）。
 * - **红涨绿跌是 A 股铁律**（UI-STANDARD 第 1 节）：收 >= 开是阳线用 up 色，
 *   反之用 down 色。蜡烛 itemStyle 按「这一根是阳是阴」逐根着色，不按当日涨跌
 *   （和昨收比）——蜡烛图的颜色语义就是开收关系。
 * - MA 从第 n 根才开始有值，之前是 null，图上断开不断线补零。
 */

/** 一根蜡烛。value 是 ECharts 的 [开, 收, 低, 高]。 */
export type Candle = { date: string; value: [number, number, number, number]; up: boolean; volume: number };

/** 算一条 MA 均线。前 n-1 个是 null（数据不足），用 null 而不是 0 或前值的重复。 */
export function maOf(closes: number[], n: number): (number | null)[] {
  return closes.map((_, i) => {
    if (i < n - 1) return null;
    let sum = 0;
    for (let j = i - n + 1; j <= i; j += 1) sum += closes[j]!;
    return Math.round((sum / n) * 100) / 100;
  });
}

/** 把 Bar[] 收成蜡烛数组。日期截前 10 位（东财港美 K 线已是 YYYY-MM-DD，腾讯也是）。 */
export function buildCandles(bars: { date: string; o: number; c: number; h: number; l: number; v: number }[]): Candle[] {
  return bars
    .filter((bar) => bar.c > 0 && bar.o > 0)
    .map((bar) => ({
      date: bar.date.slice(0, 10),
      value: [bar.o, bar.c, bar.l, bar.h] as [number, number, number, number],
      up: bar.c >= bar.o,
      volume: bar.v,
    }));
}
