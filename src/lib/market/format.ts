/**
 * 这个文件是干什么的：
 * 把行情数字收成页面上的文字：涨跌幅、价格、市值、资金。
 *
 * 你需要知道的：
 * 正数是涨（红），负数是跌（绿）。资金按万元进，市值按亿元进。无效或没有就显示「—」。
 */

/** 按涨跌给样式类名。正数 text-up（红涨），负数 text-down（绿跌），零或没有是灰色 text-muted。 */
export function toneClass(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n === 0) return "text-muted";
  return n > 0 ? "text-up" : "text-down";
}

/** 把涨跌幅收成带正负号的百分数，例如 +1.23%。digits 是小数位，默认 2。没有数字就返回「—」。 */
export function signedPct(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const body = Math.abs(n).toFixed(digits);
  if (n > 0) return `+${body}%`;
  if (n < 0) return `-${body}%`;
  return `${body}%`;
}

/** 把价格收成两位小数。不是正数就返回「—」。 */
export function fmtPrice(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n.toFixed(2);
}

/** 把市值收成文字。传入单位是亿元。一万亿以上写成「万亿」，一百亿以上取整写成「亿」。 */
export function fmtCap(yi: number): string {
  if (!Number.isFinite(yi) || yi <= 0) return "—";
  if (yi >= 10000) return `${(yi / 10000).toFixed(2)}万亿`;
  if (yi >= 100) return `${Math.round(yi)}亿`;
  return `${yi.toFixed(1)}亿`;
}

/** 把资金收成文字。传入单位是万元。满一亿写成「亿」，满一百万元取整写成「万」。hideZero 为 true 时，0 也显示「—」。 */
export function fmtWan(wan: number, hideZero = false): string {
  if (!Number.isFinite(wan) || (hideZero && wan === 0)) return "—";
  const sign = wan < 0 ? "-" : "";
  const abs = Math.abs(wan);
  if (abs >= 10000) return `${sign}${(abs / 10000).toFixed(2)}亿`;
  if (abs >= 100) return `${sign}${Math.round(abs)}万`;
  return `${sign}${abs.toFixed(1)}万`;
}

/** 普通数字，保留 digits 位小数，默认 2。没有数字，或 hideZero 且为 0 时，返回「—」。 */
export function fmtPlain(n: number | null | undefined, digits = 2, hideZero = false): string {
  if (n == null || !Number.isFinite(n) || (hideZero && n === 0)) return "—";
  return n.toFixed(digits);
}

/** 市盈率、市净率这类倍数。绝对值超过 5000 视为无效，返回「—」。一百以上不留小数。 */
export function fmtMultiple(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || Math.abs(n) > 5000) return "—";
  return n.toFixed(n >= 100 ? 0 : 1);
}
