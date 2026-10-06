/**
 * 这个文件是干什么的：
 * 资金页。概览四个数（涨跌家数、两市成交额、主力、北向），下面是大盘资金明细、
 * 行业和个股净流入流出。红是净流入，绿是净流出——这是项目一直的约定，别改。
 */
const api = require("../../lib/api.js");
const { readMarket } = require("../../lib/market/flow.js");
const { fmtWan, signedPct } = require("../../lib/market/format.js");

function tone(v) {
  return v > 0 ? "up" : v < 0 ? "down" : "muted";
}

Page({
  data: {
    theme: "dark",
    loading: true,
    error: "",
    needDeploy: "",
    tiles: null,
    notes: [],
    sectorsIn: [],
    sectorsOut: [],
    stocksIn: [],
    stocksOut: [],
    north: [],
    northTotal: "—",
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
    const res = await api.flow();
    const book = res.data;
    if (!book) {
      this.setData({ loading: false, error: res.error || "资金流向暂时拉不下来" });
      return;
    }

    const amount = (book.tape || []).reduce((s, r) => s + r.amount, 0);
    const parts = book.market || [];
    const main = parts.length ? parts.reduce((s, p) => s + p.main, 0) : null;
    const share = amount > 0 && main != null ? (main / amount) * 100 : null;
    const northTotal = (book.north || []).reduce((s, l) => s + l.amount, 0);

    this.setData({
      loading: false,
      error: res.error || "",
      tiles: {
        up: (book.breadth && book.breadth.up) || "—",
        down: (book.breadth && book.breadth.down) || "—",
        limits: book.breadth ? `涨停 ${book.breadth.limitUp} · 跌停 ${book.breadth.limitDown}` : "全市场行情没拉下来",
        amount: amount > 0 ? fmtWan(amount) : "—",
        mainText: main == null ? "—" : fmtWan(main),
        mainCls: tone(main),
        mainLabel: main == null ? "主力" : main > 0 ? "主力净流入" : main < 0 ? "主力净流出" : "主力持平",
        share: share == null ? "占成交额 —" : `占成交额 ${Math.abs(share).toFixed(2)}%`,
        north: northTotal > 0 ? fmtWan(northTotal) : "—",
      },
      partNames: parts.map((p) => p.name),
      notes: readMarket(parts),
      sectorsIn: (book.sectorsIn || []).slice(0, 8).map(rowView),
      sectorsOut: (book.sectorsOut || []).slice(0, 8).map(rowView),
      stocksIn: (book.stocksIn || []).slice(0, 8).map(rowView),
      stocksOut: (book.stocksOut || []).slice(0, 8).map(rowView),
      north: (book.north || []).map((l) => ({ name: l.name, amount: fmtWan(l.amount), date: l.date })),
      northTotal: northTotal > 0 ? fmtWan(northTotal) : "—",
    });
  },
});

function rowView(row) {
  return {
    name: row.name,
    chg: signedPct(row.chg),
    inflow: fmtWan(row.inflow),
    inflowCls: tone(row.inflow),
    leader: row.leader || "",
  };
}
