/**
 * 短线形态识别：只用「当天的开高低收 + 昨收」，从日线里把打板圈常说的形态认出来。
 *
 * 为什么值得单独一个文件：这些标签以前散在一次性 python 脚本里，口径改一次就对不上，
 * 也没人钉住「不许看未来」。这里纯函数、零 IO、客户端可达，测试直接 import 真算一遍。
 *
 * 能认出来的（用 h/o/c/l 四个价 + 昨收就够）：
 *   炸板    盘中触到涨停价，收盘没封住
 *   换手板  盘中触板且收盘封住，但开盘不在涨停价（含回封）
 *   一字板  开盘就在涨停价，全天最低也没下来
 *   T字板   开盘涨停、盘中打开、收盘又封回
 *   地天板  盘中砸到跌停附近，收盘封涨停
 *   弱转强  低开（低于昨收）却收在涨停
 *
 * 认不出来的（日线没有，别拿日线假装测出来）：封单金额、排队能不能成交、
 * 逐笔主动买卖方向、竞价匹配量明细。这四样要分时/逐笔数据，缺就是缺。
 *
 * 注意：一张 K 线可以同时命中多个标签（低开拉板既是换手板也是弱转强）。
 * 多标签是有意的——统计时按标签分别计入，别当成互斥分类。
 */

export type ShortForm = "炸板" | "换手板" | "一字板" | "T字板" | "地天板" | "弱转强";

export const SHORT_FORMS: ShortForm[] = ["炸板", "换手板", "一字板", "T字板", "地天板", "弱转强"];

export type DayBar = { date: string; o: number; h: number; l: number; c: number };

/** 触板容差：价格取整、一字板、不同源的复权尾差都会让「等于涨停价」差几分钱。 */
const TOUCH = 0.998;

/** 涨跌停幅度。code 是 sh600519 / sz300750 / bj430047 这种带市场前缀的 id。 */
export function boardLimitPct(code: string, isST = false): number {
  if (isST) return 5;
  if (/^(sh688|sz30)/.test(code)) return 20;
  if (/^(bj|sh8|sz4)/.test(code)) return 30;
  return 10;
}

/**
 * 认形态。prevClose 必须是**上一根已走完的 K 线**的收盘价；bar 本身必须是已收盘的日线。
 * 没走完的当日 K 线不参与判定（A 股铁律：这一分钟不知道下一分钟）。
 * 数据不全直接返回空数组——不猜、不补 0、不拿 0 当「没涨停」。
 */
export function classifyForms(bar: DayBar, prevClose: number, code: string, isST = false): ShortForm[] {
  if (!(prevClose > 0)) return [];
  if (![bar.o, bar.h, bar.l, bar.c].every((x) => Number.isFinite(x) && x > 0)) return [];
  const lim = boardLimitPct(code, isST);
  const up = +(prevClose * (1 + lim / 100)).toFixed(2);
  const dn = +(prevClose * (1 - lim / 100)).toFixed(2);
  const touched = bar.h >= up * TOUCH;
  const closed = bar.c >= up * TOUCH;
  const openedAtLimit = bar.o >= up * TOUCH;

  const forms: ShortForm[] = [];
  if (touched && !closed) forms.push("炸板");
  if (touched && closed && !openedAtLimit) forms.push("换手板");
  if (openedAtLimit && bar.l >= up * TOUCH) forms.push("一字板");
  if (openedAtLimit && bar.l < up * TOUCH && closed) forms.push("T字板");
  if (bar.l <= dn * 1.002 && closed) forms.push("地天板");
  if (!openedAtLimit && bar.o < prevClose && closed) forms.push("弱转强");
  return forms;
}

export type FormOutcome = { fillable: boolean; r1: number | null; r2: number | null };

/**
 * 事后结算口径：T 日出现形态 → T+1 挂 T 日收盘价限价买。
 * 次日开盘价高于挂单价 = 买不到，不计入收益（这是打板研究最容易骗自己的地方：
 * 看着涨的那部分恰好是买不到的）。拿不到后续 K 线返回 null，不是 0。
 *
 * 这是**事后描述统计**，不是可成交价、不是策略收益、没扣费、没减基准。
 */
export function settleForm(
  close: number,
  next: [{ o: number; c: number }, { o: number; c: number }] | null,
): FormOutcome {
  if (!(close > 0) || !next || next.length < 2) return { fillable: false, r1: null, r2: null };
  const [d1, d2] = next;
  if (![d1.o, d1.c, d2.c].every((x) => Number.isFinite(x) && x > 0)) {
    return { fillable: false, r1: null, r2: null };
  }
  if (d1.o > close) return { fillable: false, r1: null, r2: null };
  return {
    fillable: true,
    r1: (d1.c / close - 1) * 100,
    r2: (d2.c / close - 1) * 100,
  };
}
