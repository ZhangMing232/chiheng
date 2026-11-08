/**
 * 验证 NONINST 回避过滤器部署正确性（#1）。
 *
 * 跑四场景 + 机构-only 排除检查：
 *   A 开+窗口内事件票 → 应剔除（true）
 *   B 无事件普通票   → 应保留（false）
 *   C 开+窗口外事件票 → 应保留（false，已冷却）
 *   D 关过滤器        → 实盘闸门 LIVE_AVOID_LHB≠1 时不走 shouldAvoid（结构性，代码复核）
 *   机构-only 排除   → all 有事件、noninst 无事件的票，noninst 下不再触发
 *
 * 用法：NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs scripts/verify-avoid-noninst.ts
 */
import { readdir } from "node:fs/promises";
import { shouldAvoid } from "@/lib/market/lhb-avoid";
import { loadAvoidIndex } from "@/lib/market/lhb-avoid-index.server";

function shift(date: string, delta: number): string {
  const d = new Date(date + "T00:00:00");
  d.setDate(d.getDate() + delta);
  return d.toISOString().slice(0, 10);
}

async function main() {
  const noninst = await loadAvoidIndex(); // 默认口径（LHB_SEATS=noninst）→ 写入 live `index`
  const all = await loadAvoidIndex("all"); // 对照口径，不动 live `index`
  const WIN = Number(process.env.LIVE_AVOID_WIN ?? 20);

  const dates = new Set<string>();
  for (const arr of all.values()) for (const d of arr) dates.add(d);
  const T = [...dates].sort().at(-1)!;
  console.log(`基准日 T=${T}，窗口 ${WIN} 天\n`);

  // 普通票宇宙：kline 缓存里的代码，挑一个 noninst 里完全没有事件的
  const klineCodes = (await readdir("data/backtest/kline"))
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));
  const normal = klineCodes.find((c) => !(noninst.get(c)?.length));

  // A：窗口内事件票
  let aCode: string | null = null;
  for (const [code, arr] of noninst) if (arr.some((d) => d >= shift(T, -WIN) && d <= T)) { aCode = code; break; }
  // C：有事件但全在窗口外（已冷却）
  let cCode: string | null = null;
  for (const [code, arr] of noninst) {
    const within = arr.some((d) => d >= shift(T, -WIN) && d <= T);
    const older = arr.some((d) => d < shift(T, -WIN));
    if (!within && older) { cCode = code; break; }
  }

  console.log("A 开+窗口内事件票 → 应剔除(true)：");
  console.log(`   ${aCode ?? "(无)"} @${T}: shouldAvoid=${aCode ? shouldAvoid(aCode, T, WIN) : "n/a"}  [期望 true]`);
  console.log("B 无事件普通票 → 应保留(false)：");
  console.log(`   ${normal ?? "(无)"}: shouldAvoid=${normal ? shouldAvoid(normal, T, WIN) : "n/a"}  [期望 false]`);
  console.log("C 开+窗口外事件票(已冷却) → 应保留(false)：");
  console.log(`   ${cCode ?? "(无)"} @${T}: shouldAvoid=${cCode ? shouldAvoid(cCode, T, WIN) : "n/a"}  [期望 false]`);

  // 机构-only 排除
  let onlyAll = 0;
  const ex: string[] = [];
  for (const [code, arrAll] of all) {
    const arrN = noninst.get(code);
    if (arrAll.length > 0 && (!arrN || arrN.length === 0)) {
      onlyAll++;
      if (ex.length < 5) ex.push(code);
    }
  }
  console.log(`\n机构-only 事件（all 有 / noninst 无）→ noninst 下不再触发：${onlyAll} 只，示例 ${ex.join(", ")}`);

  // 增量分析（noninst 与 all 不是子集关系：机构单日净卖可把 all 拉到 3000 以下、而游资仍≥3000，
  // 这种「纯游资日」noninst 有、all 反而没有——正是 noninst 多抓的部分）
  let noninstOnly = 0; // noninst 有、all 无：纯游资日（补抓）
  let allOnly = 0; // all 有、noninst 无：机构驱动日（现排除）
  for (const [code, arrN] of noninst) {
    const arrA = all.get(code) ?? [];
    for (const d of arrN) if (!arrA.includes(d)) noninstOnly++;
  }
  for (const [code, arrA] of all) {
    const arrN = noninst.get(code) ?? [];
    for (const d of arrA) if (!arrN.includes(d)) allOnly++;
  }
  console.log(`\n增量：noninst 比 all 多抓的纯游资日 = ${noninstOnly} 票·日；noninst 比 all 少掉的机构驱动日 = ${allOnly} 票·日`);
  console.log(`（noninstOnly>0 即证明切到 noninst 后覆盖更全；allOnly>0 即证明机构噪音被剔除）`);

  console.log("\nD 关过滤器：实盘闸门 strategies.ts:725 读 process.env.LIVE_AVOID_LHB===\"1\"，未设时 quoteOrder 不走 shouldAvoid（结构性，代码复核）。");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
