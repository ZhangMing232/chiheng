/**
 * 这个文件是干什么的：
 * 消息页。上面把快讯分成利好、利空两栏并给板块/个股打上持仓、精选标记，
 * 下面是按时间排的电报，利好在前。
 *
 * 注意：
 * 利好利空只看快讯用词，不是研报，也不改买入价。归类逻辑在 lib/market/news.ts，
 * 从 web 版搬过来的。
 */
const api = require("../../lib/api.js");
const store = require("../../lib/store.js");
const { signedPct } = require("../../lib/market/format.js");

const TONE_LABEL = { good: "利好", bad: "利空", flat: "未表态" };

/** 把一批快讯按立场归类，顺带数板块和个股各被点名几次。 */
function tally(items, tone) {
  const boards = new Map();
  const stocks = new Map();
  for (const item of items) {
    if (item.tone !== tone) continue;
    for (const b of item.boards || []) {
      const row = boards.get(b.code) || { code: b.code, name: b.name, n: 0 };
      row.n += 1;
      boards.set(b.code, row);
    }
    for (const s of item.stocks || []) {
      const row = stocks.get(s.id) || { id: s.id, name: s.name, code: s.code, chg: s.chg, n: 0 };
      row.n += 1;
      stocks.set(s.id, row);
    }
  }
  const byCount = (a, b) => b.n - a.n;
  return {
    boards: [...boards.values()].sort(byCount).map((b) => ({ name: b.name, n: b.n })),
    stocks: [...stocks.values()].sort(byCount).map((s) => ({
      name: s.name,
      code: s.code,
      chg: s.chg,
      chgText: signedPct(s.chg),
      chgCls: (s.chg || 0) > 0 ? "up" : (s.chg || 0) < 0 ? "down" : "muted",
    })),
  };
}

Page({
  data: {
    theme: "dark",
    loading: true,
    error: "",
    stale: false,
    needDeploy: "",
    good: { boards: [], stocks: [] },
    bad: { boards: [], stocks: [] },
    tape: [],
  },

  onLoad() {
    this.setData({ theme: getApp().globalData.theme });
    // 先画上次抓到的快讯（同步，不等网络），再拉新的替换
    const c = store.cached("news", () => api.news());
    if (c.cached) this.paint(c.cached.data || [], "", true, "");
    c.refresh().then((res) => this.paint(res.data || [], res.error || "", false, res.needDeploy));
  },

  onPullDownRefresh() {
    store
      .cached("news", () => api.news())
      .refresh()
      .then((res) => {
        this.paint(res.data || [], res.error || "", false, res.needDeploy);
        wx.stopPullDownRefresh();
      });
  },

  paint(items, error, stale, needDeploy) {
    this.setData({ loading: false, error, stale, needDeploy: needDeploy || "" });
    const rank = (x) => (x.tone === "good" ? 0 : x.tone === "bad" ? 1 : 2);
    const ordered = [...items].sort((a, b) => rank(a) - rank(b));

    this.setData({
      good: tally(items, "good"),
      bad: tally(items, "bad"),
      tape: ordered.map((it) => ({
        id: it.id,
        time: (it.time || "").slice(11, 16),
        date: (it.time || "").slice(5, 10),
        tone: TONE_LABEL[it.tone] || "未表态",
        toneCls: it.tone === "good" ? "p-up" : it.tone === "bad" ? "p-down" : "p-mute",
        title: it.title,
        summary: it.summary && it.summary !== it.title ? it.summary : "",
        boards: (it.boards || []).map((b) => b.name),
        stocks: (it.stocks || []).map((s) => ({ name: s.name, chg: signedPct(s.chg) })),
      })),
    });
  },
});
