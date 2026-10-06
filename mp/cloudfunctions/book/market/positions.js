"use strict";
/**
 * 这个文件是干什么的：
 * 把扁平的成交列表按「交易日期」分组，算出每天开仓几笔、合计多少数量和金额、
 * 赚了还是亏了。持仓页按这个分组渲染。
 *
 * 你需要知道的：
 * 口径上有三件事必须说清，否则那个「金额」会被人当真钱：
 *
 * 1. **不记仓位大小。** 这套是模拟盘，每笔成交都当成满仓记（page-posters、README
 *    都这么写的）。所以「合计金额」只能给**名义金额**：每笔按一手（100 股）折算。
 *    它不是投入的钱，也无法据此算真实仓位。
 * 2. **收益率一律扣费**（`netReturn`，含买卖各千0.25%佣金 + 千0.5%印花税 + 规费）。
 *    汇总的收益率是**每笔收益率相加**，不是按金额加权——因为没有真实仓位可加权。
 *    这个口径在「累计收益」上一直这么用，别的地方也在用。
 * 3. **已实现和浮动分开算。** 卖出的用成交价算「已实现」，还拿着的用现价算「浮动」。
 *    两者相加才是那天到目前为止的盈亏；现价拿不到时浮动算不出来，那天就只有已实现。
 *
 * 这个文件只做计算，不碰 React，所以能自动测。
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.URGENCY = exports.SHARES_PER_LOT = void 0;
exports.groupByDay = groupByDay;
exports.overallOf = overallOf;
exports.dayHeading = dayHeading;
exports.rowReturn = rowReturn;
exports.urgencyOf = urgencyOf;
exports.needsAction = needsAction;
exports.sortByUrgency = sortByUrgency;
const journal_book_1 = require("./journal-book");
/** 一手是 100 股。「数量」按这个折算，见上面的口径说明。 */
exports.SHARES_PER_LOT = 100;
const money = (value) => (value == null ? null : Math.round(value * 100) / 100);
/**
 * 按建仓日分组，最近的一天排在最前面。
 *
 * 入参不需要预先排序——这里会排。同一天内部的顺序保持传入顺序（通常是按分数排的），
 * 这样「今天买入的顺序」和选股表对得上。
 */
function groupByDay(rows) {
    const buckets = new Map();
    for (const row of rows) {
        const list = buckets.get(row.day);
        if (list)
            list.push(row);
        else
            buckets.set(row.day, [row]);
    }
    const groups = [];
    for (const [date, items] of buckets) {
        const open = items.filter((row) => row.exit == null);
        const closed = items.filter((row) => row.exit != null);
        const realizedList = closed.map((row) => row.ret).filter((v) => v != null);
        const openList = open.map((row) => row.ret).filter((v) => v != null);
        const realized = realizedList.length > 0 ? realizedList.reduce((a, b) => a + b, 0) : null;
        // 只要这天有一笔持仓拿不到现价，这天的浮动盈亏就算不出来——宁可空着，
        // 也不能只按能算的那几笔凑一个数，那会让人以为全平了。
        const unrealized = open.length > 0 && openList.length === open.length
            ? openList.reduce((a, b) => a + b, 0)
            : null;
        groups.push({
            date,
            count: items.length,
            shares: items.length * exports.SHARES_PER_LOT,
            amount: items.reduce((sum, row) => sum + row.entry * exports.SHARES_PER_LOT, 0),
            open,
            closed,
            realized,
            unrealized,
            total: realized == null && unrealized == null ? null : (realized !== null && realized !== void 0 ? realized : 0) + (unrealized !== null && unrealized !== void 0 ? unrealized : 0),
            pnlAmount: closed.length > 0
                ? money(closed.reduce((sum, row) => { var _a; return sum + ((_a = row.pnl) !== null && _a !== void 0 ? _a : 0) * exports.SHARES_PER_LOT; }, 0))
                : null,
            openPnlAmount: open.length > 0 && openList.length === open.length
                ? money(open.reduce((sum, row) => { var _a; return sum + ((_a = row.pnl) !== null && _a !== void 0 ? _a : 0) * exports.SHARES_PER_LOT; }, 0))
                : null,
        });
    }
    return groups.sort((a, b) => b.date.localeCompare(a.date));
}
function overallOf(groups) {
    const flat = groups.flatMap((group) => [...group.closed, ...group.open]);
    const closed = flat.filter((row) => row.exit != null);
    const open = flat.filter((row) => row.exit == null);
    const realizedList = closed.map((row) => row.ret).filter((v) => v != null);
    const openList = open.map((row) => row.ret).filter((v) => v != null);
    const realized = realizedList.length > 0 ? realizedList.reduce((a, b) => a + b, 0) : null;
    const unrealized = open.length > 0 && openList.length === open.length
        ? openList.reduce((a, b) => a + b, 0)
        : null;
    return {
        count: flat.length,
        shares: flat.length * exports.SHARES_PER_LOT,
        amount: flat.reduce((sum, row) => sum + row.entry * exports.SHARES_PER_LOT, 0),
        openCount: open.length,
        closedCount: closed.length,
        realized,
        unrealized,
        total: realized == null && unrealized == null ? null : (realized !== null && realized !== void 0 ? realized : 0) + (unrealized !== null && unrealized !== void 0 ? unrealized : 0),
    };
}
/** 「10月5日 周一」这种标题。weekday 由调用方传，缺了就不带星期。 */
function dayHeading(date, weekday) {
    const match = date.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (!match)
        return date;
    const base = `${Number(match[2])}月${Number(match[3])}日`;
    return weekday ? `${base} ${weekday}` : base;
}
/** 由一笔成交算出收益率。已卖的扣费，持有的按现价。 */
function rowReturn(entry, exit, livePrice) {
    if (exit != null)
        return (0, journal_book_1.netReturn)(entry, exit);
    if (livePrice == null || !(livePrice > 0))
        return null;
    return livePrice / entry - 1;
}
/**
 * 紧迫度分级——盘中第 ② 步（看谁到止损/目标价了）是最高频动作，
 * 排序必须服务于它。
 *
 * 你需要知道的：
 * 原先持仓按建仓日排、组内按传入顺序排，等于要自己在一屏 60 行里找那几只
 * 到价的。现在按「能不能现在动手」排：能动手的排最前，不能动手的（T+1、跌停）
 * 次之，剩下按收益率从低到高——盯盘时先看亏得最多的。
 *
 * 纯函数，放这儿是为了能自动测：这个顺序错了不会崩，但会让盯盘时多花几秒，
 * 而那几秒是最贵的。
 */
/** 数字越小越紧急。 */
exports.URGENCY = {
    /** 到了止损价，能卖，该马上处理 */
    stop: 0,
    /** 到了目标价，能卖，该马上处理 */
    target: 1,
    /** 跌停，卖不出。紧急但动不了——要让人看见，别让人以为漏了 */
    limitDown: 2,
    /** 当天买的，不能卖 */
    t1: 3,
    /** 正常持有 */
    hold: 4,
    /** 已经卖掉的 */
    closed: 5,
};
/** 这一笔现在处于什么紧迫度。认不出来就当正常持有，不要猜。 */
function urgencyOf(row) {
    if (row.exit != null)
        return exports.URGENCY.closed;
    if (row.state === "止损")
        return exports.URGENCY.stop;
    if (row.state === "卖出")
        return exports.URGENCY.target;
    if (row.state === "跌停")
        return exports.URGENCY.limitDown;
    if (row.state === "T+1")
        return exports.URGENCY.t1;
    return exports.URGENCY.hold;
}
/** 需要「现在处理」的那些：到了价能卖的，加上跌停卖不出的（要看见）。 */
function needsAction(row) {
    const level = urgencyOf(row);
    return level === exports.URGENCY.stop || level === exports.URGENCY.target || level === exports.URGENCY.limitDown;
}
/**
 * 按紧迫度排序。同一档内按收益率从低到高（亏得多的排前面）。
 *
 * 稳定排序：原来顺序相同的不打乱，所以「同一只票在不同分组里」位置不会乱跳。
 */
function sortByUrgency(rows) {
    return rows
        .map((row, i) => ({ row, i }))
        .sort((a, b) => {
        var _a, _b;
        const d = urgencyOf(a.row) - urgencyOf(b.row);
        if (d !== 0)
            return d;
        const ra = (_a = a.row.ret) !== null && _a !== void 0 ? _a : Number.POSITIVE_INFINITY;
        const rb = (_b = b.row.ret) !== null && _b !== void 0 ? _b : Number.POSITIVE_INFINITY;
        if (ra !== rb)
            return ra - rb;
        return a.i - b.i;
    })
        .map((item) => item.row);
}
