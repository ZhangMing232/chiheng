/**
 * 这个文件是干什么的：
 * 「游资追踪名单」——每天收盘后，从龙虎榜找**游资大额净买入**的票，
 * 输出次日观察名单（2026-11-18 用户要求「想办法提前找到涨得最好的」）。
 *
 * 为什么是它（不是价格形态）：
 * - 价格形态规则回测：次日超额 +0.007pp（等于零，已验证无效）
 * - 龙虎榜游资规则回测：**次日超额 +0.975pp、日胜率 63.3%、前半年+1.004%/后半+0.796%
 *   方向一致**（scripts/seat-signal-backtest.ts，237 天样本）
 * 这是目前唯一被数据证明有超额的事件驱动信号。
 *
 * 规则（与回测口径完全一致，不许改）：
 * 1. 当日龙虎榜里，非机构席位（营业部/游资）合计净买入 > 3000 万
 * 2. 游资净买 > 机构净买（跟游资不跟机构）
 * 3. 持有窗口：次日为主（3 日内衰减，5 日归零——不要拿长）
 *
 * 边界：
 * - 回测未扣佣金滑点，实盘会打折（约 -0.1~0.2%/笔）
 * - 只给观察名单，不建仓（未经判决流程转正）
 * - 缺数据不补 0
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/seat-signal-scan.ts
 * 输出：data/seat-signals.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const isInst = (name: string) => /机构|沪股通|深股通|北向/.test(name);

async function main() {
  const today = new Date().toLocaleDateString("sv-SE");
  // 龙虎榜是收盘后公布的，用最近一个交易日
  let date = today;
  let file: { date: string; seats: { name: string; netWan: number; stocks: { name: string; netWan: number }[] }[] } | null = null;
  for (let back = 0; back < 5 && !file; back++) {
    const d = new Date(Date.now() - back * 86_400_000).toLocaleDateString("sv-SE");
    try {
      const raw = JSON.parse(await readFile(join(process.cwd(), "data", "risk", "hotmoney", `${d}.json`), "utf8")) as typeof file;
      if (raw?.seats?.length) {
        file = raw;
        date = d;
      }
    } catch {
      /* 往前找 */
    }
  }
  if (!file) {
    console.error("[seat-scan] 近 5 天龙虎榜都读不到，本轮不产名单");
    process.exit(0);
  }

  // 名字 → 代码/行情
  const { loadUniverse } = await import("../src/lib/market/quotes.functions.ts");
  const uni = await loadUniverse();
  const byName = new Map<string, (typeof uni.quotes)[number]>();
  for (const q of uni.quotes) byName.set(q.name.replace(/\s+/g, ""), q);

  // 聚合每只票的游资/机构净买（万元）
  const hot = new Map<string, number>();
  const inst = new Map<string, number>();
  const seatNames = new Map<string, Set<string>>();
  for (const seat of file.seats) {
    const isI = isInst(seat.name);
    for (const s of seat.stocks ?? []) {
      const key = s.name.replace(/\s+/g, "");
      if (isI) inst.set(key, (inst.get(key) ?? 0) + s.netWan);
      else {
        hot.set(key, (hot.get(key) ?? 0) + s.netWan);
        if (s.netWan > 0) {
          const set = seatNames.get(key) ?? new Set();
          set.add(seat.name);
          seatNames.set(key, set);
        }
      }
    }
  }

  // 按规则筛
  const rows: {
    name: string;
    code: string;
    price: number | null;
    chg: number | null;
    hotNetWan: number;
    instNetWan: number;
    seats: string[];
    note: string;
  }[] = [];

  for (const [name, netWan] of hot) {
    if (netWan < 3000) continue; // 游资净买 > 3000 万
    const instNet = inst.get(name) ?? 0;
    if (instNet > netWan) continue; // 机构主导的不跟
    const q = byName.get(name);
    rows.push({
      name,
      code: q?.id ?? "未知",
      price: q?.price ?? null,
      chg: q?.chg ?? null,
      hotNetWan: Math.round(netWan),
      instNetWan: Math.round(instNet),
      seats: [...(seatNames.get(name) ?? [])].slice(0, 3),
      note: q ? `今日 ${q.chg?.toFixed(2)}%` : "行情里没找到（可能停牌/改名）",
    });
  }
  rows.sort((a, b) => b.hotNetWan - a.hotNetWan);

  const out = {
    at: new Date().toISOString(),
    /** 龙虎榜数据日期（收盘后才公布，比今天早一天是正常的） */
    seatDate: date,
    matched: rows.length,
    /** 回测依据（可追溯） */
    backtest: {
      days: 237,
      nextDayEdgePp: 0.975,
      nextDayWinRate: 63.3,
      firstHalfEdgePp: 1.004,
      secondHalfEdgePp: 0.796,
      decay: "3 日 +0.519pp、5 日 -0.085pp —— 只做次日，别拿长",
      cost: "回测未扣佣金滑点，实盘约 -0.1~0.2%/笔",
    },
    verified: false,
    disclaimer:
      "观察名单：规则经 237 天回测（次日超额 +0.975pp、胜率 63.3%、前后半方向一致），" +
      "但**未经实盘判决流程转正**，不建仓、不进账本。持有窗口是次日，别拿长。",
    rows: rows.slice(0, 15),
  };
  await writeFile(join(process.cwd(), "data", "seat-signals.json"), JSON.stringify(out, null, 2));

  console.log(`[seat-scan] 龙虎榜 ${date} → 命中 ${rows.length} 只（游资净买>3000万且压过机构）`);
  for (const r of out.rows.slice(0, 8)) {
    console.log(`  ${r.name} ${r.code} | 游资净买 ${(r.hotNetWan / 10000).toFixed(2)}亿 | 机构 ${(r.instNetWan / 10000).toFixed(2)}亿 | ${r.seats.join("、")}`);
  }
}

await main();
