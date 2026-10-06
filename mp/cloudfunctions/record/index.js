/**
 * 这个文件是干什么的：
 * 每天跑的定时任务。干两件事：把今天该开的仓记进账本，把该卖的按现价结算掉。
 * web 版对应的是 record-journal.ts，逻辑照搬。
 *
 * 怎么触发：
 * 部署后在云开发控制台给这个函数配定时触发器，cron 例如：
 *   0 30 14 * * MON-FRI *   （每个交易日 14:30 跑一次）
 * 也可以在开发者工具里右键这个函数「本地调试」手动跑一遍看结果。
 *
 * 为什么必须放在云函数里跑：
 * 小程序关掉就不跑了。记账这件事得有人在你不看手机的时候做完，
 * 而且「当时几点记的」直接影响统计口径（收盘后补记的那天整天不算数，
 * 见 journal-book.ts 的 dayReliable）。
 */
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const { fetchUniverse, fetchIndices } = require("./market/providers/index.js");
const { ACTIVE_STYLES, watchList, takeBuys } = require("./market/strategies.js");
const { planExit, HOLD_SESSIONS, limitTag, isIdleBook } = require("./market/model.js");
const { shanghaiDate, exitAfterSessions, isTradingDay, formatClock } = require("./market/session.js");
const DEFAULT_RULES = require("./market/rules.js").DEFAULT_RULES;

const INDEX_ID = "sh000300";

async function daysOf(openid) {
  const res = await db.collection("days").where({ _openid: openid }).orderBy("date", "desc").limit(100).get();
  return res.data;
}

async function rulesOf(openid) {
  const res = await db.collection("rules").where({ _openid: openid }).limit(1).get();
  return res.data.length > 0 ? res.data[0].rules : DEFAULT_RULES;
}

/** 记今天新打到的买入价。signalTime 记的是真实现在几点——统计口径靠它判断。 */
async function recordBuys(openid, quotes, rules, days, now) {
  const date = shanghaiDate(now);
  const signalTime = formatClock(now);
  const held = days.flatMap((d) => d.trades).map((t) => ({ id: t.id, style: t.style, exit: t.exit }));
  const todayTrades = (days.find((d) => d.date === date) || {}).trades || [];

  const trades = [];
  for (const style of ACTIVE_STYLES) {
    const list = watchList(quotes, style, rules, () => true);
    for (const row of takeBuys(list, held, style, todayTrades)) {
      const levels = planExit(row.buy, row.quote.d20 ?? null, rules);
      trades.push({
        id: row.quote.id,
        code: row.quote.code,
        name: row.quote.name,
        entry: row.buy,
        stop: levels.stop,
        target: levels.target,
        style,
        hold: HOLD_SESSIONS,
        exit: null,
        exitDate: null,
      });
    }
  }
  if (trades.length === 0) return { recorded: 0, date };

  const col = db.collection("days");
  const found = await col.where({ _openid: openid, date }).limit(1).get();
  if (found.data.length === 0) {
    await col.add({ data: { _openid: openid, date, signalTime, indexEntry: null, indexExit: null, trades } });
  } else {
    const doc = found.data[0];
    const seen = new Set(doc.trades.map((t) => `${t.style || ""}:${t.id}`));
    const extras = trades.filter((t) => !seen.has(`${t.style || ""}:${t.id}`));
    if (extras.length) await col.doc(doc._id).update({ data: { trades: _.push(extras) } });
    return { recorded: extras.length, date, signalTime };
  }
  return { recorded: trades.length, date, signalTime };
}

/**
 * 结算到期的持仓：拿满 N 个交易日的按现价卖，跌停卖不出的留到下一天。
 * 只改「还没卖」的那笔，卖出价写下就改不了。
 */
async function settleDue(openid, quotes, days, now) {
  const byId = new Map(quotes.map((q) => [q.id, q]));
  const col = db.collection("days");
  let sold = 0;
  let blocked = 0;

  for (const day of days) {
    const dueDate = exitAfterSessions(day.trades[0] && day.trades[0].hold ? day.trades[0].hold : HOLD_SESSIONS, new Date(day.date).getTime());
    if (shanghaiDate(now) < dueDate) continue;

    let changed = false;
    const trades = day.trades.map((t) => {
      if (t.exit != null) return t;
      const q = byId.get(t.id);
      if (!q) return t;
      // 跌停卖不出去，顺延到下一天——这条是 web 版踩过的坑，别改
      if (limitTag(q) === "跌停") {
        blocked += 1;
        return t;
      }
      changed = true;
      sold += 1;
      return Object.assign({}, t, { exit: q.price, exitDate: shanghaiDate(now) });
    });
    if (changed) {
      await col.doc(day._id).update({ data: { trades } });
    }
  }
  return { sold, blocked };
}

/** 沪深300 对照价。开仓那天记 entry，卖出那天记 exit。没有它实验台永远说「拿不到」。 */
async function recordIndex(openid, days, now) {
  const idx = await fetchIndices([INDEX_ID]);
  const row = (idx || []).find((i) => i.id === INDEX_ID);
  if (!row || !row.price) return { ok: false, why: "指数没拉到" };
  const col = db.collection("days");
  const date = shanghaiDate(now);

  const today = days.find((d) => d.date === date);
  if (today && today.indexEntry == null) {
    await col.doc(today._id).update({ data: { indexEntry: row.price } });
  }
  // 到期那天的 exit：卖出结算后记一次
  for (const day of days) {
    if (day.indexExit != null) continue;
    const due = exitAfterSessions(HOLD_SESSIONS, new Date(day.date).getTime());
    if (date >= due) await col.doc(day._id).update({ data: { indexExit: row.price } });
  }
  return { ok: true, price: row.price };
}

exports.main = async () => {
  const { OPENID } = cloud.getWXContext();
  const now = Date.now();
  try {
    if (!isTradingDay(shanghaiDate(now))) return { skipped: "今天不是交易日" };

    const days = await daysOf(OPENID);
    const rules = await rulesOf(OPENID);
    const uni = await fetchUniverse();
    const quotes = uni.quotes || [];
    if (isIdleBook(quotes)) return { skipped: "行情还没开始" };

    const buys = await recordBuys(OPENID, quotes, rules, days, now);
    const fresh = await daysOf(OPENID);
    const settled = await settleDue(OPENID, quotes, fresh, now);
    const index = await recordIndex(OPENID, fresh, now);

    return { ok: true, buys, settled, index, at: new Date(now).toISOString() };
  } catch (err) {
    return { error: String((err && err.message) || err) };
  }
};
