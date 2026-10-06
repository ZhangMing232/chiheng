/**
 * 这个文件是干什么的：
 * 选股页 = 策略实验台。第一屏先回答「这套规则现在能不能下结论」，
 * 再往下才是各套策略的样本情况和今天的精选。
 *
 * 和 web 版的关系：
 * 数字全由 lib/market/lab.js 算，那一层是从 web 版搬过来的、一个字没改。
 * 这一页只负责把它算出来的东西画出来——口径不在页面里，改口径去改 lab.ts。
 */
const api = require("../../lib/api.js");
const lab = require("../../lib/market/lab.js");
const seedDays = require("../../lib/seed-days.js");
const { DEFAULT_RULES } = require("../../lib/market/rules.js");
const { STYLES } = require("../../lib/market/strategies.js");
const { shanghaiDate } = require("../../lib/market/session.js");
const { signedPct, fmtPrice } = require("../../lib/market/format.js");

Page({
  data: {
    theme: "dark",
    loading: true,
    error: "",
    date: shanghaiDate(),
    report: null,
    cells: [],
    styles: [],
    picks: [],
    goal: lab.PER_STYLE_GOAL,
    pickedAt: "",
    bookEmpty: false,
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
    const [bookRes, rulesRes] = await Promise.all([api.readBook(), api.getRules()]);

    if (bookRes.error && !bookRes.days) {
      this.setData({ loading: false, error: bookRes.error });
      return;
    }
    const days = bookRes.days || [];
    const rules = (rulesRes.rules || DEFAULT_RULES);

    // 实验台的结论：全部由 lab.js 算，页面不算任何一笔
    const report = lab.buildLabReport(days, rules);

    // 样本墙：已结的按盈亏上色，在拿的空心。空心 == 没有答案，不是亏了
    const cells = report.cells.map((c) => ({
      cls: c.open ? "open" : c.ret >= 0 ? "up" : "down",
      bg: c.open ? "" : c.ret >= 0 ? "var(--up)" : "var(--down)",
      title: c.open ? `${c.name} 在拿，还没有答案` : `${c.name} ${signedPct((c.ret || 0) * 100)}`,
    }));

    const styles = report.byStyle.map((s) => ({
      name: s.name,
      total: s.total,
      closed: s.closed,
      win: s.win == null ? "—" : s.win,
      avg: s.avg == null ? "—" : signedPct(s.avg * 100),
      needMore: s.needMore,
      bar: Math.min(100, Math.round((s.closed / s.goal) * 100)),
    }));

    // 今天的精选。held / dayTrades 传给云函数，让它按名额和排重算
    const held = days.flatMap((d) => d.trades).map((t) => ({ id: t.id, style: t.style, exit: t.exit }));
    const today = days.find((d) => d.date === shanghaiDate());
    const picksRes = await api.picks(rules, held, (today && today.trades) || []);

    const picks = (picksRes.picks || []).map((g) => ({
      name: (STYLES.find((s) => s.id === g.style) || {}).name || g.style,
      total: g.total,
      rows: g.rows.map((r) => ({
        name: r.quote.name,
        code: r.quote.code,
        price: fmtPrice(r.quote.price),
        chg: signedPct(r.quote.chg),
        chgCls: (r.quote.chg || 0) > 0 ? "p-up" : (r.quote.chg || 0) < 0 ? "p-down" : "p-mute",
        buy: fmtPrice(r.buy),
        sell: fmtPrice(r.sell),
        stop: fmtPrice(r.stop),
      })),
    }));

    this.setData({
      loading: false,
      report,
      cells,
      styles,
      picks,
      pickedAt: picksRes.at ? new Date(picksRes.at).toLocaleTimeString("zh-CN", { hour12: false }) : "",
      error: picksRes.error || "",
      bookEmpty: days.length === 0,
    });
  },

  /**
   * 一次性把 web 版的账本导进云数据库。只在账本为空时给这个入口——
   * 已经有记录了就绝不覆盖，记下的成交不许改。
   */
  async onImportSeed() {
    wx.showLoading({ title: "正在导入…" });
    const res = await api.importSeed(seedDays);
    wx.hideLoading();
    if (res.error) {
      wx.showToast({ title: res.error, icon: "none" });
      return;
    }
    wx.showToast({ title: `导进 ${res.added} 天`, icon: "none" });
    this.load();
  },
});
