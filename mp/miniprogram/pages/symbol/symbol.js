/**
 * 这个文件是干什么的：
 * 个股页。上面一个搜索框：搜代码或名称看那一只；不搜就列出手上持仓的票，
 * 有利空的排在前面（web 版的规矩）。
 */
const api = require("../../lib/api.js");

const KIND_LABEL = { news: "资讯", ann: "公告" };
const TONE_LABEL = { good: "利好", bad: "利空", flat: "未表态" };

function articleView(a) {
  return {
    id: a.id,
    kind: KIND_LABEL[a.kind] || "资讯",
    tone: TONE_LABEL[a.tone] || "未表态",
    toneCls: a.tone === "good" ? "p-up" : a.tone === "bad" ? "p-down" : "p-mute",
    title: a.title,
    time: (a.time || "").slice(5, 16),
    url: a.url || "",
  };
}

function tally(articles) {
  return {
    bad: articles.filter((a) => a.tone === "bad").length,
    good: articles.filter((a) => a.tone === "good").length,
    ann: articles.filter((a) => a.kind === "ann").length,
  };
}

Page({
  data: {
    theme: "dark",
    q: "",
    input: "",
    loading: false,
    error: "",
    needDeploy: "",
    matches: [],
    groups: [],
  },

  onLoad() {
    this.setData({ theme: getApp().globalData.theme });
    this.loadHeld();
  },

  onInput(e) {
    this.setData({ input: e.detail.value });
  },

  onSearch() {
    const q = (this.data.input || "").trim();
    this.setData({ q, matches: [], groups: [] });
    if (!q) {
      this.loadHeld();
      return;
    }
    this.pick(q);
  },

  onPickMatch(e) {
    const code = e.currentTarget.dataset.code;
    this.setData({ q: code, input: code, matches: [] });
    this.pick(code);
  },

  async pick(q) {
    this.setData({ loading: true, error: "" });
    // 先搜出候选，命中多只时给一排按钮
    const s = await api.search(q);
    const matches = s.matches || [];
    if (matches.length > 1) {
      this.setData({ loading: false, matches });
      return;
    }
    const id = matches.length === 1 ? matches[0].id : q;
    this.loadArticles(id, matches[0] || null);
  },

  async loadHeld() {
    this.setData({ loading: true, error: "" });
    const res = await api.readBook();
    const days = res.days || [];
    const seen = new Set();
    const held = [];
    for (const d of days) {
      for (const t of d.trades) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        held.push({ id: t.id, name: t.name, code: t.code, exit: t.exit });
      }
    }
    if (held.length === 0) {
      this.setData({ loading: false, groups: [] });
      return;
    }
    const groups = [];
    for (const h of held) {
      const r = await api.symbol(h.id);
      const articles = (r.articles || []).map(articleView);
      const c = tally(articles);
      groups.push({
        id: h.id,
        title: `${h.name} ${h.code}`,
        counts: `利空 ${c.bad} · 利好 ${c.good} · 公告 ${c.ann}`,
        hasBad: c.bad > 0,
        articles,
      });
    }
    groups.sort((a, b) => Number(b.hasBad) - Number(a.hasBad));
    this.setData({ loading: false, groups, error: res.error || "" });
  },

  async loadArticles(id, match) {
    this.setData({ loading: true, error: "" });
    const r = await api.symbol(id);
    const articles = (r.articles || []).map(articleView);
    const c = tally(articles);
    this.setData({
      loading: false,
      error: r.error || "",
      groups: [
        {
          id,
          title: match ? `${match.name} ${match.code}` : id,
          counts: articles.length ? `利空 ${c.bad} · 利好 ${c.good} · 公告 ${c.ann}` : "暂时没有消息",
          hasBad: c.bad > 0,
          articles,
        },
      ],
    });
  },

  onOpenArticle(e) {
    const url = e.currentTarget.dataset.url;
    if (!url) return;
    wx.setClipboardData({ data: url, success: () => wx.showToast({ title: "链接已复制", icon: "none" }) });
  },
});
