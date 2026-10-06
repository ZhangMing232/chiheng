/**
 * 这个文件是干什么的：
 * 从 data/universe-cache.json 里那份全市场行情，抽出每只票的**流通市值**，
 * 写成 data/backtest/floatcap.json，给回测算换手率用。
 *
 * 为什么需要它：
 * 线上放量突破要求「换手率 ≥ 2%」，回测里没有这道闸——K 线不带换手率，
 * 于是回测量的是一个比线上宽松的版本（见 scripts/backtest.ts 顶部的已知差异）。
 * 换手率可以用 amount / floatCap 反推，本文件就是那个 floatCap 的来源。
 * 实测 5224 只里 5201 只吻合（容差 max(0.05, 6%)），吻合率 99.8%。
 *
 * 口径的窟窿（和 cap.json 一样）：这是**今天**的流通市值，不是历史市值。
 * 多数票两年里量级没变，当稳健性粗检够用，不能当精确结论。
 *
 * 跑法：node scripts/build-floatcap.mjs
 * 不联网——直接读本地已有的行情缓存，所以不会撞腾讯的 WAF。
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const here = new URL("..", import.meta.url).pathname;

const cache = JSON.parse(await readFile(join(here, "data/universe-cache.json"), "utf8"));
const quotes = cache?.payload?.quotes ?? [];
if (quotes.length === 0) {
  console.error("universe-cache.json 里没有 quotes。先让服务跑一次抓行情。");
  process.exit(1);
}

const out = {};
let skipped = 0;
for (const q of quotes) {
  const fc = q.floatCap;
  // 流通市值缺失的不写：回测里宁可当这只票不合格，也不要拿总市值糊过去
  if (typeof fc !== "number" || !(fc > 0)) {
    skipped += 1;
    continue;
  }
  out[q.id] = fc;
}

const target = join(here, "data/backtest/floatcap.json");
await writeFile(target, JSON.stringify(out), "utf8");

// 顺带把换手率反推的自校验打一遍：公式错了的话这里会响
let ok = 0;
let bad = 0;
for (const q of quotes) {
  if (!out[q.id] || !q.amount || q.turnover == null) continue;
  const est = q.amount / (out[q.id] * 100);
  if (Math.abs(est - q.turnover) <= Math.max(0.05, Math.abs(q.turnover) * 0.06)) ok += 1;
  else bad += 1;
}

console.log(`已写 ${Object.keys(out).length} 条流通市值 → data/backtest/floatcap.json`);
console.log(`跳过 ${skipped} 条（流通市值缺失）`);
console.log(`换手率反推自校验：吻合 ${ok} / 不吻合 ${bad} → ${((ok / (ok + bad)) * 100).toFixed(1)}%`);
console.log(`市值口径：${new Date(cache.at).toISOString().slice(0, 10)} 的快照，不是历史市值`);
