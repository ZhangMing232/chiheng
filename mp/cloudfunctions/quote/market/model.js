"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BOARD_LABEL = exports.TRACK_NEED = exports.HOLD_SESSIONS = void 0;
exports.planExit = planExit;
exports.limitPct = limitPct;
exports.boardLimit = boardLimit;
exports.limitTag = limitTag;
exports.isIdleBook = isIdleBook;
exports.screen = screen;
const rules_1 = require("./rules");
/** 启动前期的卖出检查最多这么多个交易日。落在 5 到 10 天里。20 日只用来判断走没走远，不是持股天数。 */
exports.HOLD_SESSIONS = 8;
/** 样本要满这么多交易日，上涨占比才不算太短。不是持股天数。 */
exports.TRACK_NEED = 60;
function round2(n) {
    return Math.round(n * 100) / 100;
}
/**
 * 止损和止盈都从这套策略的区间来，不另写固定百分比。
 * 止损：把策略允许的当日启动幅度跌回去，启动就不成立。
 * 止盈：20 日涨幅碰到策略上限，就不再是「还没走远」。不知道当时的 20 日涨幅时，用整段区间。
 * 止盈至少不小于止损幅度，避免目标价落在止损价里面。
 */
function planExit(entry, d20, rules = rules_1.DEFAULT_RULES) {
    const stopPct = Math.max(rules.chgMax, 0.5) / 100;
    const room = d20 == null ? rules.d20Max - rules.d20Min : rules.d20Max - d20;
    const targetPct = Math.max(room, rules.chgMax) / 100;
    return {
        stop: round2(entry * (1 - stopPct)),
        target: round2(entry * (1 + targetPct)),
    };
}
exports.BOARD_LABEL = {
    sh: "沪市",
    sz: "深市",
    cyb: "创业",
    kcb: "科创",
    bj: "北证",
};
function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
}
/** 按股票代码和名字给出涨跌停百分比。10 表示 10%，不是 0.1。 */
function limitPct(quote) {
    return boardLimit(quote.id, quote.name);
}
/** 不看行情、只看代码和名字，算出涨跌停百分比。给还没有 Quote 的地方用。 */
function boardLimit(id, name) {
    if (name.toUpperCase().includes("ST") || name.includes("退"))
        return 5;
    // sh689 是科创板存托凭证（实测只有九号公司 689009），同样 20%。
    // boardOf 已经把它归到 kcb，这里漏掉会出现「板块是科创、涨跌停按 10%」的错位。
    if (id.startsWith("sh688") || id.startsWith("sh689") || id.startsWith("sz300") || id.startsWith("sz301"))
        return 20;
    if (id.startsWith("bj"))
        return 30;
    return 10;
}
/** 现价已经贴到涨停或跌停就标出来。留了 0.15 个百分点的缝，避免四舍五入把涨停漏掉。 */
function limitTag(quote) {
    if (quote.chg == null)
        return null;
    const limit = limitPct(quote);
    if (quote.chg >= limit - 0.15)
        return "涨停";
    if (quote.chg <= -limit + 0.15)
        return "跌停";
    return null;
}
/** 几乎没有成交时，量比和成交额没有意义。 */
function isIdleBook(quotes) {
    if (quotes.length === 0)
        return true;
    let live = 0;
    for (const quote of quotes) {
        if (quote.amount > 0 || quote.turnover > 0)
            live += 1;
    }
    return live / quotes.length < 0.08;
}
function notSealedUp(quote) {
    if (quote.chg == null)
        return true;
    return quote.chg < limitPct(quote) - 0.3;
}
function notSealedDown(quote) {
    if (quote.chg == null)
        return true;
    return quote.chg > -limitPct(quote) + 0.3;
}
function pct(n) {
    if (n == null || !Number.isFinite(n))
        return "—";
    const body = `${Math.abs(n).toFixed(1)}%`;
    if (n > 0)
        return `+${body}`;
    if (n < 0)
        return `-${body}`;
    return body;
}
/**
 * 启动前期：刚转强、20 日还没走远。条件收窄是为了少追、少接飞刀，不是为了把历史涨幅调到最好看。
 * 涨跌停和 ST 直接排除。门槛来自 rules，改规则会换版本。
 * 卖出看 planExit：跌回当日允许的启动幅度就止损，20 日涨到策略上限就止盈，否则最多 8 个交易日收盘卖。
 */
function screen(quote, live, rules = rules_1.DEFAULT_RULES) {
    if (!live || quote.st || quote.price < 4 || quote.cap < 40)
        return null;
    if (quote.chg == null || quote.d5 == null || quote.d20 == null || quote.d60 == null)
        return null;
    if (!notSealedUp(quote) || !notSealedDown(quote))
        return null;
    if (quote.chg < rules.chgMin || quote.chg > rules.chgMax)
        return null;
    if (quote.d5 < rules.d5Min || quote.d5 > rules.d5Max)
        return null;
    if (quote.d20 < rules.d20Min || quote.d20 > rules.d20Max)
        return null;
    if (quote.d60 < rules.d60Min || quote.d60 > rules.d60Max)
        return null;
    if (quote.volRatio < rules.volMin || quote.volRatio > rules.volMax)
        return null;
    if (quote.turnover < rules.turnMin || quote.turnover > rules.turnMax)
        return null;
    if (quote.amount < rules.amountMin)
        return null;
    const span20 = Math.max(1, rules.d20Max - rules.d20Min);
    const span5 = Math.max(1, rules.d5Max - rules.d5Min);
    const spanChg = Math.max(0.5, rules.chgMax - rules.chgMin);
    const parts = [
        { t: `20 日 ${pct(quote.d20)}，还没走远`, p: clamp(((rules.d20Max - quote.d20) / span20) * 40, 0, 40) },
        { t: `5 日 ${pct(quote.d5)}，刚转强`, p: clamp(((rules.d5Max - quote.d5) / span5) * 30, 0, 30) },
        { t: `量比 ${quote.volRatio.toFixed(2)}`, p: quote.volRatio <= (rules.volMin + rules.volMax) / 2 ? 20 : 10 },
        { t: `今日 ${pct(quote.chg)}`, p: clamp(((rules.chgMax - quote.chg) / spanChg) * 10, 0, 10) },
    ];
    const score = Math.round(clamp(parts.reduce((sum, part) => sum + part.p, 0), 0, 100));
    const reasons = parts
        .filter((part) => part.p > 0)
        .sort((a, b) => b.p - a.p)
        .slice(0, 3)
        .map((part) => part.t);
    return { score, reasons };
}
