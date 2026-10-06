"use strict";
/**
 * 这个文件是干什么的：
 * 腾讯行情源。拉全市场 A 股报价（分页）和几只常用指数的现价。
 *
 * 你需要知道的：
 * 这是主源，字段最全（含近 5/10/20/60 日和今年涨跌幅）。市值单位是亿元，
 * 主力净流入和成交额单位是万元，和 types.ts 里的约定一致。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeStarRow = normalizeStarRow;
exports.fetchTencentUniverse = fetchTencentUniverse;
exports.fetchTencentIndices = fetchTencentIndices;
const shared_1 = require("../providers/shared");
const HEADERS = {
    "user-agent": "Mozilla/5.0",
    referer: "https://stockapp.finance.qq.com/",
    accept: "application/json,text/plain,*/*",
};
function toQuote(raw) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _j, _k, _l;
    const id = (_a = raw.code) !== null && _a !== void 0 ? _a : "";
    if (!/^(sh|sz|bj)\d{6}$/.test(id))
        return null;
    if (id.startsWith("sh900") || id.startsWith("sz200"))
        return null;
    const name = ((_b = raw.name) === null || _b === void 0 ? void 0 : _b.trim()) || id;
    const price = (_c = (0, shared_1.num)(raw.zxj, "any")) !== null && _c !== void 0 ? _c : 0;
    return {
        id,
        code: id.slice(2),
        name,
        board: (0, shared_1.boardOf)(id, (_d = raw.stock_type) !== null && _d !== void 0 ? _d : ""),
        price,
        chg: (0, shared_1.num)(raw.zdf, "pct"),
        pe: (0, shared_1.num)(raw.pe_ttm, "ratio"),
        pb: (0, shared_1.num)(raw.pn, "ratio"),
        cap: (_e = (0, shared_1.num)(raw.zsz, "any")) !== null && _e !== void 0 ? _e : 0,
        floatCap: (_f = (0, shared_1.num)(raw.ltsz, "any")) !== null && _f !== void 0 ? _f : 0,
        turnover: (_g = (0, shared_1.num)(raw.hsl, "any")) !== null && _g !== void 0 ? _g : 0,
        volRatio: (_h = (0, shared_1.num)(raw.lb, "any")) !== null && _h !== void 0 ? _h : 0,
        amp: (_j = (0, shared_1.num)(raw.zf, "pct")) !== null && _j !== void 0 ? _j : 0,
        d5: (0, shared_1.num)(raw.zdf_d5, "pct"),
        d10: (0, shared_1.num)(raw.zdf_d10, "pct"),
        d20: (0, shared_1.num)(raw.zdf_d20, "pct"),
        d60: (0, shared_1.num)(raw.zdf_d60, "pct"),
        ytd: (0, shared_1.num)(raw.zdf_y, "pct"),
        inflow: (_k = (0, shared_1.num)(raw.zljlr, "any")) !== null && _k !== void 0 ? _k : 0,
        amount: (_l = (0, shared_1.num)(raw.turnover, "any")) !== null && _l !== void 0 ? _l : 0,
        st: (0, shared_1.isSt)(name),
    };
}
async function fetchPage(board, offset, count) {
    var _a, _b, _c, _d;
    const url = "https://proxy.finance.qq.com/cgi/cgi-bin/rank/hs/getBoardRankList" +
        `?board_code=${board}&sort_type=price&direct=down&offset=${offset}&count=${count}`;
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok)
        throw new Error(`status ${res.status}`);
    const body = (await res.json());
    const list = (_a = body.data) === null || _a === void 0 ? void 0 : _a.rank_list;
    if (!Array.isArray(list)) {
        if (((_b = body.msg) !== null && _b !== void 0 ? _b : "").includes("count"))
            throw new Error("count");
        throw new Error(body.msg || "bad payload");
    }
    return { list, total: (_d = (_c = body.data) === null || _c === void 0 ? void 0 : _c.total) !== null && _d !== void 0 ? _d : list.length };
}
async function loadBoard(board, pageSize) {
    let size = pageSize;
    let first;
    try {
        first = await fetchPage(board, 0, size);
    }
    catch (error) {
        if (error instanceof Error && error.message === "count" && size > 40) {
            size = 40;
            first = await fetchPage(board, 0, size);
        }
        else {
            throw error;
        }
    }
    const offsets = [];
    for (let offset = size; offset < first.total; offset += size)
        offsets.push(offset);
    const rest = await (0, shared_1.mapPool)(offsets, 5, async (offset) => {
        try {
            return (await fetchPage(board, offset, size)).list;
        }
        catch {
            await new Promise((resolve) => setTimeout(resolve, 280));
            return (await fetchPage(board, offset, size)).list;
        }
    });
    return first.list.concat(...rest);
}
/**
 * 科创板榜单的一行原始数据按主板的单位对齐。
 * 只有成交额要改：科创板给的是元，主板给的是万元，差一万倍。解析不了的保持原样，
 * 让 toQuote 自己按缺值处理，不要在这里塞 0。
 */
function normalizeStarRow(raw) {
    const amount = (0, shared_1.num)(raw.turnover, "any");
    return amount == null ? raw : { ...raw, turnover: String(amount / 1e4) };
}
/** 拉全市场 A 股报价。主板和科创板分两个榜单，科创板拉不到时标 partial，不拖垮整份名单。 */
async function fetchTencentUniverse() {
    const main = await loadBoard("aStock", 200);
    let partial = false;
    let star = [];
    try {
        star = await loadBoard("ksh", 40);
    }
    catch {
        partial = true;
    }
    // 科创板那个榜单的成交额单位是元，主板榜单是万元。Quote.amount 统一按万元算，
    // 不换算的话科创板会被放大一万倍：实测键凯科技 688356 接口给 860539935，
    // 通达信同一天是 860539904 元，也就是 8.6 亿、86054 万元。放大之后
    // 「突破要 8000 万、低估值要 3000 万」这两道门槛对 617 只科创板全部失效，
    // 等于只要是科创板就不看成交额了。
    // 同一批数据里总市值、主力净流入、量比、换手、市盈率市净率的单位都和主板一致，
    // 只有成交额这一个字段不一样，所以只换它。
    const starRows = star.map(normalizeStarRow);
    const byId = new Map();
    for (const raw of main.concat(starRows)) {
        const quote = toQuote(raw);
        if (!quote || byId.has(quote.id))
            continue;
        byId.set(quote.id, quote);
    }
    return { quotes: [...byId.values()], partial };
}
function parseIndices(text) {
    var _a;
    const rows = [];
    for (const line of text.split("\n")) {
        const idMatch = line.match(/^v_([a-z]{2}\d+)/);
        const body = line.match(/="([^"]*)"/);
        if (!idMatch || !body)
            continue;
        const parts = body[1].split("~");
        if (parts.length < 33)
            continue;
        const price = Number(parts[3]);
        const prev = Number(parts[4]);
        const chg = Number(parts[31]);
        if (!Number.isFinite(price))
            continue;
        const stamp = (_a = parts[30]) !== null && _a !== void 0 ? _a : "";
        const pct = prev ? (chg / prev) * 100 : Number(parts[32]);
        rows.push({
            id: idMatch[1],
            name: parts[1] || idMatch[1],
            price,
            chg: Number.isFinite(chg) ? chg : 0,
            pct: Number.isFinite(pct) ? pct : 0,
            time: stamp.length >= 12 ? `${stamp.slice(8, 10)}:${stamp.slice(10, 12)}` : "",
        });
    }
    return rows;
}
/** 拉几只常用指数和沪深300ETF 的现价。ids 是 sh、sz 加六位代码。 */
async function fetchTencentIndices(ids) {
    const url = `https://web.sqt.gtimg.cn/utf8/q=${ids.join(",")}`;
    const res = await fetch(url, {
        headers: { ...HEADERS, referer: "https://gu.qq.com/" },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok)
        throw new Error(`status ${res.status}`);
    const rows = parseIndices(await res.text());
    if (rows.length === 0)
        throw new Error("index empty");
    return rows;
}
