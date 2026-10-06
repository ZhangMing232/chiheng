/**
 * 这个文件是干什么的：
 * 页面调云函数的唯一入口。每个页面都从这里拿数据，不自己 wx.cloud.callFunction。
 *
 * 为什么要包一层：
 * 云函数返回的是 { result: {...} }，出错时错误藏在 result.error 里。
 * 不统一处理的话，每个页面都要写一遍同样的判断和提示，而且很容易
 * 拿到一个 undefined 然后整页白屏——这里的规矩是：**出错也要有返回值**，
 * 页面照常渲染（空态或错误态），不许白屏。
 */
const { ENV_ID } = require("../config.js");

function call(name, data) {
  return wx.cloud
    .callFunction({ name, data })
    .then((res) => {
      const r = res && res.result;
      if (!r) return { error: "云函数没有返回内容" };
      return r;
    })
    .catch((err) => ({ error: String((err && err.message) || err) }));
}

module.exports = {
  ENV_ID,

  /** 云函数里算好的选股结果，只回每套策略的精选 */
  picks: (rules, held, dayTrades) => call("quote", { action: "picks", rules, held, dayTrades }),

  /** 手上那几只的现价 */
  quotes: (ids) => call("quote", { action: "quotes", ids }),

  indices: () => call("quote", { action: "indices" }),
  flow: () => call("quote", { action: "flow" }),
  news: () => call("quote", { action: "news" }),
  hot: () => call("quote", { action: "hot" }),
  futures: () => call("quote", { action: "futures" }),
  symbol: (id) => call("quote", { action: "symbol", id }),
  search: (q) => call("quote", { action: "search", q }),

  readBook: () => call("book", { action: "read" }),
  getRules: () => call("book", { action: "getRules" }),
};
