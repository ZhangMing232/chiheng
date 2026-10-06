"use strict";
/**
 * 这个文件是干什么的：
 * 行情数据源的统一入口。全市场快照和指数都先走腾讯；腾讯不行，全市场换新浪、
 * 指数换东方财富（东财的全市场名单接口在本机网络下不通，指数接口正常）。
 *
 * 你需要知道的：
 * 切换发生在每一次拉取，哪个源成功了就标在结果的 source 上，并写一条日志
 * （npm run mac:log 能看到）。全市场名单不到 4000 只就当这次拉取失败——
 * 残缺的名单比报错更危险，会把账本记错。以后接正规付费源，在这里加一路就行，
 * 页面和记账代码不用动。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.fetchUniverse = fetchUniverse;
exports.fetchIndices = fetchIndices;
const tencent_1 = require("../providers/tencent");
const sina_1 = require("../providers/sina");
const eastmoney_1 = require("../providers/eastmoney");
/** 全市场名单的最低只数。现在沪深京一共五千多只，低于这个数说明源返回得不完整。 */
const MIN_UNIVERSE = 4000;
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * 北交所不在选股范围里，两个源都要挡掉，不能只挡一个。
 *
 * 原因有两条，都是实测出来的：一是腾讯的榜单接口根本没有北交所（bjs 返回 0 条），
 * 只有新浪那份名单里有 348 只；只在新浪那边放行的话，换源当天名单会凭空多出
 * 三百多只，选股结果跟着变，看不出是行情变了还是源变了。二是北交所的票在腾讯源
 * 里拿不到量比和近 5/20/60 日涨幅，突破和低估值这两套硬性要这些字段，等于一只
 * 都进不来；补涨走的是板块接口、不看这些字段，一旦选中北交所，第二天结算时
 * quotes.find 找不到它，这笔就永远挂在账上卖不掉。
 *
 * 涨跌停 30%、流动性也偏薄，短线这几套本来就不适合它。回测的样本池同样排除了
 * 北交所，两边口径一致。以后要放开，得先补一个能给齐字段的源。
 */
function withoutBj(quotes) {
    return quotes.filter((quote) => !quote.id.startsWith("bj"));
}
function universeOf(quotes, source) {
    const rows = withoutBj(quotes);
    return { quotes: rows, asOf: Date.now(), total: rows.length, partial: false, stale: false, source };
}
/**
 * 换源之后哪些策略要停摆，说清楚，别让它静悄悄地整天不出票。
 *
 * 新浪那份名单里没有近 5/10/20/60 日涨幅，量比也是 0。所以一旦切到新浪：
 *   放量突破 要 d5、d20、量比 —— 一只都进不来
 *   中期反转 要 d60        —— 一只都进不来
 *   低估值   只要市盈率和市净率，新浪有  —— 照常
 *   次日补涨 走板块接口，不看这些字段   —— 照常
 * 页面上看不出来是「今天没有符合条件的票」还是「源换了没数据」，所以打一条日志。
 */
function warnIfDegraded(source) {
    if (source !== "sina")
        return;
    console.warn("[行情] 新浪源没有近 5/20/60 日涨幅和量比：放量突破、中期反转这两套今天不会出票，不是选不出票。");
}
/** 拉全市场 A 股报价。先腾讯，失败后新浪，两个都失败才报错。 */
async function fetchUniverse() {
    try {
        const t = await (0, tencent_1.fetchTencentUniverse)();
        if (t.quotes.length < MIN_UNIVERSE)
            throw new Error(`名单不全：只有 ${t.quotes.length} 只`);
        return { ...universeOf(t.quotes, "tencent"), partial: t.partial };
    }
    catch (error) {
        console.warn(`[行情] 腾讯源失败（${messageOf(error)}），改用新浪财经`);
    }
    const s = await (0, sina_1.fetchSinaUniverse)();
    if (s.quotes.length < MIN_UNIVERSE)
        throw new Error(`新浪名单不全：只有 ${s.quotes.length} 只`);
    console.warn(`[行情] 已切换到新浪财经源，共 ${s.quotes.length} 只`);
    warnIfDegraded("sina");
    return { ...universeOf(s.quotes, "sina"), partial: s.partial };
}
/** 拉常用指数现价。先腾讯，失败后换东方财富；两个都失败才报错。 */
async function fetchIndices(ids) {
    try {
        return await (0, tencent_1.fetchTencentIndices)(ids);
    }
    catch (error) {
        console.warn(`[行情] 腾讯指数失败（${messageOf(error)}），改用东方财富`);
    }
    return (0, eastmoney_1.fetchEastmoneyIndices)(ids);
}
