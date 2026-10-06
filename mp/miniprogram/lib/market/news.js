"use strict";
/**
 * 这个文件是干什么的：
 * 负责消息这块。拉 7x24 快讯，也能按股票查最近的资讯和公告。
 *
 * 你需要知道的：
 * 利好、利空只看标题里的用词，不是研报。涨跌幅是百分数，正涨负跌。大约一分钟更新一次。
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.loadNews = loadNews;
exports.searchStocks = searchStocks;
exports.loadStockArticles = loadStockArticles;
exports.stockChg = stockChg;
const node_https_1 = __importDefault(require("node:https"));
const TTL_MS = 60000;
const GOOD = ["利好", "中标", "签约", "回购", "增持", "预增", "扭亏", "获批", "核准", "大涨", "涨停", "涨超", "上调", "订单", "创新高", "拉升", "走强", "放量"];
const BAD = ["利空", "减持", "预亏", "亏损", "下滑", "处罚", "立案", "退市", "跌停", "大跌", "跌超", "下调", "违规", "调查", "终止", "跳水", "下挫", "走弱", "问询"];
let cache = null;
const boardNames = new Map();
function getText(url, referer = "https://kuaixun.eastmoney.com/") {
    return new Promise((resolve, reject) => {
        const req = node_https_1.default.get(url, { headers: { "user-agent": "Mozilla/5.0", referer }, timeout: 12000 }, (res) => {
            const chunks = [];
            res.on("data", (chunk) => chunks.push(chunk));
            res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        });
        req.on("timeout", () => req.destroy(new Error("消息超时")));
        req.on("error", reject);
    });
}
function stockId(token) {
    const [market, code] = token.split(".");
    if (!/^\d{6}$/.test(code !== null && code !== void 0 ? code : ""))
        return null;
    if (market === "1")
        return `sh${code}`;
    if (market === "0") {
        if (code.startsWith("8") || code.startsWith("4") || code.startsWith("92"))
            return `bj${code}`;
        return `sz${code}`;
    }
    return null;
}
function boardCode(token) {
    const [market, code] = token.split(".");
    if (market === "90" && /^BK\d{4}$/.test(code !== null && code !== void 0 ? code : ""))
        return code;
    return null;
}
function toneOf(text) {
    const good = GOOD.filter((word) => text.includes(word)).length;
    const bad = BAD.filter((word) => text.includes(word)).length;
    if (good > bad)
        return "good";
    if (bad > good)
        return "bad";
    return "flat";
}
async function boardName(code) {
    var _a, _b, _c;
    const saved = boardNames.get(code);
    if (saved)
        return saved;
    try {
        const raw = await getText(`https://search-codetable.eastmoney.com/codetable/search?keyword=${code}&count=5`);
        const parsed = JSON.parse(raw);
        const name = ((_c = (_b = (_a = parsed.result) === null || _a === void 0 ? void 0 : _a.find((row) => row.code === code)) === null || _b === void 0 ? void 0 : _b.shortName) === null || _c === void 0 ? void 0 : _c.trim()) || code;
        boardNames.set(code, name);
        return name;
    }
    catch {
        return code;
    }
}
async function namesOf(ids) {
    var _a;
    const out = new Map();
    if (ids.length === 0)
        return out;
    const text = await getText(`https://web.sqt.gtimg.cn/utf8/q=${ids.join(",")}`);
    for (const line of text.split(";")) {
        const match = line.match(/_([a-z]{2}\d{6})="(.*)"/);
        if (!match)
            continue;
        const parts = match[2].split("~");
        const name = (_a = parts[1]) === null || _a === void 0 ? void 0 : _a.trim();
        const chg = Number(parts[32]);
        if (name)
            out.set(match[1], { name, chg: Number.isFinite(chg) ? chg : null });
    }
    return out;
}
/** 东方财富 7x24。板块和个股分开，用词分成利好、利空或没说清。 */
async function loadNews() {
    var _a, _b;
    if (cache && Date.now() - cache.at < TTL_MS)
        return cache.rows;
    const raw = await getText("https://np-weblist.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=40&req_trace=1");
    const parsed = JSON.parse(raw);
    const list = (_b = (_a = parsed.data) === null || _a === void 0 ? void 0 : _a.fastNewsList) !== null && _b !== void 0 ? _b : [];
    const ids = new Set();
    const boards = new Set();
    const drafts = list.map((item) => {
        var _a, _b, _c, _d, _e, _f, _g;
        const stockIds = [...new Set(((_a = item.stockList) !== null && _a !== void 0 ? _a : []).map(stockId).filter((id) => id != null))];
        const boardCodes = [...new Set(((_b = item.stockList) !== null && _b !== void 0 ? _b : []).map(boardCode).filter((code) => code != null))];
        for (const id of stockIds)
            ids.add(id);
        for (const code of boardCodes)
            boards.add(code);
        const title = ((_c = item.title) !== null && _c !== void 0 ? _c : "").trim();
        const summary = ((_d = item.summary) !== null && _d !== void 0 ? _d : "").trim();
        return {
            id: String((_f = (_e = item.code) !== null && _e !== void 0 ? _e : item.showTime) !== null && _f !== void 0 ? _f : title),
            time: (_g = item.showTime) !== null && _g !== void 0 ? _g : "",
            title,
            summary,
            tone: toneOf(`${title} ${summary}`),
            stockIds,
            boardCodes,
        };
    });
    const [names, boardLabels] = await Promise.all([
        namesOf([...ids]).catch(() => new Map()),
        Promise.all([...boards].map(async (code) => [code, await boardName(code)])),
    ]);
    const boardByCode = new Map(boardLabels);
    const rows = drafts
        .filter((item) => item.title || item.summary)
        .map((item) => ({
        id: item.id,
        time: item.time,
        title: item.title || item.summary.slice(0, 40),
        summary: item.summary,
        tone: item.tone,
        boards: item.boardCodes.map((code) => ({ code, name: boardByCode.get(code) || code })),
        stocks: item.stockIds.map((id) => {
            var _a;
            const live = names.get(id);
            return { id, code: id.slice(2), name: (live === null || live === void 0 ? void 0 : live.name) || id.slice(2), chg: (_a = live === null || live === void 0 ? void 0 : live.chg) !== null && _a !== void 0 ? _a : null };
        }),
    }));
    cache = { at: Date.now(), rows };
    return rows;
}
const QUOTE_REFERER = "https://quote.eastmoney.com/";
const stockCache = new Map();
function emMarketCode(id) {
    const match = id.match(/^(sh|sz|bj)(\d{6})$/);
    if (!match)
        return null;
    return `${match[1] === "sh" ? "1" : "0"}.${match[2]}`;
}
/** 按代码或名称找 A 股。 */
async function searchStocks(keyword) {
    var _a, _b, _c, _d, _e, _f;
    const q = keyword.trim().slice(0, 20);
    if (!q)
        return [];
    const raw = await getText(`https://searchapi.eastmoney.com/api/suggest/get?input=${encodeURIComponent(q)}&type=14&count=8`, QUOTE_REFERER);
    const parsed = JSON.parse(raw);
    const rows = [];
    for (const row of (_b = (_a = parsed.QuotationCodeTable) === null || _a === void 0 ? void 0 : _a.Data) !== null && _b !== void 0 ? _b : []) {
        if (row.Classify && row.Classify !== "AStock")
            continue;
        const code = (_c = row.Code) !== null && _c !== void 0 ? _c : "";
        const quoteId = (_d = row.QuoteID) !== null && _d !== void 0 ? _d : "";
        if (!/^\d{6}$/.test(code) || !/^[01]\.\d{6}$/.test(quoteId))
            continue;
        const market = quoteId.startsWith("1.") ? "sh" : code.startsWith("8") || code.startsWith("4") || code.startsWith("92") ? "bj" : "sz";
        rows.push({ id: `${market}${code}`, code, name: ((_e = row.Name) !== null && _e !== void 0 ? _e : code).trim(), board: (_f = row.SecurityTypeName) !== null && _f !== void 0 ? _f : "" });
    }
    return rows;
}
/** 一只股票最近的资讯和公告。标题用词分成利好、利空或没说清。 */
async function loadStockArticles(id) {
    const hit = stockCache.get(id);
    if (hit && Date.now() - hit.at < TTL_MS)
        return hit.rows;
    const code = emMarketCode(id);
    if (!code)
        return [];
    const [news, anns] = await Promise.all([loadHeadlines(code), loadAnnouncements(id.slice(2))]);
    const seen = new Set();
    const rows = [...news, ...anns]
        .filter((item) => {
        if (seen.has(item.title))
            return false;
        seen.add(item.title);
        return true;
    })
        .sort((a, b) => b.time.localeCompare(a.time));
    stockCache.set(id, { at: Date.now(), rows });
    return rows;
}
/** 批量查涨跌幅。传入带市场前缀的代码，返回代码到涨跌幅（百分数）的对照，查不到是 null。 */
async function stockChg(ids) {
    const names = await namesOf(ids).catch(() => new Map());
    return new Map(ids.map((id) => { var _a, _b; return [id, (_b = (_a = names.get(id)) === null || _a === void 0 ? void 0 : _a.chg) !== null && _b !== void 0 ? _b : null]; }));
}
function clock(value) {
    const match = value.match(/(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    return match ? `${match[1]} ${match[2]}` : value.slice(0, 16);
}
async function loadHeadlines(code) {
    var _a, _b;
    const raw = await getText(`https://np-listapi.eastmoney.com/comm/web/getListInfo?client=web&biz=web_news&mTypeAndCode=${code}&page_index=1&page_size=15&type=1&req_trace=1`, QUOTE_REFERER);
    const parsed = JSON.parse(raw);
    return ((_b = (_a = parsed.data) === null || _a === void 0 ? void 0 : _a.list) !== null && _b !== void 0 ? _b : []).flatMap((item) => {
        var _a, _b, _c, _d;
        const title = ((_a = item.Art_Title) !== null && _a !== void 0 ? _a : "").trim();
        if (!title)
            return [];
        const url = (_b = item.Art_OriginUrl) !== null && _b !== void 0 ? _b : "";
        return [
            {
                id: String((_c = item.Art_Code) !== null && _c !== void 0 ? _c : title),
                time: clock((_d = item.Art_ShowTime) !== null && _d !== void 0 ? _d : ""),
                title,
                tone: toneOf(title),
                url: url.startsWith("http://") || url.startsWith("https://") ? url : "",
                kind: "news",
            },
        ];
    });
}
async function loadAnnouncements(code) {
    var _a, _b;
    if (!/^\d{6}$/.test(code))
        return [];
    const raw = await getText(`https://np-anotice-stock.eastmoney.com/api/security/ann?page_size=8&page_index=1&ann_type=A&stock_list=${code}&client_source=web`, "https://data.eastmoney.com/");
    const parsed = JSON.parse(raw);
    return ((_b = (_a = parsed.data) === null || _a === void 0 ? void 0 : _a.list) !== null && _b !== void 0 ? _b : []).flatMap((item) => {
        var _a, _b, _c;
        const title = ((_a = item.title) !== null && _a !== void 0 ? _a : "").trim();
        const art = (_b = item.art_code) !== null && _b !== void 0 ? _b : "";
        if (!title || !art)
            return [];
        return [
            {
                id: art,
                time: clock((_c = item.notice_date) !== null && _c !== void 0 ? _c : ""),
                title,
                tone: toneOf(title),
                url: `https://data.eastmoney.com/notices/detail/${code}/${art}.html`,
                kind: "ann",
            },
        ];
    });
}
