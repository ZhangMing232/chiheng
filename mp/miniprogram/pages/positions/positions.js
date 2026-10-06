/**
 * 这个文件是干什么的：
 * 持仓页。按开仓日期分组，最上面是「需处理」（到止损/到目标价的排最前）。
 *
 * 和 web 版的关系：
 * 行的算法（收益率、状态、紧急度排序、分组汇总）全在 lib/market/positions.js，
 * 从 web 版搬过来的。这一页只做两件额外的事：把现价从云函数拉来，然后渲染。
 */
const api = require("../../lib/api.js");
const P = require("../../lib/market/positions.js");
const { DEFAULT_RULES } = require("../../lib/market/rules.js");
const { planExit, limitTag } = require("../../lib/market/model.js");
const { shanghaiDate } = require("../../lib/market/session.js");
const { signedPct, fmtPrice, fmtMoney } = require("../../lib/market/format.js");
const { STYLES } = require("../../lib/market/strategies.js");

const WEEKDAYS = { Mon: "周一", Tue: "周二", Wed: "周三", Thu: "周四", Fri: "周五", Sat: "周六", Sun: "周日" };

function weekdayOf(date) {
  const m = date.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return "";
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00+08:00`);
  return WEEKDAYS[new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" }).format(d)] || "";
}

/** 把账本摊平成带收益率的行。没卖的用云函数给的现价。 */
function buildRows(days, liveById, rules) {
  const today = shanghaiDate();
  const rows = [];
  for (const day of days) {
    for (const t of day.trades) {
      const live = liveById[t.id] || null;
      const price = live ? live.price : null;
      const ret = P.rowReturn(t.entry, t.exit, price);
      const levels = t.stop && t.target ? { stop: t.stop, target: t.target } : planExit(t.entry, null, rules);
      let state = "持有";
      if (t.exit != null) state = "已卖";
      else if (day.date >= today) state = "T+1";
      else if (live && limitTag(live) === "跌停") state = "跌停";
      else if (live && live.price <= levels.stop) state = "止损";
      else if (live && live.price >= levels.target) state = "卖出";

      rows.push({
        id: t.id, code: t.code, name: t.name, style: t.style,
        entry: t.entry, stop: levels.stop, target: levels.target,
        exit: t.exit, exitDate: t.exitDate, day: day.date,
        signalTime: day.signalTime || "",
        live: live ? { price: live.price, chg: live.chg } : null,
        ret, state,
        pnl: (t.exit != null ? t.exit : price) == null ? null : (t.exit != null ? t.exit : price) - t.entry,
        indexRet: day.indexEntry && day.indexExit ? day.indexExit / day.indexEntry - 1 : null,
      });
    }
  }
  return rows;
}

function toView(row) {
  const tone = row.state === "止损" ? "p-down" : row.state === "卖出" ? "p-up" : row.state === "跌停" ? "p-warn" : "p-mute";
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    price: row.live ? fmtPrice(row.live.price) : "—",
    chg: row.live ? signedPct(row.live.chg) : "—",
    chgCls: row.live ? ((row.live.chg || 0) > 0 ? "p-up" : (row.live.chg || 0) < 0 ? "p-down" : "p-mute") : "p-mute",
    entry: fmtPrice(row.entry),
    ret: row.ret == null ? "—" : signedPct(row.ret * 100),
    retCls: row.ret == null ? "p-mute" : row.ret > 0 ? "p-up" : "p-down",
    state: row.state,
    stateCls: tone,
    styleName: (STYLES.find((s) => s.id === row.style) || {}).name || "—",
  };
}

Page({
  data: {
    theme: "dark",
    loading: true,
    error: "",
    total: null,
    urgent: [],
    groups: [],
    empty: false,
  },

  onLoad() {
    this.setData({ theme: getApp().globalData.theme });
    this.load();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  async load() {
    this.setData({ loading: true, error: "" });
    const bookRes = await api.readBook();
    if (bookRes.error && !bookRes.days) {
      this.setData({ loading: false, error: bookRes.error });
      return;
    }
    const days = bookRes.days || [];

    // 只问手上还没卖的那几只的现价，不问全市场
    const openIds = [];
    for (const d of days) for (const t of d.trades) if (t.exit == null) openIds.push(t.id);
    const qRes = openIds.length ? await api.quotes(openIds) : { rows: [] };
    const liveById = {};
    for (const q of qRes.rows || []) liveById[q.id] = q;

    const rulesRes = await api.getRules();
    const rules = rulesRes.rules || DEFAULT_RULES;

    const rows = buildRows(days, liveById, rules);
    const groups = P.groupByDay(rows).map((g) => ({
      heading: P.dayHeading(g.date, weekdayOf(g.date)),
      count: g.count,
      shares: g.shares,
      amount: fmtMoney(g.amount),
      total: g.total == null ? "—" : signedPct(g.total * 100),
      totalCls: g.total == null ? "muted" : g.total > 0 ? "up" : "down",
      rows: [...P.sortByUrgency(g.closed), ...P.sortByUrgency(g.open)].map(toView),
    }));

    const total = P.overallOf(P.groupByDay(rows));
    this.setData({
      loading: false,
      error: qRes.error || "",
      empty: rows.length === 0,
      total: {
        count: total.count,
        openCount: total.openCount,
        closedCount: total.closedCount,
        amount: fmtMoney(total.amount),
        realized: total.realized == null ? "—" : signedPct(total.realized * 100),
        unrealized: total.unrealized == null ? "—" : signedPct(total.unrealized * 100),
      },
      urgent: P.sortByUrgency(rows.filter(P.needsAction)).map(toView),
      groups,
    });
  },
});
