#!/usr/bin/env node
/**
 * 运维四件大件的**只读**体检。不写任何文件、不改账本、不碰 AI 接口。
 *
 * 为什么要有它（2026-11-06）：四件大件（账本存储 / 流水轮转 / AI 超时 / 深扫复盘）
 * 等用户拍板，拍板前先把底数量化下来、留个可复跑的出处。以前这些数字散在
 * 临时 python 片段里，下周复盘时没法核对是不是同一口径。
 *
 * 用法：node scripts/ops-check.mjs
 * 输出只打印聚合指标；**任何密钥、token、apiKey 都不读不打印**（AI 配置只读条数）。
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA = process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
const lines = (p) => {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter((l) => l.trim());
};
const jsonLines = (p) => {
  const out = [];
  for (const l of lines(p)) {
    try { out.push(JSON.parse(l)); } catch { /* 坏行跳过，和 gate-log.ts 同一取舍 */ }
  }
  return out;
};
const pct = (n) => `${(n * 100).toFixed(2)}%`;
const mb = (n) => `${(n / 1024 / 1024).toFixed(2)} MB`;

// ── 1. 账本 ────────────────────────────────────────────────
console.log("【1】账本（JSON → SQLite 决策用）");
const bookPath = join(DATA, "books", "dev-user.json");
if (existsSync(bookPath)) {
  const b = JSON.parse(readFileSync(bookPath, "utf8"));
  const days = Array.isArray(b.days) ? b.days : [];
  const trades = days.flatMap((d) => (Array.isArray(d.trades) ? d.trades : []));
  const open = trades.filter((t) => t && t.exit == null).length;
  console.log(`  文件 ${statSync(bookPath).size} 字节（${mb(statSync(bookPath).size)}）· ${days.length} 天 · ${trades.length} 笔 · 未结 ${open}`);
  console.log(`  写入方式：writeUserBook 整本读改写 + tmp + rename（临时名带 pid+随机数）`);
  console.log(`  ⚠️ 未防「A 读 → B 读 → A 写 → B 写」的丢更新；这是现存真风险，与存储引擎无关`);
} else console.log("  读不到 dev-user.json（拿不到 ≠ 没有，不拿 0 顶替）");

// ── 2. 流水 ────────────────────────────────────────────────
console.log("\n【2】流水 gate-blocks.jsonl（轮转决策用）");
const gatePath = join(DATA, "gate-blocks.jsonl");
const rows = jsonLines(gatePath);
if (rows.length > 0) {
  const bytes = statSync(gatePath).size;
  const dates = rows.map((r) => r.tradingDate).filter(Boolean).sort();
  const byDay = {};
  for (const d of dates) byDay[d] = (byDay[d] ?? 0) + 1;
  const daily = Object.values(byDay).sort((a, b) => a - b);
  const uniq = new Set(rows.map((r) => JSON.stringify([r.tradingDate, r.gate, r.style, r.reason, r.candidates ?? []])));
  console.log(`  ${mb(bytes)} · ${rows.length} 行 · ${dates[0]} ~ ${dates[dates.length - 1]}（${Object.keys(byDay).length} 个交易日）`);
  console.log(`  每日行数 min/中位/max：${daily[0]} / ${daily[Math.floor(daily.length / 2)]} / ${daily[daily.length - 1]}`);
  console.log(`  按大小估增速：${(bytes / rows.length * daily[Math.floor(daily.length / 2)] / 1024).toFixed(1)} KB/天 ≈ ${(bytes / rows.length * daily[Math.floor(daily.length / 2)] * 250 / 1024 / 1024).toFixed(1)} MB/年`);
  const dup = 1 - uniq.size / rows.length;
  console.log(`  唯一签名 ${uniq.size} / ${rows.length} —— 重复率 ${pct(dup)}`);
  console.log(dup > 0.2
    ? `  🔴 仍有大量重复：提示闸标志在每分钟新起的记账进程里重置（见 REMAINING.md §12.2）`
    : `  ✅ 2026-11-06 已落地按天去重（appendGateLog 落盘判重），历史 6789 行压到 222 行；这行数不再随时间涨`);
} else console.log("  读不到 gate-blocks.jsonl");

// ── 3. AI 超时 ─────────────────────────────────────────────
console.log("\n【3】AI 超时（治理决策用）");
const usage = (() => {
  try {
    const d = JSON.parse(readFileSync(join(DATA, "ai-usage.json"), "utf8"));
    return Array.isArray(d) ? d : d.entries ?? [];
  } catch { return []; }
})();
const log = (() => { try { const d = JSON.parse(readFileSync(join(DATA, "ai-log.json"), "utf8")); return d.entries ?? []; } catch { return []; } })();
if (usage.length > 0) {
  const ms = usage.map((e) => e.ms).filter((x) => typeof x === "number").sort((a, b) => a - b);
  const bad = usage.filter((e) => e.ok === false);
  const timedOut = bad.filter((e) => (e.ms ?? 0) >= 149000);
  const q = (p) => (ms[Math.min(ms.length - 1, Math.floor(ms.length * p))] / 1000).toFixed(1);
  console.log(`  ai-usage ${usage.length} 次 · 失败 ${bad.length}（${pct(bad.length / usage.length)}）· 其中 ≥149s 超时被掐 ${timedOut.length} 次`);
  console.log(`  耗时 中位 ${q(0.5)}s / p90 ${q(0.9)}s / p95 ${q(0.95)}s / max ${(ms[ms.length - 1] / 1000).toFixed(1)}s`);
  console.log(`  ai-log 只记 ${log.filter((e) => !e.ok).length} 条失败 / ${log.length} 轮 —— 🔴 fallback 成功后整轮算 ok，中间超时被掩盖`);
  console.log(`  DSH 通道：${process.env.CHIHENG_DSH_URL ? "已启用" : "未启用"}；callDSH 已补 AbortSignal.timeout（11-06 修，此前裸 fetch 会拖死整轮）`);
  // 轮级尝试账本：fallback 成功不再把中间超时洗成 ok
  const rounds = (() => { try { const d = JSON.parse(readFileSync(join(DATA, "ai-attempts.json"), "utf8")); return d.rounds ?? []; } catch { return []; } })();
  if (rounds.length > 0) {
    const silent = rounds.filter((r) => r.ok && (r.failed ?? 0) > 0).length;
    const failed = rounds.reduce((n, r) => n + (r.failed ?? 0), 0);
    const to = rounds.reduce((n, r) => n + (r.timedOut ?? 0), 0);
    console.log(`  ai-attempts ${rounds.length} 轮 · 中间失败 ${failed} 次（超时 ${to}）· 🔴 成功但中途挂过 ${silent} 轮`);
  } else {
    console.log(`  ai-attempts 账本还是空的（11-06 新增，下一次 AI 调用起才有数据）`);
  }
} else console.log("  读不到 ai-usage.json");

// ── 4. 深扫 ────────────────────────────────────────────────
console.log("\n【4】深扫样本（下周复盘用）");
if (existsSync(bookPath)) {
  const b = JSON.parse(readFileSync(bookPath, "utf8"));
  const deep = [];
  for (const d of b.days ?? []) {
    for (const t of d.trades ?? []) {
      if (t && t.deepScan) deep.push({ date: d.date, ...t });
    }
  }
  const closed = deep.filter((t) => typeof t.exit === "number");
  const rets = closed.map((t) => t.exit / t.entry - 1);
  const stops = closed.filter((t) => t.exitReason === "stop").length;
  console.log(`  深扫票 ${deep.length} 笔 · 已平 ${closed.length} · 未平 ${deep.length - closed.length}`);
  if (rets.length > 0) {
    console.log(`  已平平均 ${pct(rets.reduce((a, b) => a + b, 0) / rets.length)} · 止损 ${stops}/${closed.length}`);
    console.log(`  ⚠️ 样本 ${rets.length} 笔，远不够下结论；DECISIONS #4 承诺的「判决注明含深扫 N 笔」分层归因尚未落地`);
  }
  console.log(`  分层统计：只读，不接进判决（等拍板）`);
}

// ── 5. 备份验活 ────────────────────────────────────────────
// 2026-11-06 补：上一版只说「目录里有 23:15 快照」，把手动测试留下的文件
// 当成定时任务活着，误报「全绿」。教训（OPS.md）：验活认 launchctl print 的
// last exit code，不能看目录。但光看 exit code 也不够——kickstart 手动跑成功
// 同样是 0；要真正确认「定时触发成功」，还得看 23:30 那个点的日志/快照。
console.log("\n【5】备份任务验活（只看目录会假阳性）");
const backupRoot = join(homedir(), "chiheng-backup");
let snaps = [];
try { snaps = readdirSync(backupRoot).filter((n) => n.startsWith("full-")).sort(); } catch { /* 读不到就说读不到 */ }
console.log(`  快照目录 ${snaps.length} 份，最新：${snaps.at(-1) ?? "（读不到，不等于没有）"}`);
let lastExit = "拿不到";
try {
  const printed = execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/com.chiheng.backup`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  const m = printed.match(/last exit code\s*=\s*(\d+)/);
  if (m) lastExit = m[1];
} catch { /* launchctl 不让查就明写拿不到，不拿 0 顶替 */ }
console.log(`  launchctl last exit code = ${lastExit}${lastExit === "0" ? "（也可能是 kickstart 手动跑出来的，不等于定时触发过）" : ""}`);
const timed = snaps.filter((n) => /-23(2[5-9]|3[0-5])$/.test(n));
console.log(`  23:30 定时触发留下的快照（名字带 2330 左右）：${timed.length ? timed.join(", ") : "🔴 一份都没有 —— 定时任务从未成功触发过"}`);
console.log(`  明早验活三件套：日志 ~/Library/Logs/chiheng-backup.log 有 23:30 新行 + 快照名带 2330 + last exit code=0`);

// ── 6. 定时任务验活（2026-11-06：备份那个假阳性之后加的）──────
// 只看「目录里有快照」或「last exit code=0」都会误报：前者可能是手动跑的，
// 后者也可能是 kickstart。这里额外查 plist 文件在不在，把幽灵 job 揪出来。
console.log("\n【6】定时任务（看 job + plist，别看目录）");
const jobs = ["com.chiheng.serve", "com.chiheng.tunnel", "com.chiheng.verdict", "com.chiheng.backup"];
const laDir = join(homedir(), "Library", "LaunchAgents");
for (const job of jobs) {
  const plist = join(laDir, `${job}.plist`);
  const hasPlist = existsSync(plist);
  let exit = "拿不到";
  let state = "拿不到";
  try {
    const printed = execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${job}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const m = printed.match(/last exit code\s*=\s*(\d+)/);
    if (m) exit = m[1];
    const s = printed.match(/state = (running|not running)/);
    if (s) state = s[1];
  } catch { /* job 没加载就明写拿不到 */ }
  const loaded = exit !== "拿不到";
  let tag = "";
  if (!loaded && !hasPlist && job === "com.chiheng.verdict") tag = "  ← ✅ 已卸载（11-06 拍板，预期状态）";
  else if (!loaded && !hasPlist) tag = "  ← 未加载且无 plist（确认是否预期）";
  else if (loaded && !hasPlist) tag = "  ← 🔴 幽灵 job（plist 不在但内存里还挂着）";
  else if (hasPlist && !loaded) tag = "  ← ⚠️ 有 plist 但 job 没加载";
  console.log(`  ${job.padEnd(24)} plist=${hasPlist ? "在" : "不在"} exit=${exit} state=${state}${tag}`);
}
console.log(`  每日判决只走 record-journal 收盘封印 → auto-verdict.ts（15:08，当日 stamp 防重）`);
console.log(`  verdict 的 16:10 重复跑已消除；data/verdict.log 留作手动刷判决的历史日志`);

console.log("\n（只读体检结束：未写任何文件。四件大件的拍板选项见 design/REMAINING.md §12）");
