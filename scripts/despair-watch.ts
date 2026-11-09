/**
 * 这个文件是干什么的：
 * 「绝望底仓」观察池每周复核（圣阳/九阳案例逆向，docs/CASE-DESPAIR-BASE.md）：
 * ① 盯篮子——despair-basket.json 里 10 只的现价对照（买入价/止损/目标/持满），
 *   涨跌都是过程，只有止损/目标/到期才是事件（2026-11-09 晚改：旧的「涨 25% 提醒」
 *   是马后炮，用户骂醒——肉在提醒之前，改成盯持仓）；
 * ② 池子刷新——今天还有哪些票进了收紧包络、哪些出圈了；
 * ③ 微信推送周报（PushPlus，没配 token 就只落盘）。
 *
 * 你需要知道的：
 * - 这是**观察机制不是选股系统**：点火 = 「该人眼看了」的提醒，不是买卖信号；
 *   判决意义上的类期望是零（despairBase 六切片 +0.19%/t=0.31），
 *   别把周报读成推荐。
 * - 入池基准价固定在 data/study-despair-base-tight-20261109.json（2026-11-09 快照），
 *   涨幅都相对那一天算；新入圈的票用当天价作基准并另存对照文件。
 * - 每周一 18:00 由 launchd（com.chiheng.despair-watch）跑；手动跑同命令。
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/despair-watch.ts
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { sendPushPlus } from "@/lib/market/push";

type PoolItem = {
  id: string; name: string; price: number; cap: number;
  距高: number; 距低: number; 高点距今: number; drift60: number; 换手?: number;
};

const POOL_FILE = "data/study-despair-base-tight-20261109.json";
const NEW_FILE = "data/study-despair-newcomers.json";
const BASKET_FILE = "data/despair-basket.json";

const pool = JSON.parse(readFileSync(POOL_FILE, "utf8")) as PoolItem[];
const quotes: Record<string, { name: string; price: number; cap: number; st?: boolean; amount?: number; turnover?: number }> = {};
for (const q of (JSON.parse(readFileSync("data/universe-cache.json", "utf8")).payload.quotes as Array<{ id: string; name: string; price: number; cap: number; st?: boolean; amount?: number; turnover?: number }>)) {
  quotes[q.id] = q;
}

// ① 篮子盯账：买入价对照现价，只报事件（止损/目标/接近），不报过程涨跌
type BasketPick = { id: string; name: string; buy: number; stop: number; target: number; hold: number };
let basket: { date: string; picks: BasketPick[] } = { date: "", picks: [] };
try {
  basket = JSON.parse(readFileSync(BASKET_FILE, "utf8"));
} catch {
  basket = { date: "", picks: [] };
}
const fired: { p: { name: string; id: string }; pct: number }[] = [];
const events: string[] = [];
for (const b of basket.picks) {
  const q = quotes[b.id];
  if (!q || !q.price) continue;
  const pct = (q.price / b.buy - 1) * 100;
  if (q.price <= b.stop) events.push(`⛔ ${b.name} 触及止损 ${b.stop}`);
  else if (q.price >= b.target) events.push(`✅ ${b.name} 到达目标 ${b.target}`);
  else if (pct >= 15) events.push(`🚀 ${b.name} +${pct.toFixed(0)}%（目标 ${b.target}）`);
  else if (pct <= -5) events.push(`⚠️ ${b.name} ${pct.toFixed(0)}%（止损 ${b.stop}）`);
  fired.push({ p: b, pct });
}
fired.sort((a, b) => b.pct - a.pct);

// ② 池子刷新：重扫收紧包络，找新入圈的
const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
const inPool = new Set(pool.map((p) => p.id));
const newcomers: PoolItem[] = [];
const kdir = "data/backtest/kline";
for (const f of readdirSync(kdir)) {
  if (!f.endsWith(".json")) continue;
  const id = f.slice(0, -5);
  if (inPool.has(id)) continue;
  const q = quotes[id];
  if (!q || q.st || !(30 <= q.cap && q.cap <= 300) || (q.amount ?? 0) < 3000) continue;
  let rows: { date: string; c: number; h: number; l: number }[];
  try { rows = JSON.parse(readFileSync(join(kdir, f), "utf8")); } catch { continue; }
  if (rows.length < 300) continue;
  const pre250 = rows.slice(-250);
  const hi250 = Math.max(...pre250.map((r) => r.h));
  const lo250 = Math.min(...pre250.map((r) => r.l));
  const hp = pre250.reduce((best, r, i) => (r.h > pre250[best].h ? i : best), 0);
  const c = rows[rows.length - 1]!.c;
  const drift60 = rows.length > 61 ? (c / rows[rows.length - 61]!.c - 1) * 100 : 0;
  const 距高 = (c / hi250 - 1) * 100;
  const 距低 = (c / lo250 - 1) * 100;
  if (!(距高 >= -35 && 距高 <= -22)) continue;
  if (pre250.length - hp < 150) continue;
  if (!(drift60 >= -20 && drift60 <= 5)) continue;
  if (!(距低 >= 10 && 距低 <= 70)) continue;
  if ((q.turnover ?? 0) > 8) continue;
  newcomers.push({ id, name: q.name, price: c, cap: q.cap, 距高: Math.round(距高 * 10) / 10, 距低: Math.round(距低 * 10) / 10, 高点距今: pre250.length - hp, drift60: Math.round(drift60 * 10) / 10, 换手: q.turnover });
}

// ③ 报告
const lines: string[] = [];
lines.push(`绝望底仓周报 ${today}｜池 ${pool.length} 只 · 点火 ${fired.length} 只 · 新入圈 ${newcomers.length} 只`);
lines.push(`篮子 ${basket.picks.length} 只（建于 ${basket.date}）· 全池 ${pool.length} 只在吸筹态`);
if (basket.picks.length) {
  const tot = fired.reduce((s, f) => s + f.pct, 0);
  lines.push(`篮子浮动合计 ${tot >= 0 ? "+" : ""}${tot.toFixed(1)}%（均 ${(tot / Math.max(fired.length, 1)).toFixed(1)}%/只）`);
  for (const { p, pct } of fired.slice(0, 10)) lines.push(`  ${p.name}（${p.id.slice(2)}）${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`);
}
if (events.length) lines.push("事件：" + events.join("；"));
lines.push("纪律：止损/目标/120 天到期才是出场事件，中间的涨跌只是过程。");
if (newcomers.length) {
  lines.push("新入圈（本周进入收紧包络）：");
  for (const n of newcomers.slice(0, 10)) lines.push(`  ${n.name}（${n.id}）距高${n.距高}% 漂移${n.drift60}%`);
}
if (!fired.length && !newcomers.length) lines.push("本周无点火、无新入圈。");
const text = lines.join("\n");
console.log(text);
writeFileSync(`data/despair-review-${today}.md`, text + "\n");
writeFileSync(NEW_FILE, JSON.stringify(newcomers, null, 2));
const ok = await sendPushPlus(`绝望底仓周报 ${today}`, text.replace(/^(.*)$/gm, "$1"), "txt");
console.log(ok ? "已推送微信" : "未配 PushPlus token，只落盘");
