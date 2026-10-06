/**
 * 这个文件是干什么的：
 * 选股页 = 策略实验台。第一屏先回答「这套规则现在能不能下结论」，
 * 再往下才是各套策略的样本情况和今天的精选。
 *
 * 打开就有的看：
 * onLoad 先用本地存储里的账本把整页画出来（同步，不等网络），
 * 再悄悄从云端拉——拉到了替换，拉不上就留着本地那份，顶部标一句
 * 「这是上次的数据」。所以打开永远是满的，不会先白屏再填。
 *
 * 和 web 版的关系：
 * 数字全由 lib/market/lab.js 算，那一层是从 web 版搬过来的、一个字没改。
 * 这一页只负责把它算出来的东西画出来——口径不在页面里，改口径去改 lab.ts。
 */
const api = require("../../lib/api.js");
const store = require("../../lib/store.js");
const lab = require("../../lib/market/lab.js");
const { DEFAULT_RULES } = require("../../lib/market/rules.js");
const { STYLES } = require("../../lib/market/strategies.js");
const { shanghaiDate } = require("../../lib/market/session.js");
const { signedPct, fmtPrice } = require("../../lib/market/format.js");

Page({
  data: {
    theme: "dark",
    loading: true,
    error: "",
    stale: false,
    staleText: "",
    date: shanghaiDate(),
    report: null,
    cells: [],
    styles: [],
    picks: [],
    goal: lab.PER_STYLE_GOAL,
    pickedAt: "",
    bookEmpty: false,
    lastRecord: "还没有记过",
    recording: false,
  },

  onLoad() {
    this.setData({ theme: getApp().globalData.theme });
    // ① 先本地，后云端。第一屏不等网络。
    store.ensureSeed();
    this.render(store.localDays(), "local");
    // ② 后台同步：云端有就替换，没有就把本地的推上去
    store.sync().then((r) => {
      this.render(r.days, r.from);
      this.setData({
        staleText: r.error
          ? "云端没连上，现在看的是本机保存的。点一下重试。"
          : "这是上次的数据，正在同步…点一下刷新",
      });
    });
    // ③ 顺手记一次（今天没记过才记），失败不出声
    store.maybeRecord();
  },

  onPullDownRefresh() {
    this.load().then(() => wx.stopPullDownRefresh());
  },

  /** 把一份账本算成页面要的东西，然后画出来。days 为空就画空态。 */
  render(days, from) {
    const list = days || [];
    // 实验台的结论：全部由 lab.js 算，页面不算任何一笔
    const report = lab.buildLabReport(list, DEFAULT_RULES);

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

    this.setData({
      loading: false,
      report,
      cells,
      styles,
      stale: from === "local",
      bookEmpty: list.length === 0,
      lastRecord: list.length === 0
        ? "还没有记过"
        : `${list[0].date}（${list[0].signalTime || "时间未记"} 记了 ${list[0].trades.length} 笔）`,
    });
  },

  /** 手动刷新：云端账本 + 今天的精选（这两个必须有网络才有意义） */
  async load() {
    this.setData({ loading: true, error: "" });
    const r = await store.sync();
    this.render(r.days, r.from);

    // 今天的精选要现价和全市场，只能从云端算
    const rulesRes = await api.getRules();
    const rules = rulesRes.rules || DEFAULT_RULES;
    const held = (r.days || []).flatMap((d) => d.trades).map((t) => ({ id: t.id, style: t.style, exit: t.exit }));
    const today = (r.days || []).find((d) => d.date === shanghaiDate());
    const picksRes = await api.picks(rules, held, (today && today.trades) || []);

    const picks = (picksRes.picks || []).map((g) => ({
      name: (STYLES.find((s) => s.id === g.style) || {}).name || g.style,
      total: g.total,
      rows: g.rows.map((row) => ({
        name: row.quote.name,
        code: row.quote.code,
        price: fmtPrice(row.quote.price),
        chg: signedPct(row.quote.chg),
        chgCls: (row.quote.chg || 0) > 0 ? "p-up" : (row.quote.chg || 0) < 0 ? "p-down" : "p-mute",
        buy: fmtPrice(row.buy),
        sell: fmtPrice(row.sell),
        stop: fmtPrice(row.stop),
      })),
    }));

    this.setData({
      loading: false,
      picks,
      pickedAt: picksRes.at ? new Date(picksRes.at).toLocaleTimeString("zh-CN", { hour12: false }) : "",
      error: picksRes.error || "",
    });
  },

  /**
   * 手动记一次。跑的和定时触发器是同一个 record 云函数——
   * 区别只是这次是你点的，不是到点自动跑的。
   * 记账本来就不该依赖「你正好打开着小程序」，所以 onLoad 已经先静默跑过一次。
   */
  async onRunRecord() {
    if (this.data.recording) return;
    this.setData({ recording: true });
    wx.showLoading({ title: "正在跑策略…" });
    const res = await api.runRecord();
    wx.hideLoading();
    this.setData({ recording: false });

    if (res.error) {
      wx.showToast({ title: res.error, icon: "none" });
      return;
    }
    if (res.skipped) {
      wx.showModal({ title: "今天不用记", content: res.skipped, showCancel: false });
      return;
    }
    store.setMeta({ lastRecordDate: shanghaiDate() });
    wx.showModal({
      title: "记完了",
      content: `新记 ${res.buys.recorded} 笔 · 卖出 ${res.settled.sold} 笔${res.settled.blocked ? ` · 跌停顺延 ${res.settled.blocked} 笔` : ""}`,
      showCancel: false,
    });
    this.load();
  },

  onPullSeed() {
    this.load();
  },
});
