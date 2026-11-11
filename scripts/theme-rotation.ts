/**
 * 题材轮动——从 K 线算「题材动量 + 轮动方向」（对标弈盘精选题材轮动，但自算零外部源）。
 *
 * 口径（数据已验证过）：
 * - 题材涨停家数 → 次日 +0.4%~0.77%（单调，题材动量的硬 edge）。
 * - 轮动 = 今日涨停家数 vs 近5日均涨停家数：加速（轮动进）/ 减速（轮动出）/ 平稳。
 * - 5日涨幅 = 题材成分股近5日累计涨跌幅均值。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/theme-rotation.ts
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";

const OUT = "data/history/theme-rotation";

type KRow = { date: string; c: number };

function thrOf(code: string): number {
  return code.startsWith("sz30") || code.startsWith("sh68") ? 0.195 : 0.095;
}

async function main() {
  const concepts = JSON.parse(await readFile("data/backtest/concepts.json", "utf8"));
  const boards = concepts.boards ?? concepts;
  const date = new Date().toISOString().slice(0, 10);

  const rows: { name: string; limitUp: number; avgChg: number; chg5d: number; avgLimitUp5d: number; rot: "加速" | "减速" | "平稳" }[] = [];

  for (const b of boards) {
    const members: string[] = (b.members ?? []).filter((m: string) => /^(sh|sz)\d{6}$/.test(m));
    if (members.length < 8) continue;
    let lu = 0, chgSum = 0, chgN = 0, chg5Sum = 0, chg5N = 0, luHistSum = 0, luHistN = 0;
    for (const id of members) {
      let kl: KRow[] = [];
      try {
        kl = JSON.parse(await readFile(`data/backtest/kline/${id}.json`, "utf8"));
      } catch {
        continue;
      }
      if (!Array.isArray(kl) || kl.length < 6) continue;
      const thr = thrOf(id);
      const last = kl[kl.length - 1];
      const prev = kl[kl.length - 2];
      if (!(last.c > 0 && prev.c > 0)) continue;
      // 今日
      const chg = last.c / prev.c - 1;
      chgSum += chg; chgN += 1;
      if (chg >= thr) lu += 1;
      // 5日累计涨幅
      const base = kl[kl.length - 6];
      if (base.c > 0) { chg5Sum += last.c / base.c - 1; chg5N += 1; }
      // 近5日（不含今日）每日涨停，累计算 5日均涨停家数
      for (let i = 2; i <= 6; i += 1) {
        const cur = kl[kl.length - i];
        const pre = kl[kl.length - i - 1];
        if (cur?.c > 0 && pre?.c > 0) {
          if (cur.c / pre.c - 1 >= thr) { luHistSum += 1; }
          luHistN += 1;
        }
      }
    }
    if (chgN < 5) continue;
    const avgChg = chgSum / chgN;
    const chg5d = chg5N ? chg5Sum / chg5N : 0;
    const avgLimitUp5d = luHistN ? luHistSum / (luHistN / chgN) : 0; // 每只票近5日的日均涨停概率 × 成分数 ≈ 5日均涨停家数
    // 简化：5日均涨停家数 ≈ luHistSum / 5（每只票5天里涨停的天数之和 / 5）
    const avgLu5d = luHistSum / 5;
    const rot = lu >= 3 && lu >= avgLu5d * 1.5 ? "加速" : lu < avgLu5d * 0.6 ? "减速" : "平稳";
    rows.push({ name: b.name ?? "", limitUp: lu, avgChg, chg5d, avgLimitUp5d: avgLu5d, rot });
  }

  // 排序：加速优先，涨停家数降序
  rows.sort((a, b) => (a.rot === "加速" ? 0 : a.rot === "平稳" ? 1 : 2) - (b.rot === "加速" ? 0 : b.rot === "平稳" ? 1 : 2) || b.limitUp - a.limitUp);

  await mkdir(OUT, { recursive: true });
  const out = { date, computedAt: new Date().toISOString(), rows };
  await writeFile(`${OUT}/${date}.json`, JSON.stringify(out, null, 2));

  console.log(`题材轮动 ${date}（算得 ${rows.length} 个题材）\n`);
  console.log("=== 加速（轮动进）===");
  for (const r of rows.filter((x) => x.rot === "加速").slice(0, 10)) {
    console.log(`  ${r.name} 涨停${r.limitUp} 均${(r.avgChg * 100).toFixed(1)}% 5日${(r.chg5d * 100).toFixed(1)}%`);
  }
  console.log("=== 减速（轮动出）前5 ===");
  for (const r of rows.filter((x) => x.rot === "减速").slice(0, 5)) {
    console.log(`  ${r.name} 涨停${r.limitUp} 均${(r.avgChg * 100).toFixed(1)}% 5日${(r.chg5d * 100).toFixed(1)}%`);
  }
}

main().catch((e) => {
  console.error("题材轮动失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
