"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.HOLD_SESSIONS = exports.ROUND_TRIP_COST = void 0;
exports.exitFill = exitFill;
exports.nthClose = nthClose;
exports.dayReturns = dayReturns;
exports.losingStreak = losingStreak;
exports.recentMean = recentMean;
exports.liveGate = liveGate;
exports.dayLocked = dayLocked;
exports.dayReliable = dayReliable;
exports.lotShares = lotShares;
exports.stopPrice = stopPrice;
exports.yuan = yuan;
exports.netReturn = netReturn;
/**
 * 这个文件是干什么的：
 * 模拟 A 股怎么成交、怎么算赚亏。页面上的买卖提示也走这里的价。
 *
 * 你需要知道的：
 * 买入当天不能卖。循环从买入日的下一根 K 线开始，所以天然是 T+1。
 * 同一天既碰到止损又碰到止盈，先按止损算，不按更好看的卖出价。
 * 跌停封死的那天卖不掉，这天不算卖出，继续等下一天。
 * 手续费是写死的一来一回：佣金万 2.5 两边、印花税万 5（只在卖出里折进这一笔）、过户费万 0.1 两边。
 * 没有做「佣金不足 5 元按 5 元收」。这是模拟账，不会发给券商。
 */
const rules_1 = require("./rules");
const model_1 = require("./model");
Object.defineProperty(exports, "HOLD_SESSIONS", { enumerable: true, get: function () { return model_1.HOLD_SESSIONS; } });
/** 卖出印花税万五，佣金万二点五双边，过户费万零点一双边。没有按股数计「不足 5 元收 5 元」。 */
exports.ROUND_TRIP_COST = 0.00025 * 2 + 0.0005 + 0.00001 * 2;
function normDay(value) {
    const match = value.match(/(\d{4})-?(\d{2})-?(\d{2})/);
    return match ? `${match[1]}-${match[2]}-${match[3]}` : value;
}
/**
 * 顺着买入日之后的 K 线，找出第一天该卖的价格。
 * 返回 reason：stop 止损，target 到卖出价，time 持股天数到了按收盘价卖。
 * 还没走到那一天就返回空，账上继续拿着。
 * 到期那天卖不掉（跌停封死、收盘价缺失）就顺延，最多再给 5 个交易日，
 * 宽限期最后一天无论如何按收盘价结掉，不让这笔永远挂在账上。
 */
function exitFill(bars, entryDate, entry, stop, target, limitPct = 10, sessions = model_1.HOLD_SESSIONS) {
    const start = bars.findIndex((bar) => normDay(bar.date) === normDay(entryDate));
    if (start < 0 || !(entry > 0) || !(stop > 0) || !(target > stop))
        return null;
    let prev = bars[start].c;
    let left = sessions;
    let extra = 5;
    for (let cursor = start + 1; cursor < bars.length && (left > 0 || extra > 0); cursor += 1) {
        const bar = bars[cursor];
        // 接口偶尔吐出一根全 0 的残缺 K 线。这天没有可信价格，不能拿 0 去判定
        // 止损止盈（那会变成「跳空跌到 0」）。但它是真实存在的交易日，照样计入
        // 持股天数；prev 也不更新，免得用 0 去算下一天的跌停价。
        if (!(bar.c > 0)) {
            if (left > 0)
                left -= 1;
            else
                extra -= 1;
            continue;
        }
        const down = Math.round(prev * (1 - limitPct / 100) * 100) / 100;
        // 跌停最多只能跌 limitPct。跌幅比这还大，一定不是跌停，而是除权除息或者
        // 长期停牌后复牌——这些日子照样能卖，不能当成「封死卖不掉」跳过。
        // 留半个点的容差，挡住四舍五入和那些不到一分钱的误差。
        const drop = prev > 0 ? ((prev - bar.c) / prev) * 100 : 0;
        const sealedDown = drop <= limitPct + 0.5 && down > 0 && bar.c <= down + 0.01 && (bar.h == null || bar.h <= down + 0.01);
        prev = bar.c;
        // last 表示「持股天数已经用完了」。left 减到 0 之后也算到期，
        // 这样到期那天刚好跌停时，下一个能卖的收盘价就会成交，而不是一直等下去。
        const last = left === 1 || left === 0;
        // forced 是宽限期的最后一天。这天即使还封着也按收盘价结掉，避免永久挂账。
        const forced = extra === 1;
        if (left > 0)
            left -= 1;
        else
            extra -= 1;
        // 跌停封死这天是卖不掉的。到了宽限期最后一天必须结掉，此时按当天收盘价记：
        // 一笔连吃了十几个跌停的仓位，真实亏损可能已经腰斩，如果这时候拿止损价
        // （往往远高于实际跌到的位置）冒充成交价，账上只显示亏了几个点，风险全被藏起来。
        // 实测过：10 元买入、止损 9.7，连吃 13 个跌停后真实收盘 2.54（-74.6%），
        // 改之前这笔被记成 9.7 卖出（-3.0%）。
        if (sealedDown) {
            if (forced && bar.c > 0)
                return { date: normDay(bar.date), price: bar.c, reason: "time" };
            continue;
        }
        const high = bar.h != null && bar.h > 0 ? bar.h : bar.c;
        const low = bar.l != null && bar.l > 0 ? bar.l : bar.c;
        // 买入当日不在这个循环里，满足 T+1。同一天两边都碰到，按先止损。
        // 跳空低开直接穿过止损时，止损单成交不到止损价上——开盘那一刻价格已经在止损下面了，
        // 实际能拿到的只有开盘价。除权除息、长期停牌后复牌、突发利空都会造成这种跳空。
        // 往不利的方向修正，否则止损的保护作用会被凭空放大。
        //
        // 只有数据源确实给了开盘价才做这个修正。拿收盘价顶替是不行的：止损触发那天
        // 收盘往往就在止损价下方，那么每次止损都会被当成跳空，亏多少全被记成
        // 「跌到收盘才卖」，系统性多算亏损。宁可保守，也不能凭空把账面做难看。
        if (low <= stop) {
            const gapOpen = bar.o != null && bar.o > 0 && bar.o <= stop ? bar.o : null;
            return { date: normDay(bar.date), price: gapOpen !== null && gapOpen !== void 0 ? gapOpen : stop, reason: "stop" };
        }
        if (high >= target)
            return { date: normDay(bar.date), price: target, reason: "target" };
        if ((last || forced) && bar.c > 0)
            return { date: normDay(bar.date), price: bar.c, reason: "time" };
    }
    return null;
}
/** 从买入日往后数 sessions 个交易日，用那天的收盘价。补涨这种「下一交易日卖」会用到。 */
function nthClose(bars, entryDate, sessions = model_1.HOLD_SESSIONS) {
    const start = bars.findIndex((bar) => normDay(bar.date) === normDay(entryDate));
    if (start < 0)
        return null;
    let left = sessions;
    for (let cursor = start + 1; cursor < bars.length && left > 0; cursor += 1) {
        left -= 1;
        if (left === 0 && bars[cursor].c > 0)
            return { date: normDay(bars[cursor].date), price: bars[cursor].c };
    }
    return null;
}
/**
 * 同一天的收益先取平均，得到「这一天等权组合赚了多少」。
 *
 * 连亏和停手线都得按天看，不能按笔。同一天的十来个仓位是一起涨跌的，
 * 亏就一起亏——按笔算的话一次回调就是「连亏十几笔」，看着像策略崩了，
 * 其实只是那天行情不好。实测中期反转按笔算是连亏 ≥3 笔占 21% 的时间，
 * 按天算是连亏 ≥3 天占 33%，两边都在天天误报。
 */
function dayReturns(trades) {
    var _a;
    const bucket = new Map();
    for (const trade of trades) {
        const row = (_a = bucket.get(trade.date)) !== null && _a !== void 0 ? _a : { sum: 0, n: 0 };
        row.sum += trade.ret;
        row.n += 1;
        bucket.set(trade.date, row);
    }
    return [...bucket.values()].map((row) => row.sum / row.n);
}
/** 从最近一个日子往回数，连着亏了几天。中间有一天不亏就停。 */
function losingStreak(dayReturnsList) {
    let streak = 0;
    for (let index = dayReturnsList.length - 1; index >= 0; index -= 1) {
        if (dayReturnsList[index] < 0)
            streak += 1;
        else
            break;
    }
    return streak;
}
/** 最近 window 笔的平均收益。不够 window 笔返回 null。 */
function recentMean(returns, window = 20) {
    if (returns.length < window || window <= 0)
        return null;
    const tail = returns.slice(-window);
    return tail.reduce((sum, value) => sum + value, 0) / window;
}
/**
 * 真钱开关。天数和笔数不够、没跑赢指数、最近一段时间亏得反常，都不开。
 *
 * trades 要按出场日排好，每笔带 date 和 ret——按天汇总得靠 date。
 *
 * 两条停手线都刻意避开了「回撤」：纸面账不记仓位大小，每笔都按满仓入账，
 * 十笔同日卖出的加起来等于十个满仓，净值一年能冲到二十几倍，算出来的回撤
 * 动辄 80% 以上（中期反转实测 88.9%），而停手线是 8%，等于任何跑久一点的
 * 策略都被永久停掉。改成两个算得准的量：
 *   连亏几天——按天算，门槛按这套策略自己的亏损日比例反推
 *   最近 20 笔平均收益——实测低于 -8% 的时间，中期反转只占 2%，其余策略 0%
 */
function liveGate(days, closed, trades, rules = rules_1.DEFAULT_RULES) {
    const perTrade = trades.map((trade) => trade.ret);
    const perDay = dayReturns(trades);
    const streak = losingStreak(perDay);
    // 「连亏几天算反常」得看这套策略平时有多少天是亏的，不能一刀切。
    // 胜率五成的策略连亏三天是常事（实测中期反转 33% 的日子都处在连亏 3 天里），
    // 胜率七成的策略连亏三天才少见。所以按它自己的亏损日比例反推：
    // 连亏到这个天数、发生的概率不到 5% 才算异常。规则里写的是下限，不是上限。
    const lossDays = perDay.filter((value) => value < 0).length;
    const lossDayRate = perDay.length >= 20 ? lossDays / perDay.length : null;
    const natural = lossDayRate != null && lossDayRate > 0 ? Math.ceil(Math.log(0.05) / Math.log(lossDayRate)) : 0;
    const streakLimit = Math.max(rules.maxLosingStreak, natural);
    if (rules.maxLosingStreak > 0 && streak >= streakLimit) {
        const usual = lossDayRate == null
            ? ""
            : `（这套平时 ${Math.round(lossDayRate * 100)}% 的交易日是亏的，连亏 ${streakLimit} 天以上才反常）`;
        return { ok: false, reason: `这版已连续亏损 ${streak} 个交易日${usual}，先停止新开仓` };
    }
    const recent = recentMean(perTrade, 20);
    if (rules.maxDrawdownPct > 0 && recent != null && recent < -rules.maxDrawdownPct / 100) {
        return {
            ok: false,
            reason: `最近 20 笔平均每笔 ${(recent * 100).toFixed(1)}%，超过 ${rules.maxDrawdownPct}%，先停止新开仓`,
        };
    }
    if (rules.minDays > 0 && days < rules.minDays)
        return { ok: false, reason: `交易日记录 ${days}/${rules.minDays}` };
    const paired = closed.filter((trade) => trade.ret != null && trade.indexRet != null);
    if (rules.minClosed > 0 && paired.length < rules.minClosed) {
        return { ok: false, reason: `能对比沪深300的闭环 ${paired.length}/${rules.minClosed}` };
    }
    if (rules.minClosed > 0 && paired.length > 0) {
        const excess = paired.reduce((sum, trade) => sum + (trade.ret - trade.indexRet), 0) / paired.length;
        if (!(excess > 0))
            return { ok: false, reason: "扣费后没有跑赢沪深300" };
    }
    if (rules.minDays === 0 && rules.minClosed === 0)
        return { ok: true, reason: "样本检验已关掉。连亏和近期亏损仍会停手" };
    return { ok: true, reason: "可以按计划的小仓位做。连亏或近期亏损变大就会再关上" };
}
/** 14:40 之后的信号当成当天已经冻结。provisional 表示还在变，不能当买入价。 */
function dayLocked(day) {
    var _a;
    if (day.status === "locked")
        return true;
    if (day.status === "provisional")
        return false;
    return ((_a = day.signalTime) !== null && _a !== void 0 ? _a : "") >= "14:40";
}
/**
 * 这一天的记录能不能拿来统计。
 * 记账脚本是每分钟跑一趟的，收盘之后拿到的只有当天收盘快照。
 * 那种时候记下的成交不是盘中打到价买进去的，是拿收盘价倒推出来的，
 * 混进样本里会把成绩算歪，所以统计时要跳过。
 * 没有 signalTime 的老数据判断不了，先当成可信的，不擅自丢掉。
 */
function dayReliable(day) {
    var _a;
    const time = (_a = day.signalTime) !== null && _a !== void 0 ? _a : "";
    if (!time)
        return true;
    return time >= "09:15" && time < "15:00";
}
/** 这些钱按这个价最多买多少股。A 股一手 100 股，所以结果一定是 100 的倍数。 */
function lotShares(budget, price) {
    if (!(budget > 0) || !(price > 0))
        return 0;
    return Math.floor(budget / price / 100) * 100;
}
/** 按最大亏损百分比反推止损价。例如亏 8% 就是买入价乘 0.92。不算手续费。 */
function stopPrice(entry, maxLossPct) {
    if (!(entry > 0) || !(maxLossPct > 0) || maxLossPct >= 100)
        return null;
    return entry * (1 - maxLossPct / 100);
}
/** 把金额收成「¥123」这种给人看的文字。负数带减号。 */
function yuan(amount) {
    if (!Number.isFinite(amount))
        return "—";
    const sign = amount < 0 ? "-" : "";
    return `${sign}¥${Math.abs(amount).toFixed(0)}`;
}
/** 扣掉一来一回的手续费之后，这一笔赚了多少比例。0.01 表示赚 1%。 */
function netReturn(entry, exit) {
    if (!(entry > 0) || !(exit > 0))
        return null;
    return exit / entry - 1 - exports.ROUND_TRIP_COST;
}
