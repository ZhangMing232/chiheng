"use strict";
/**
 * 这个文件是干什么的：
 * 负责偏好。选哪套策略、看哪个板块、股价和市值落在哪一档。
 *
 * 你需要知道的：
 * 股价单位是元。市值单位是亿：小盘小于 100 亿，中盘 100 到 500 亿，大盘大于 500 亿。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_PREFS = void 0;
exports.parsePrefs = parsePrefs;
exports.matchPrefs = matchPrefs;
exports.DEFAULT_PREFS = { style: "early", board: "all", price: "all", cap: "all" };
const STYLES = ["early", "trend", "breakout", "value", "relay", "rebound"];
/** 把前端传来的未知数据收成偏好。缺的字段用默认。某项写了但不在允许值里，返回 null。 */
function parsePrefs(data) {
    if (typeof data !== "object" || data === null)
        return null;
    const raw = data;
    const next = { ...exports.DEFAULT_PREFS };
    if (raw.style == null)
        next.style = "early";
    else if (STYLES.includes(raw.style))
        next.style = raw.style;
    else
        return null;
    if (raw.board === "all" || raw.board === "main" || raw.board === "cyb" || raw.board === "kcb")
        next.board = raw.board;
    else if (raw.board != null)
        return null;
    if (raw.price === "all" || raw.price === "low" || raw.price === "mid" || raw.price === "high")
        next.price = raw.price;
    else if (raw.price != null)
        return null;
    if (raw.cap === "all" || raw.cap === "small" || raw.cap === "mid" || raw.cap === "large")
        next.cap = raw.cap;
    else if (raw.cap != null)
        return null;
    return next;
}
/** 这只股票是否符合偏好。符合返回 true。低价小于 10 元，中价 10 到 30 元，高价大于 30 元。市值单位是亿。 */
function matchPrefs(quote, prefs) {
    if (prefs.board === "main" && quote.board !== "sh" && quote.board !== "sz")
        return false;
    if (prefs.board === "cyb" && quote.board !== "cyb")
        return false;
    if (prefs.board === "kcb" && quote.board !== "kcb")
        return false;
    if (prefs.price === "low" && !(quote.price < 10))
        return false;
    if (prefs.price === "mid" && !(quote.price >= 10 && quote.price <= 30))
        return false;
    if (prefs.price === "high" && !(quote.price > 30))
        return false;
    if (prefs.cap === "small" && !(quote.cap < 100))
        return false;
    if (prefs.cap === "mid" && !(quote.cap >= 100 && quote.cap <= 500))
        return false;
    if (prefs.cap === "large" && !(quote.cap > 500))
        return false;
    return true;
}
