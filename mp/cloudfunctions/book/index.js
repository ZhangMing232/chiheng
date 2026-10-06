/**
 * 这个文件是干什么的：
 * 账本的读写。web 版是读写 data/books/*.json（见 src/lib/market/book-file.ts），
 * 这里换成云数据库，一个用户一天一条记录。
 *
 * 集合设计：
 *   days   { _openid, date, signalTime, indexEntry, indexExit, trades: [] }
 *   rules  { _openid, ...规则 }
 *
 * 为什么按 openid 分：
 * 云开发数据库默认「仅创建者可读写」，openid 是云函数里拿到的，
 * 每个人只看到自己的账。自用场景其实只有你一个用户，但这层别省——
 * 哪天想给家里人用，不用重写。
 */
const cloud = require("wx-server-sdk");
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DEFAULT_RULES = require("./market/rules.js").DEFAULT_RULES;

async function readDays(openid) {
  // 一次最多 100 条，自用几年都够；真超了再说分页
  const res = await db.collection("days").where({ _openid: openid }).orderBy("date", "desc").limit(100).get();
  return res.data;
}

/** 记一天。同一天重复调用只补新的成交，不覆盖已有的——和 web 版 recordDay 一个规矩。 */
async function record(openid, day) {
  const col = db.collection("days");
  const exist = await col.where({ _openid: openid, date: day.date }).limit(1).get();
  if (exist.data.length === 0) {
    await col.add({ data: Object.assign({ _openid: openid }, day) });
    return { added: day.trades.length };
  }
  const doc = exist.data[0];
  const seen = new Set(doc.trades.map((t) => `${t.style || ""}:${t.id}`));
  const extras = day.trades.filter((t) => !seen.has(`${t.style || ""}:${t.id}`));
  if (extras.length === 0) return { added: 0 };
  await col.doc(doc._id).update({ data: { trades: _.push(extras) } });
  return { added: extras.length };
}

/** 记卖出。同一只、同一天只认第一次——卖掉就是卖掉了，改不得。 */
async function settle(openid, date, id, exit, exitDate, entry) {
  const col = db.collection("days");
  const found = await col.where({ _openid: openid, date }).limit(1).get();
  if (found.data.length === 0) return { updated: 0 };
  const doc = found.data[0];
  const trades = doc.trades.map((t) => {
    if (t.id !== id || t.exit != null) return t;
    return Object.assign({}, t, { entry: entry > 0 ? entry : t.entry, exit, exitDate });
  });
  await col.doc(doc._id).update({ data: { trades } });
  return { updated: 1 };
}

/** 记沪深300 的对照价。没有它就算不出「有没有跑赢指数」，实验台会一直说拿不到。 */
async function settleIndex(openid, date, indexExit) {
  const col = db.collection("days");
  const found = await col.where({ _openid: openid, date }).limit(1).get();
  if (found.data.length === 0) return { updated: 0 };
  const doc = found.data[0];
  if (doc.indexExit != null) return { updated: 0 };
  await col.doc(doc._id).update({ data: { indexExit } });
  return { updated: 1 };
}

async function getRules(openid) {
  const res = await db.collection("rules").where({ _openid: openid }).limit(1).get();
  return res.data.length > 0 ? res.data[0].rules : DEFAULT_RULES;
}

async function setRules(openid, rules) {
  const col = db.collection("rules");
  const found = await col.where({ _openid: openid }).limit(1).get();
  if (found.data.length === 0) await col.add({ data: { _openid: openid, rules } });
  else await col.doc(found.data[0]._id).update({ data: { rules } });
  return { ok: true };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const action = event.action;
  try {
    switch (action) {
      case "read":
        return { days: await readDays(OPENID) };
      case "record":
        return await record(OPENID, event.day);
      case "settle":
        return await settle(OPENID, event.date, event.id, event.exit, event.exitDate, event.entry);
      case "settleIndex":
        return await settleIndex(OPENID, event.date, event.indexExit);
      case "getRules":
        return { rules: await getRules(OPENID) };
      case "setRules":
        return await setRules(OPENID, event.rules);
      default:
        return { error: "没有这个 action：" + action };
    }
  } catch (err) {
    return { error: String((err && err.message) || err), action };
  }
};
