"use strict";
/**
 * 这个文件是干什么的：
 * 把行情数字收成页面上的文字：涨跌幅、价格、市值、资金。
 *
 * 你需要知道的：
 * 正数是涨（红），负数是跌（绿）。资金按万元进，市值按亿元进。无效或没有就显示「—」。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.toneClass = toneClass;
exports.signedPct = signedPct;
exports.fmtPrice = fmtPrice;
exports.fmtCap = fmtCap;
exports.fmtWan = fmtWan;
exports.fmtPlain = fmtPlain;
exports.fmtMultiple = fmtMultiple;
exports.snapshotAge = snapshotAge;
exports.fmtMoney = fmtMoney;
/** 按涨跌给样式类名。正数 text-up（红涨），负数 text-down（绿跌），零或没有是灰色 text-muted。 */
function toneClass(n) {
    if (n == null || !Number.isFinite(n) || n === 0)
        return "text-muted";
    return n > 0 ? "text-up" : "text-down";
}
/** 把涨跌幅收成带正负号的百分数，例如 +1.23%。digits 是小数位，默认 2。没有数字就返回「—」。 */
function signedPct(n, digits = 2) {
    if (n == null || !Number.isFinite(n))
        return "—";
    const body = Math.abs(n).toFixed(digits);
    if (n > 0)
        return `+${body}%`;
    if (n < 0)
        return `-${body}%`;
    return `${body}%`;
}
/** 把价格收成两位小数。不是正数就返回「—」。 */
function fmtPrice(n) {
    if (!Number.isFinite(n) || n <= 0)
        return "—";
    return n.toFixed(2);
}
/** 把市值收成文字。传入单位是亿元。一万亿以上写成「万亿」，一百亿以上取整写成「亿」。 */
function fmtCap(yi) {
    if (!Number.isFinite(yi) || yi <= 0)
        return "—";
    if (yi >= 10000)
        return `${(yi / 10000).toFixed(2)}万亿`;
    if (yi >= 100)
        return `${Math.round(yi)}亿`;
    return `${yi.toFixed(1)}亿`;
}
/** 把资金收成文字。传入单位是万元。满一亿写成「亿」，满一百万元取整写成「万」。hideZero 为 true 时，0 也显示「—」。 */
function fmtWan(wan, hideZero = false) {
    if (!Number.isFinite(wan) || (hideZero && wan === 0))
        return "—";
    const sign = wan < 0 ? "-" : "";
    const abs = Math.abs(wan);
    if (abs >= 10000)
        return `${sign}${(abs / 10000).toFixed(2)}亿`;
    if (abs >= 100)
        return `${sign}${Math.round(abs)}万`;
    return `${sign}${abs.toFixed(1)}万`;
}
/** 普通数字，保留 digits 位小数，默认 2。没有数字，或 hideZero 且为 0 时，返回「—」。 */
function fmtPlain(n, digits = 2, hideZero = false) {
    if (n == null || !Number.isFinite(n) || (hideZero && n === 0))
        return "—";
    return n.toFixed(digits);
}
/** 市盈率、市净率这类倍数。绝对值超过 5000 视为无效，返回「—」。一百以上不留小数。 */
function fmtMultiple(n) {
    if (n == null || !Number.isFinite(n) || Math.abs(n) > 5000)
        return "—";
    return n.toFixed(n >= 100 ? 0 : 1);
}
/**
 * 把「快照多久前」说成人话：刚刚 / 30 秒前 / 3 分钟前 / 2 小时前。
 * 差值是负数（系统时间往回跳）时按「刚刚」算，不能说出「-5 秒前」。
 */
function snapshotAge(ms) {
    const sec = Math.max(0, Math.round(ms / 1000));
    if (sec < 10)
        return "刚刚";
    if (sec < 60)
        return `${sec} 秒前`;
    const min = Math.round(sec / 60);
    if (min < 60)
        return `${min} 分钟前`;
    return `${Math.round(min / 60)} 小时前`;
}
/**
 * 金额（元）。带千分位，超过一万时缩写成「万」，中文盯盘习惯。
 * 超过一亿缩写成「亿」。小数位给的是「万元」口径下的两位——调用方自己决定传什么。
 */
function fmtMoney(value) {
    if (value == null || !Number.isFinite(value))
        return "—";
    const abs = Math.abs(value);
    if (abs >= 1e8)
        return `${(value / 1e8).toFixed(2)} 亿`;
    if (abs >= 1e4)
        return `${(value / 1e4).toFixed(2)} 万`;
    return value.toLocaleString("zh-CN", { maximumFractionDigits: 2 });
}
