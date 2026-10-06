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
let ok = true;
for (const [name, pass] of checks) {
  console.log((pass ? "  ✓ " : "  ✗ ") + name);
  if (!pass) ok = false;
}
console.log(ok ? "\n全部通过" : "\n有没过的，先修再往下走");
process.exit(ok ? 0 : 1);
