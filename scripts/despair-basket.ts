/**
 * 「绝望底仓」实验篮子每日名单（2026-11-09 晚重设计，用户纠偏）：
 * 旧设计是「观察池 + 涨 25% 提醒」——被用户骂醒：+25% 是马后炮（圣阳 +174%，
 * 等提醒肉早没了），且只盯 35 只等于把彩票裁掉大半（回测验的是全池 787 只）。
 * 新设计照回测口径执行：**全池状态里按回撤深度取前 10 只直接进篮子**，
 * 现价买入、止损 -10%、目标 +25%、持 120 个交易日——火箭没有预告，
 * 吃肉的方式是发射前就坐在篮子里。这是实验线（高方差、低胜率、正期望靠尾部），
 * 名单标「实验篮子」，不冒充稳健信号。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/despair-basket.ts
 * 输出：data/despair-basket.json（当日名单 + 持仓对照用）+ PushPlus 买入单。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sendPushPlus } from "@/lib/market/push";

type Quote = { id: string; code?: string; name?: string; price: number; cap: number; amount?: number; st?: boolean };
type Row = { date: string; c: number; h: number; l: number };

const quotes: Quote[] = JSON.parse(readFileSync("data/universe-cache.json", "utf8")).payload.quotes;
const byId = new Map(quotes.map((q) => [q.id, q]));

// 全池状态扫描（与 backtest.ts despairState 同口径：宽口径，判据是回测过的那套）
const state: { id: string; name: string; price: number; cap: number; score: number; 距高: number }[] = [];
for (const f of readdirSync("data/backtest/kline")) {
  if (!f.endsWith(".json")) continue;
  const id = f.slice(0, -5);
  const q = byId.get(id);
  if (!q || q.st || !(30 <= q.cap && q.cap <= 300) || (q.amount ?? 0) < 3000) continue;
  let rows: Row[];
  try { rows = JSON.parse(readFileSync(join("data/backtest/kline", f), "utf8")); } catch { continue; }
  if (rows.length < 300) continue;
  const pre250 = rows.slice(-250);
  const hi250 = Math.max(...pre250.map((r) => r.h));
  const lo250 = Math.min(...pre250.map((r) => r.l));
  const hp = pre250.reduce((b, r, i) => (r.h > pre250[b].h ? i : b), 0);
  const c = rows[rows.length - 1]!.c;
  const drift60 = rows.length > 61 ? (c / rows[rows.length - 61]!.c - 1) * 100 : 0;
  const near52w = hi250 > 0 ? c / hi250 : 2;
  const loRatio = lo250 > 0 ? c / lo250 : 0;
  if (near52w > 0.75) continue; // 深跌
  if (pre250.length - hp < 120) continue; // 旧高点
  if (!(drift60 >= -25 && drift60 <= 10)) continue; // 横盘微跌
  if (loRatio < 1.03) continue; // 已离底
  state.push({ id, name: q.name ?? id, price: c, cap: q.cap, score: (1 - near52w) * 100, 距高: (near52w - 1) * 100 });
}
state.sort((a, b) => b.score - a.score);
const picks = state.slice(0, 10).map((s) => ({
  ...s,
  buy: s.price,
  stop: +(s.price * 0.9).toFixed(2),
  target: +(s.price * 1.25).toFixed(2),
  hold: 120,
}));

const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
mkdirSync("data", { recursive: true });
writeFileSync("data/despair-basket.json", JSON.stringify({ date: today, poolSize: state.length, picks }, null, 2));

const lines = picks.map((p) => `🟢 ${p.name} ${p.id.slice(2)} | 买 ${p.buy} | 止损 ${p.stop} | 目标 ${p.target} | 距顶 ${p.距高.toFixed(0)}%`);
const sent = await sendPushPlus(`绝望底仓·实验篮子买入单（${picks.length} 只）`, [
  `全池 ${state.length} 只在吸筹态，按回撤深度取前 ${picks.length} 只进篮子`,
  "──────────────────",
  ...lines,
  "──────────────────",
  "实验线纪律：现价买入 · 止损 -10% / 目标 +25% · 拿满 120 个交易日",
  "高方差、低胜率、赚尾部——单笔不保证，篮子的期望来自少数几只自燃。",
  "骑上火箭的前提是发射前就在篮子里；等涨 25% 再看就晚了。",
].join("\n"), "txt");
console.log(sent ? "买入单已推送微信" : "推送未发出（未配 token）");
console.log(`全池 ${state.length} 只 → 篮子前 ${picks.length} 只`);
for (const p of picks) console.log(`  ${p.name.padEnd(8)} ${p.id.slice(2)} 买 ${p.buy} 止损 ${p.stop} 目标 ${p.target} 距顶 ${p.距高.toFixed(0)}%`);
