/**
 * 这个文件是干什么的：
 * 一次性导入：把「绝望底仓」观察池（2026-11-09 圣阳/九阳案例逆向的收紧包络）
 * 里最贴近两案例签名的前 35 只加进自选，给用户日常盯盘用。
 *
 * 你需要知道的：
 * - 只取 35 不取 76：WATCH_LIMIT=50，产品纪律「自选是盯盘清单不是收藏夹」，
 *   留 15 个位置给用户自己加。全量 76 只由每周复核脚本（despair-watch.ts）盯点火。
 * - 相似度 = 到两案例中心的加权距离（各维按两案例半间距+地板归一）：
 *   距高 −28.5%、高点距今 197 根、60 日漂移 −11.7%、距底 +36%、市值 63 亿。
 *   权重方案是描述性的（来自两案例），不是拟合出来的。
 * - 走 watchlist.ts 的 addWatch 语义（去重/上限），不直接写 JSON。
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/import-despair-watch.ts
 */
import { readFileSync } from "node:fs";
import { addWatch, readWatchlist, writeWatchlist } from "@/lib/market/watchlist";

type PoolItem = {
  id: string; name: string; price: number; cap: number;
  距高: number; 距低: number; 高点距今: number; drift60: number;
};

const CENTER = { 距高: -28.5, 高点距今: 197, drift60: -11.7, 距低: 36, cap: 63 };
const FLOOR = { 距高: 2, 高点距今: 30, drift60: 5, 距低: 15, cap: 20 };
const HALF = { 距高: 0.5, 高点距今: 21, drift60: 3.65, 距低: 19, cap: 4.5 };

function dist(p: PoolItem): number {
  const d = (x: number, c: number, h: number, f: number) => (x - c) / Math.max(h, f);
  return Math.hypot(
    d(p.距高, CENTER.距高, HALF.距高, FLOOR.距高),
    d(p.高点距今, CENTER.高点距今, HALF.高点距今, FLOOR.高点距今),
    d(p.drift60, CENTER.drift60, HALF.drift60, FLOOR.drift60),
    d(p.距低, CENTER.距低, HALF.距低, FLOOR.距低),
    d(p.cap, CENTER.cap, HALF.cap, FLOOR.cap),
  );
}

const pool = JSON.parse(readFileSync("data/study-despair-base-tight-20261109.json", "utf8")) as PoolItem[];
pool.sort((a, b) => dist(a) - dist(b));
const take = pool.slice(0, 35);

const userId = process.env.OWNER_ID ?? "dev-user";
let list = await readWatchlist(userId);
let added = 0;
for (const p of take) {
  const before = list.items.length;
  list = addWatch(list, { id: p.id, code: p.id.slice(2), name: p.name, addedAt: new Date().toISOString() });
  if (list.items.length > before) added += 1;
}
await writeWatchlist(userId, list);
console.log(`已加 ${added} 只（自选共 ${list.items.length}/50）：`);
for (const p of take.slice(0, 10)) console.log(`  ${p.id} ${p.name} 距高${p.距高}% 相似距离 ${dist(p).toFixed(2)}`);
