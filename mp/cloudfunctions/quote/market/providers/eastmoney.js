"use strict";
/**
 * 这个文件是干什么的：
 * 东方财富行情源，只当指数的备份。全市场名单备份换成了新浪——东财的名单接口
 * （clist）在本机网络下连不通，同域名的指数接口（ulist）正常。
 *
 * 你需要知道的：
 * 指数没有口径差异要处理：价格、涨跌额、涨跌幅拿来即用。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchEastmoneyIndices = fetchEastmoneyIndices;
const shared_1 = require("../providers/shared");
const HEADERS = {
    "user-agent": "Mozilla/5.0",
    referer: "https://quote.eastmoney.com/",
    accept: "application/json,text/plain,*/*",
};
/** 拉常用指数现价。ids 是 sh、sz 加六位代码，内部换成东财的 1./0. 前缀。 */
async function fetchEastmoneyIndices(ids) {
    var _a, _b, _c;
    const secids = ids.map((id) => `${id.startsWith("sh") ? "1" : "0"}.${id.slice(2)}`).join(",");
    const url = `https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${secids}&fields=f12,f14,f2,f3,f4`;
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(10000) });
    if (!res.ok)
        throw new Error(`status ${res.status}`);
    const body = (await res.json());
    const list = (_a = body.data) === null || _a === void 0 ? void 0 : _a.diff;
    if (!Array.isArray(list) || list.length === 0)
        throw new Error("index empty");
    const rows = [];
    for (const raw of list) {
        const code = typeof raw.f12 === "string" ? raw.f12 : "";
        const secid = ids.find((id) => id.slice(2) === code);
        const price = (0, shared_1.num)(raw.f2, "any");
        if (!secid || price == null)
            continue;
        rows.push({
            id: secid,
            name: typeof raw.f14 === "string" && raw.f14 ? raw.f14 : secid,
            price,
            chg: (_b = (0, shared_1.num)(raw.f4, "any")) !== null && _b !== void 0 ? _b : 0,
            pct: (_c = (0, shared_1.num)(raw.f3, "pct")) !== null && _c !== void 0 ? _c : 0,
            time: "",
        });
    }
    if (rows.length === 0)
        throw new Error("index empty");
    return rows;
}
