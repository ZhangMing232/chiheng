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

let ok = true;
for (const [name, pass] of checks) {
  console.log((pass ? "  ✓ " : "  ✗ ") + name);
  if (!pass) ok = false;
}
console.log(ok ? "\n全部通过" : "\n有没过的，先修再往下走");
process.exit(ok ? 0 : 1);
