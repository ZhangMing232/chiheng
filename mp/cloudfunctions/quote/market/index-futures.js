"use strict";
/**
 * 这个文件是干什么的：
 * 负责期指这块。从中金所拉沪深300、上证50、中证500、中证1000 的会员持仓。
 *
 * 你需要知道的：
 * 单位是手。公布的是代客，不是机构专户。大约五分钟更新一次，当天没有就往前找。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadIndexFutures = loadIndexFutures;
const session_1 = require("./session");
const PRODUCTS = [
    { code: "IF", name: "沪深300" },
    { code: "IH", name: "上证50" },
    { code: "IC", name: "中证500" },
    { code: "IM", name: "中证1000" },
];
const TTL_MS = 5 * 60000;
let cache = null;
function ymd(date) {
    // 不用 replaceAll：那是 ES2021 的方法，老一点的 iOS JSCore 上没有，
    // 小程序跑在别人的引擎里，别赌。split/join 的语义一样，哪儿都能跑。
    return date.split("-").join("");
}
function shift(date, days) {
    const [y, m, d] = date.split("-").map(Number);
    const next = new Date(Date.UTC(y, m - 1, d));
    next.setUTCDate(next.getUTCDate() + days);
    return next.toISOString().slice(0, 10);
}
async function csv(product, date) {
    const stamp = ymd(date);
    const url = `http://www.cffex.com.cn/sj/ccpm/${stamp.slice(0, 6)}/${stamp.slice(6)}/${product}_1.csv`;
    const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(12000) });
    if (!res.ok)
        return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    const text = new TextDecoder("gbk").decode(buf);
    return text.includes(stamp) ? text : null;
}
function members(text, contract, side) {
    var _a, _b;
    const nameAt = side === "long" ? 6 : 9;
    const lotsAt = side === "long" ? 7 : 10;
    const chgAt = side === "long" ? 8 : 11;
    const rows = [];
    for (const line of text.split(/\r?\n/)) {
        const cell = line.split(",");
        if (cell[1] !== contract || !/^\d+$/.test((_a = cell[2]) !== null && _a !== void 0 ? _a : ""))
            continue;
        const lots = Number(cell[lotsAt]);
        const chg = Number(cell[chgAt]);
        const name = ((_b = cell[nameAt]) !== null && _b !== void 0 ? _b : "").replace("(代客)", "").trim();
        if (!name || !Number.isFinite(lots))
            continue;
        rows.push({ name, lots, chg: Number.isFinite(chg) ? chg : 0 });
    }
    return rows.sort((a, b) => b.lots - a.lots);
}
function mainContract(text) {
    var _a, _b, _c, _d, _e;
    const score = new Map();
    for (const line of text.split(/\r?\n/)) {
        const cell = line.split(",");
        if (!/^\d+$/.test((_a = cell[2]) !== null && _a !== void 0 ? _a : ""))
            continue;
        const contract = (_b = cell[1]) !== null && _b !== void 0 ? _b : "";
        const longLots = Number(cell[7]);
        const shortLots = Number(cell[10]);
        score.set(contract, ((_c = score.get(contract)) !== null && _c !== void 0 ? _c : 0) + (Number.isFinite(longLots) ? longLots : 0) + (Number.isFinite(shortLots) ? shortLots : 0));
    }
    return (_e = (_d = [...score.entries()].sort((a, b) => b[1] - a[1])[0]) === null || _d === void 0 ? void 0 : _d[0]) !== null && _e !== void 0 ? _e : "";
}
/** 中金所公布的股指期货会员多空单。文件写明是代客，不是单独的机构账户。 */
async function loadIndexFutures() {
    if (cache && Date.now() - cache.at < TTL_MS)
        return cache.book;
    let date = (0, session_1.shanghaiDate)();
    let found = "";
    for (let i = 0; i < 6 && !found; i += 1) {
        const text = await csv("IF", date);
        if (text)
            found = date;
        else
            date = shift(date, -1);
    }
    if (!found)
        return { date: "", rows: [] };
    const rows = [];
    for (const product of PRODUCTS) {
        const text = product.code === "IF" ? await csv("IF", found) : await csv(product.code, found);
        if (!text)
            continue;
        const contract = mainContract(text);
        if (!contract)
            continue;
        const longTop = members(text, contract, "long");
        const shortTop = members(text, contract, "short");
        rows.push({
            name: product.name,
            contract,
            longLots: longTop.reduce((sum, row) => sum + row.lots, 0),
            shortLots: shortTop.reduce((sum, row) => sum + row.lots, 0),
            longTop: longTop.slice(0, 3),
            shortTop: shortTop.slice(0, 3),
        });
    }
    const book = { date: found, rows };
    cache = { at: Date.now(), book };
    return book;
}
