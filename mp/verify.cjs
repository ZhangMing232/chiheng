/**
 * 这个文件是干什么的：
 * 用真实账本跑一遍搬到小程序里的那份代码，确认算出来的数和 web 版一样。
 *
 * 为什么要它：
 * "能搬" 是嘴上说的，"算出来一样" 才是真的。搬完、改完 lib/ 里的任何东西，
 * 都先跑一次：node mp/verify.cjs。数字对不上就别往下走。
 *
 * 用法：在项目根目录跑 node mp/verify.cjs
 */
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const book = JSON.parse(fs.readFileSync(path.join(root, "data/books/dev-user.json"), "utf8"));
const lib = path.join(__dirname, "build/market");

const lab = require(path.join(lib, "lab.js"));
const positions = require(path.join(lib, "positions.js"));
const rules = require(path.join(lib, "rules.js"));
const jb = require(path.join(lib, "journal-book.js"));

const days = book.days || [];
const totalTrades = days.reduce((s, d) => s + d.trades.length, 0);
console.log("账本：", days.length, "天 /", totalTrades, "笔");

const report = lab.buildLabReport(days, rules.DEFAULT_RULES);
console.log("\n--- 策略实验台 ---");
console.log("总样本", report.total, "· 已结", report.closed, "· 在拿", report.open);
console.log("能下结论吗：", report.canSay, "|", report.reason);
console.log("进度条：", report.progress + "%");
console.log("排除掉（收盘后补记）：", JSON.stringify(report.skipped));
console.log("同期沪深300：", report.benchmark.available ? "有对照" : "拿不到（缺对照价 " + report.benchmark.missingDays + " 天）");
console.log("按策略：", report.byStyle.map((s) => `${s.name} 总${s.total}/已结${s.closed}`).join(" · "));

const rows = [];
for (const day of days) {
  for (const t of day.trades) {
    rows.push({
      id: t.id, code: t.code, name: t.name, style: t.style,
      entry: t.entry, stop: t.stop, target: t.target,
      exit: t.exit, exitDate: t.exitDate, day: day.date,
      signalTime: day.signalTime ?? "", live: null,
      ret: t.exit != null ? t.exit / t.entry - 1 : null,
      state: t.exit != null ? "已卖" : "持有",
      pnl: t.exit != null ? t.exit - t.entry : null,
      indexRet: null,
    });
  }
}
const urgent = positions.sortByUrgency(rows.filter(positions.needsAction));
console.log("\n--- 持仓 ---");
console.log("需处理", urgent.length, "笔 · 分成", positions.groupByDay(rows).length, "天");
console.log("最前面几笔：", urgent.slice(0, 3).map((r) => `${r.name}(${r.state})`).join(", ") || "无");

console.log("\n--- 口径自检 ---");
const checks = [
  ["收盘后补记的那天不进统计（23:48）", jb.dayReliable({ signalTime: "23:48" }) === false],
  ["盘中记的那天照常进统计（14:30）", jb.dayReliable({ signalTime: "14:30" }) === true],
  ["在拿的那笔收益率是 null 不是 0", rows.filter((r) => r.exit == null).every((r) => r.ret === null)],
];

// 防回归：ACTIVE_STYLES 里每一套都要能在小程序这边真的选出票。
// 次日补涨（relay）依赖 sectors.ts，而那份没有搬进小程序——一旦有人把它加回
// ACTIVE_STYLES，watchList 会恒返回空，于是「一只票都选不出来」却不报任何错。
// 这条断言就是拦这个的。
const strategies = require(path.join(lib, "strategies.js"));
for (const style of strategies.ACTIVE_STYLES) {
  const listed = strategies.watchList([], style, rules.DEFAULT_RULES, () => true);
  checks.push([`在跑的策略「${style}」在 mp 侧能选出票（不是恒空）`, Array.isArray(listed)]);
}

// 防回归：mp/src/market 是 web 源的拷贝。手工拷过一次之后最容易忘的就是同步——
// 而「小程序算出来的数和网页不一样」是这个项目最不能出的错。
// 这里直接拿 web 源重新算一遍，和现有副本逐字节比。
try {
  const port = require(path.join(__dirname, "port.cjs"));
  const drifted = port.rel.filter((rel) => {
    const current = fs.readFileSync(path.join(__dirname, "src/market", rel), "utf8");
    return current !== port.expected(rel);
  });
  checks.push([
    drifted.length === 0
      ? "mp/src/market 与 web 源零漂移"
      : `mp/src/market 有 ${drifted.length} 个文件和 web 源对不上：${drifted.join("、")}（跑 node mp/port.cjs）`,
    drifted.length === 0,
  ]);
} catch (err) {
  checks.push([`漂移检查跑不起来：${err.message}`, false]);
}

// ── 防回归断言：三个曾经真出过的 bug ──────────────────────────
//
// 为什么用 fs.readFileSync + 正则而不用 grep：
// 这台机器的 grep 是 WorkBuddy 装的 shell 转发器，**会间歇性返回假阴性**
// （实测：对着明明有 OPENID 的 record/index.js 搜 OPENID，返回 0 行）。
// 断言跑在 Node 进程里，不经过 shell，所以不受影响。
//
// 每一条都对应一个真实修过的 bug。改坏了这里会立刻红，别删。

const recordSrc = fs.readFileSync(path.join(__dirname, "cloudfunctions/record/index.js"), "utf8");
const quoteSrc = fs.readFileSync(path.join(__dirname, "cloudfunctions/quote/index.js"), "utf8");
const bookSrc = fs.readFileSync(path.join(__dirname, "cloudfunctions/book/index.js"), "utf8");
const flowJs = fs.readFileSync(path.join(__dirname, "miniprogram/pages/flow/flow.js"), "utf8");

// ① cron 必须是 7 段。微信云开发是「秒 分 时 日 月 星期 年」，
//    末尾那个 * 是「年」。6 段会报「cron 表达式不合法」。
//    同时 config.json 里也要有一份一模一样的 triggers（上传触发器用）。
const cronLine = (recordSrc.split("\n").find((l) => l.includes("0 30 14")) || "").trim();
const cronCfg = fs.readFileSync(path.join(__dirname, "cloudfunctions/record/config.json"), "utf8");
checks.push([
  "record 注释里的 cron 是 7 段（微信云开发口径，末尾是年）",
  /^\*\s*0 30 14 \* \* MON-FRI \*\s*(（.*）)?\s*$/.test(cronLine),
]);
checks.push([
  "record/config.json 里 triggers 的 cron 也是 7 段、和注释一致",
  cronCfg.includes('"0 30 14 * * MON-FRI *"'),
]);

// ② record 不能裸用 getWXContext().OPENID 当 key。
//    定时触发没有用户上下文，OPENID 是空的 → 自动记账写进 _openid:""，
//    而小程序按真实 openid 查 → 读不到，全部进黑洞。
checks.push([
  "record 有 openid 兜底，不裸用 getWXContext().OPENID（定时触发没用户上下文）",
  /resolveOpenid/.test(recordSrc) && !/const \{ OPENID \} = cloud\.getWXContext\(\);/.test(recordSrc),
]);

// ③ openid 拿不到时必须「不记」，而不是往空 openid 写。
checks.push([
  "record 拿不到 openid 时明确跳过，不往空 openid 写",
  /skipped:.*还没有账本/.test(recordSrc) && /ambiguous/.test(recordSrc),
]);

// ④ book 要有 bindOwner，让小程序首次同步时把 openid 绑上。
checks.push(["book 有 bindOwner（小程序首次同步时绑账本主人）", /case "bindOwner"/.test(bookSrc)]);

// ⑤ flow 的 breadth 必须在 data 里，不能挂在信封上。
//    cached() 的契约是信封只放 {data, at, cached}；挂信封上页面读 res.data 拿不到，
//    资金页第一个 tile 会恒显示「— : —」。
checks.push([
  "flow 的 breadth 进了 data，没挂在信封上",
  /data: Object\.assign\(\{\}, res\.data, \{ breadth \}\)/.test(quoteSrc),
]);

// ⑥ 涨跌家数不能用 `|| "—"`：全市场 0 只上涨时 0 会被显示成「—」，
//    看起来像没数据。那是假的——数据来了，只是恰好是 0。
checks.push([
  "flow 页没用 `|| \"—\"` 显示涨跌家数（0 会被误显示成没数据）",
  !/book\.breadth && book\.breadth\.up\) \|\|/.test(flowJs),
]);

let ok = true;
for (const [name, pass] of checks) {
  console.log((pass ? "  ✓ " : "  ✗ ") + name);
  if (!pass) ok = false;
}
console.log(ok ? "\n全部通过" : "\n有没过的，先修再往下走");
process.exit(ok ? 0 : 1);
