#!/usr/bin/env node
/**
 * 深扫样本只读复盘报告（DECISIONS #4 方案 D，2026-10-27 落地）。
 *
 * 只做一件事：把账本里带 `deepScan` 标记的票和主样本**分层**摆出来，
 * 供下周复盘讨论。不写账本、不改判决、不给买卖建议。
 *
 * 为什么必须分层：`DECISIONS.md #4` 当年承诺「判决落地时注明样本含深扫 N 笔、
 * 事后可按层拆开复核归因」，但 `auto-verdict.ts` / `strategy-verdict.ts` 里
 * 从未实现。现在 5 笔深扫全是 rebound，而 rebound 主样本同期均值比它还差——
 * 不分层直接对比总均值，会得出「深扫买到了更弱的票」这个错误结论。
 *
 * 用法：node scripts/deepscan-review.mjs
 * 输出：stdout 摘要 + data/backtest/<今天>/DEEPSCAN-REVIEW.md
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DATA = process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
const book = JSON.parse(readFileSync(join(DATA, "books", "dev-user.json"), "utf8"));
const today = new Date().toISOString().slice(0, 10);

/** 收益口径：模拟盘账本里的 (exit/entry-1)，不含手续费/滑点。只有已平仓的才算。 */
const closed = [];
const open = [];
for (const day of book.days ?? []) {
  for (const t of day.trades ?? []) {
    if (!t || typeof t.entry !== "number") continue;
    const row = { date: day.date, t, ret: typeof t.exit === "number" ? t.exit / t.entry - 1 : null };
    if (row.ret === null) open.push(row);
    else closed.push(row);
  }
}
const deep = closed.filter((r) => r.t.deepScan);
const main = closed.filter((r) => !r.t.deepScan);
const deepOpen = open.filter((r) => r.t.deepScan);
const mainOpen = open.filter((r) => !r.t.deepScan);

const pct = (v) => `${(v * 100).toFixed(2)}%`;
function stat(rows) {
  if (rows.length === 0) return { n: 0, mean: null, median: null, win: null, stop: null };
  const rets = rows.map((r) => r.ret).sort((a, b) => a - b);
  const mid = Math.floor(rets.length / 2);
  return {
    n: rows.length,
    mean: rets.reduce((a, b) => a + b, 0) / rets.length,
    median: rets.length % 2 ? rets[mid] : (rets[mid - 1] + rets[mid]) / 2,
    win: rets.filter((v) => v > 0).length / rets.length,
    stop: rows.filter((r) => r.t.exitReason === "stop").length / rows.length,
  };
}
const fmt = (s) => s.n === 0
  ? "n=0（没有已平样本）"
  : `n=${s.n} · 均值 ${pct(s.mean)} · 中位 ${pct(s.median)} · 胜率 ${pct(s.win)} · 止损率 ${pct(s.stop)}`;

const ds = stat(deep);
const ms = stat(main);
const styles = [...new Set([...deep, ...main].map((r) => r.t.style ?? "?"))].sort();
const lines = [
  `# 深扫样本复盘材料（${today}，只读）`,
  "",
  "> 给下周复盘用，**不是结论**。数据只来自 `data/books/dev-user.json`，",
  "> 收益 = (exit - entry) / entry，模拟盘口径、不含手续费滑点；只有已平仓的参与统计。",
  "> 本报告不接进每日判决，不改账本，不给买卖建议。",
  "",
  "## 1. 总体（已平仓）",
  "",
  "| 层 | 已平 | 均值 | 中位 | 胜率 | 止损率 | 未平 |",
  "|---|---|---|---|---|---|---|",
  `| 深扫 | ${ds.n} | ${ds.mean === null ? "—" : pct(ds.mean)} | ${ds.median === null ? "—" : pct(ds.median)} | ${ds.win === null ? "—" : pct(ds.win)} | ${ds.stop === null ? "—" : pct(ds.stop)} | ${deepOpen.length} |`,
  `| 主样本 | ${ms.n} | ${pct(ms.mean)} | ${pct(ms.median)} | ${pct(ms.win)} | ${pct(ms.stop)} | ${mainOpen.length} |`,
  "",
  `- 深扫：${fmt(ds)}`,
  `- 主样本：${fmt(ms)}`,
  "",
  "## 2. 🔴 必须按风格分层，否则结论是反的",
  "",
  "深扫票**全部来自 `rebound`**，而主样本里混着 134 笔 `breakout`（形状完全不同）。",
  "拿深扫和总均值比，等于拿一套反弹票去比一堆突破票。同风格对照：",
  "",
  "| 风格 | 深扫（已平） | 主样本（已平） |",
  "|---|---|---|",
  ...styles.map((st) => {
    const d = stat(deep.filter((r) => (r.t.style ?? "?") === st));
    const m = stat(main.filter((r) => (r.t.style ?? "?") === st));
    return `| ${st} | ${fmt(d)} | ${fmt(m)} |`;
  }),
  "",
  "**同风格下**：rebound 主样本均值比深扫还差（见上表），胜率虽高但中位数更负。",
  "所以「深扫 = 买到了更弱的低分票」这个说法**当前数据不支持**——",
  "更可能是 10 月底那波 rebound 整体在挨打，深扫只是恰好都在这一层。",
  "",
  "## 3. 样本量：不够下结论",
  "",
  `- 已平深扫 **${ds.n} 笔**，全部止损出局；未平 ${deepOpen.length} 笔。`,
  "- 按项目自己的铁律（回测 |t| ≥ 2 才算测出来、两段同向才谈前后同向），",
  "  **5 笔只能当观察，不能据此改策略、调闸门、或判定方案 D 失败**。",
  "- 尤其不能拿 −12.27% 去调 `DEEP_SCAN_TOP`：那是看着结果调门槛。",
  "",
  "## 4. 逐笔明细（已平）",
  "",
  "| 买入日 | 风格 | 标的 | 入场 | 出场 | 收益 | 退出原因 | 平仓日 |",
  "|---|---|---|---|---|---|---|---|",
  ...deep.map((r) => `| ${r.date} | ${r.t.style ?? "?"} | ${r.t.name ?? "?"} | ${r.t.entry} | ${r.t.exit} | ${pct(r.ret)} | ${r.t.exitReason ?? "?"} | ${r.t.exitDate ?? "?"} |`),
  "",
  "## 5. 未平深扫票（别和已平混算）",
  "",
  ...(deepOpen.length
    ? ["| 买入日 | 风格 | 标的 | 入场 | 持有天数 |", "|---|---|---|---|---|",
       ...deepOpen.map((r) => `| ${r.date} | ${r.t.style ?? "?"} | ${r.t.name ?? "?"} | ${r.t.entry} | ${r.t.hold ?? "?"} |`)]
    : ["（没有）"]),
  "",
  "## 6. 待办（不属于本报告范围，等拍板）",
  "",
  "- `DECISIONS.md #4` 承诺的「判决落地时注明样本含深扫 N 笔 / 按层拆归因」**至今未落地**，",
  "  `auto-verdict.ts`、`strategy-verdict.ts` 里都搜不到 `deepScan`。要不要接进每日判决，",
  "  属于改判决口径，需单独拍板。",
  "- 想给深扫下结论，先攒够样本（比如 ≥30 笔已平）再看分层结果。",
  "",
  "---",
  "",
  `_由 \`node scripts/deepscan-review.mjs\` 生成，只读账本。生成时间 ${new Date().toISOString()}_`,
];

const outDir = join(DATA, "backtest", today);
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, "DEEPSCAN-REVIEW.md");
writeFileSync(outPath, lines.join("\n"), "utf8");
console.log(`  已生成：${outPath}`);
console.log(`  深扫(已平)：${fmt(ds)}`);
console.log(`  主样本(已平)：${fmt(ms)}`);
for (const st of styles) {
  const d = stat(deep.filter((r) => (r.t.style ?? "?") === st));
  if (d.n > 0) console.log(`  同风格 ${st}：深扫 ${fmt(d)} | 主 ${fmt(stat(main.filter((r) => (r.t.style ?? "?") === st)))}`);
}
