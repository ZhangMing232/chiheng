/**
 * 这个文件是干什么的：
 * 抓行情的云函数。小程序里所有外部数据都从这里出。
 *
 * 为什么必须走云函数：
 * 小程序 wx.request 只能请求在后台登记过的域名，登记时要往那个域名根目录
 * 放一个微信的校验文件。qt.gtimg.cn 是腾讯的服务器，我们放不进去，
 * 所以行情接口永远进不了白名单——只能让云函数去抓，小程序拿云函数的结果。
 *
 * 为什么要缓存到数据库：
 * 云函数的内存不跨实例。这次请求落在 A 实例、下次落在 B 实例，A 缓存的东西
 * B 看不到。所以缓存写在数据库里，实例之间才共享。
 *
 * 另一个坑：别把全市场 4600 只票一股脑返回给小程序。云函数返回有大小限制，
 * 而且小程序也用不了那么多。所以「选股」这一步在云函数里就做完，
 * 只回每套策略的精选（十几只）。
 */
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const { fetchUniverse, fetchIndices } = require("./market/providers/index.js");
const { loadFlow } = require("./market/flow.js");
const { loadNews, loadStockArticles, searchStocks } = require("./market/news.js");
const { loadHotMoney } = require("./market/hotmoney.js");
const { loadIndexFutures } = require("./market/index-futures.js");
const { ACTIVE_STYLES, watchList, takeBuys } = require("./market/strategies.js");
const { limitTag } = require("./market/model.js");

const DEFAULT_RULES = require("./market/rules.js").DEFAULT_RULES;
const INDEX_IDS = ["sh000001", "sz399001", "sz399006", "sh000300"];

/** 按 key 缓存到 cache 集合。ttl 单位是分钟。 */
async function cached(key, ttlMinutes, producer) {
  const col = db.collection("cache");
  let hit = null;
  try {
    const res = await col.doc(key).get();
    hit = res.data;
  } catch {
    hit = null; // 没有这条缓存，正常
  }
  const now = Date.now();
  if (hit && now - hit.at < ttlMinutes * 60000) {
    return { data: hit.data, at: hit.at, cached: true };
  }
  const fresh = await producer();
  const doc = { at: now, data: fresh };
  try {
    await col.doc(key).set({ data: doc });
  } catch {
    // 第一次写，用 add 也行；set 在某些版本对不存在的 doc 报错，这里兜住
    await col.add({ data: Object.assign({ _id: key }, doc) });
  }
  return { data: fresh, at: now, cached: false };
}

/** 精简一只票：只留页面要显示的字段，别把整个 quote 对象丢回去 */
function slim(quote) {
  return {
    id: quote.id,
    code: quote.code,
    name: quote.name,
    price: quote.price,
    chg: quote.chg,
    board: quote.board,
    amount: quote.amount,
    turnover: quote.turnover,
    pe: quote.pe,
    pb: quote.pb,
    cap: quote.cap,
  };
}

/** 云函数里把选股做完：拉全市场 → 每套策略各取十几只 → 只回这些 */
async function picks(rules, held, dayTrades) {
  const uni = await cached("universe", 3, fetchUniverse);
  const quotes = uni.data.quotes || [];
  const out = [];
  for (const style of ACTIVE_STYLES) {
    const list = watchList(quotes, style, rules || DEFAULT_RULES, () => true);
    const buys = takeBuys(list, held || [], style, dayTrades || []);
    out.push({
      style,
      total: list.length,
      rows: buys.map((row) => ({
        quote: slim(row.quote),
        buy: row.buy,
        sell: row.sell,
        stop: row.stop,
        score: row.score,
        reasons: row.reasons,
      })),
    });
  }
  return { picks: out, at: uni.at, idle: quotes.length === 0 };
}

exports.main = async (event) => {
  const action = event.action;
  try {
    switch (action) {
      case "picks":
        return await picks(event.rules, event.held, event.dayTrades);

      // 持仓页要现价：只回它手上那几只，别把全市场拖回去
      case "quotes": {
        const uni = await cached("universe", 3, fetchUniverse);
        const want = new Set(event.ids || []);
        const rows = (uni.data.quotes || []).filter((q) => want.has(q.id)).map(slim);
        return { rows, at: uni.at, marketIdle: (uni.data.quotes || []).length === 0 };
      }

      case "indices": {
        const res = await cached("indices", 2, () => fetchIndices(INDEX_IDS));
        return res;
      }

      case "flow": {
        const res = await cached("flow", 3, loadFlow);
        // 涨跌家数不在资金数据里，得另来一份全市场行情。这里从同一个
        // 3 分钟缓存里取，不额外抓一次——两份缓存的 TTL 一样，天然对齐
        const uni = await cached("universe", 3, fetchUniverse);
        const quotes = uni.data.quotes || [];
        return Object.assign({}, res, {
          breadth: {
            up: quotes.filter((q) => (q.chg || 0) > 0).length,
            down: quotes.filter((q) => (q.chg || 0) < 0).length,
            limitUp: quotes.filter((q) => limitTag(q) === "涨停").length,
            limitDown: quotes.filter((q) => limitTag(q) === "跌停").length,
          },
        });
      }

      case "news":
        return await cached("news", 5, loadNews);

      case "hot":
        return await cached("hot", 30, loadHotMoney);

      case "futures":
        return await cached("futures", 60, loadIndexFutures);

      case "symbol":
        return { articles: await loadStockArticles(event.id) };

      case "search":
        return { matches: await searchStocks(event.q || "") };

      default:
        return { error: "没有这个 action：" + action };
    }
  } catch (err) {
    // 出错也返回结构，别让小程序那边拿到一个 undefined 然后白屏
    return { error: String((err && err.message) || err), action };
  }
};
