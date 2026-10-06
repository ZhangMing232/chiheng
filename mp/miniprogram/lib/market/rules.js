"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_RULES = void 0;
exports.parseRules = parseRules;
exports.sameSelection = sameSelection;
exports.DEFAULT_RULES = {
    version: 1,
    chgMin: 1,
    chgMax: 4.5,
    d5Min: 0,
    d5Max: 8,
    d20Min: -3,
    d20Max: 12,
    d60Min: -10,
    d60Max: 25,
    volMin: 1.2,
    volMax: 2.8,
    turnMin: 1.5,
    turnMax: 12,
    amountMin: 5000,
    minDays: 60,
    minClosed: 20,
    maxDrawdownPct: 8,
    maxLosingStreak: 3,
};
const KEYS = [
    "chgMin",
    "chgMax",
    "d5Min",
    "d5Max",
    "d20Min",
    "d20Max",
    "d60Min",
    "d60Max",
    "volMin",
    "volMax",
    "turnMin",
    "turnMax",
    "amountMin",
    "minDays",
    "minClosed",
    "maxDrawdownPct",
    "maxLosingStreak",
];
function num(value) {
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    return Number.isFinite(n) ? n : null;
}
/** 从网页保存的 JSON 里读规则。缺字段或数字不合法就返回空，调用方继续用旧的。 */
function parseRules(data) {
    if (typeof data !== "object" || data === null)
        return null;
    const raw = data;
    const next = { ...exports.DEFAULT_RULES, version: 1 };
    for (const key of KEYS) {
        const value = num(raw[key]);
        if (value == null) {
            if (key === "maxDrawdownPct" || key === "maxLosingStreak")
                continue;
            return null;
        }
        next[key] = value;
    }
    if (!(next.chgMin < next.chgMax))
        return null;
    if (!(next.d5Min < next.d5Max))
        return null;
    if (!(next.d20Min < next.d20Max))
        return null;
    if (!(next.d60Min < next.d60Max))
        return null;
    if (!(next.volMin < next.volMax))
        return null;
    if (!(next.turnMin < next.turnMax))
        return null;
    if (!(next.amountMin > 0) || next.minDays < 0 || next.minClosed < 0)
        return null;
    if (next.maxDrawdownPct < 0 || next.maxDrawdownPct > 100)
        return null;
    if (next.maxLosingStreak < 0 || next.maxLosingStreak > 20)
        return null;
    return next;
}
/** 两套门槛的选股数字是否一样。版本号不算，用来判断要不要把旧样本标成另一版。 */
function sameSelection(a, b) {
    return (a.chgMin === b.chgMin &&
        a.chgMax === b.chgMax &&
        a.d5Min === b.d5Min &&
        a.d5Max === b.d5Max &&
        a.d20Min === b.d20Min &&
        a.d20Max === b.d20Max &&
        a.d60Min === b.d60Min &&
        a.d60Max === b.d60Max &&
        a.volMin === b.volMin &&
        a.volMax === b.volMax &&
        a.turnMin === b.turnMin &&
        a.turnMax === b.turnMax &&
        a.amountMin === b.amountMin);
}
