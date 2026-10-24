/**
 * 这个文件是干什么的：
 * 从 data/universe-cache.json 里那份全市场行情，抽出每只票的市值，
 * 写成两份快照：
 *   - data/backtest/cap.json       总市值（回测的 BT_CAP 市值过滤用）
 *   - data/backtest/floatcap.json  流通市值（回测的换手率闸用）
 *
 * 为什么需要它：
 * 线上放量突破要求「换手率 ≥ 2%」和「总市值 ≥ 40 亿」，回测里没有这两道闸——
 * K 线不带换手率和市值，于是回测量的是一个比线上宽松的版本（见 scripts/backtest.ts
 * 顶部的已知差异）。换手率可以用 amount / floatCap 反推，本文件就是那个 floatCap
 * 的来源。自校验（amount ÷ floatCap × 100 对提供商的 turnover）历史实测：
 *   2026-10-06：5224 只里 5201 只吻合 → 99.8%
 *   2026-10-24：5219 只里 4967 只吻合 → 95.2%（252 只不吻合）
 * 掉下来的原因已诊断：不吻合的全部是高换手股（不吻合组换手中位 5.92%，吻合组 2.48%），
 * est 系统性偏低约 6%——提供商的 turnover 隐含流通股本比 floatCap 的股本小一截，
 * 和近期解禁/新上市股「两个字段股本数不一致」对得上（2026 科创新股潮后这类变多）。
 * 影响有界：偏差只在换手 ≥1% 的票上显形，换手率闸是 ≥2% 的粗闸，误差让边界附近
 * （真换手 2.0~2.1%）的票偏保守地不过闸；回测侧「流通市值 ≥40 亿」近似同理。
 * 这是行情源的已知不精确，不是本脚本的 bug——自校验就是用来把它的界画出来的。
 *
 * 2026-10-24 的教训（为什么两份放一个脚本里建）：
 * 以前只有本文件（那时叫 build-floatcap.mjs）建 floatcap.json，cap.json 是更早
 * 一次性抓的，仓库里没有它的 builder。结果登记表把 cap.json 的补救命令写成了
 * 本脚本——一个并不建 cap.json 的脚本——于是 cap.json 从 10-05 起静默腐烂了 19 天，
 * 审计 A3 天天喊、没人知道该跑什么。现在两份都由这一个脚本从同一份行情快照建，
 * 且收盘封印后每天自动重建（见 scripts/record-journal.ts），登记表指向真实命令。
 *
 * 口径的窟窿（两份一样）：这是**今天**的市值，不是历史市值。
 * 多数票两年里量级没变，当稳健性粗检够用，不能当精确结论。
 *
 * 跑法：node scripts/build-caps.mjs
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

/** 按字段抽一份 { id: 值 }。缺失/非正数的不写：回测里宁可当不合格，也不要拿别的字段糊过去。 */
function pick(field) {
  const out = {};
  let skipped = 0;
  for (const q of quotes) {
    const v = q[field];
    if (typeof v !== "number" || !(v > 0)) {
      skipped += 1;
      continue;
    }
    out[q.id] = v;
  }
  return { out, skipped };
}

const cap = pick("cap");
const floatCap = pick("floatCap");

const capTarget = join(here, "data/backtest/cap.json");
const floatTarget = join(here, "data/backtest/floatcap.json");
await writeFile(capTarget, JSON.stringify(cap.out), "utf8");
await writeFile(floatTarget, JSON.stringify(floatCap.out), "utf8");

// 顺带把换手率反推的自校验打一遍：公式错了的话这里会响
let ok = 0;
let bad = 0;
for (const q of quotes) {
  if (!floatCap.out[q.id] || !q.amount || q.turnover == null) continue;
  const est = q.amount / (floatCap.out[q.id] * 100);
  if (Math.abs(est - q.turnover) <= Math.max(0.05, Math.abs(q.turnover) * 0.06)) ok += 1;
  else bad += 1;
}

// 总市值 < 流通市值是数据异常（理论上不可能）。只计数不删——删了就是静默改样本池，
// 但个数多了说明行情源那个字段有问题，该去查源。
let inverted = 0;
for (const [id, fc] of Object.entries(floatCap.out)) {
  const total = cap.out[id];
  if (total != null && total < fc) inverted += 1;
}

console.log(`已写 ${Object.keys(cap.out).length} 条总市值 → data/backtest/cap.json（跳过 ${cap.skipped} 条缺失）`);
console.log(`已写 ${Object.keys(floatCap.out).length} 条流通市值 → data/backtest/floatcap.json（跳过 ${floatCap.skipped} 条缺失）`);
console.log(`换手率反推自校验：吻合 ${ok} / 不吻合 ${bad} → ${((ok / (ok + bad)) * 100).toFixed(1)}%`);
if (inverted > 0) console.log(`⚠ 总市值 < 流通市值的异常 ${inverted} 条（未删，去查行情源）`);
console.log(`市值口径：${new Date(cache.at).toISOString().slice(0, 10)} 的快照，不是历史市值`);
