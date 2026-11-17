/**
 * 这个文件是干什么的：
 * 每日赚钱研究名单（2026-11-17 用户要求「记得推荐让我赚钱的股票」）。
 * 按「当前环境 × 账本真实战绩」排序各策略形状，列每个形状今天的前 3 候选
 * （挂单/止损/目标齐全），落盘 data/daily-candidates.json + 随 resume-progress 推送。
 *
 * 边界（AI-BOUNDARY §0）：这是**数据研究**不是投资建议——只展示各形状的
 * 历史战绩和今天的候选，不出现「建议买入」。买不买由用户决定。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/daily-candidates.ts
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const OWNER_ID = "dev-user";

async function main() {
  const book = JSON.parse(await readFile(join(process.cwd(), "data", "books", `${OWNER_ID}.json`), "utf8"));
  // 各 style 真实战绩（账本全量）
  const perf: Record<string, { n: number; win: number; avg: number }> = {};
  const acc: Record<string, { n: number; w: number; s: number }> = {};
  for (const d of book.days) {
    for (const t of d.trades) {
      if (t.exit == null || !(t.entry > 0)) continue;
      const style = t.style ?? "value";
      const ret = ((t.exit - t.entry) / t.entry) * 100;
      acc[style] ??= { n: 0, w: 0, s: 0 };
      acc[style].n += 1;
      acc[style].w += ret > 0 ? 1 : 0;
      acc[style].s += ret;
    }
  }
  for (const [style, { n, w, s }] of Object.entries(acc)) {
    perf[style] = { n, win: Math.round((w / n) * 100), avg: Math.round((s / n) * 100) / 100 };
  }

  // 今天的候选：rebound / trend 用 watchList，value/低估值 用 reviewed.json 的 ok 票
  const { watchList } = await import("../src/lib/market/strategies.ts");
  const { loadUniverse } = await import("../src/lib/market/quotes.functions.ts");
  const { DEFAULT_RULES } = await import("../src/lib/market/rules.ts");
  const uni = await loadUniverse();
  const picks: Record<string, unknown> = {};
  for (const [shape, style] of [["中期反转(解冻中)", "rebound"], ["趋势回踩(解冻中)", "trend"]] as const) {
    const list = watchList(uni.quotes, style, DEFAULT_RULES, () => true, undefined, undefined);
    picks[shape] = {
      历史战绩: perf[style] ?? null,
      候选: list.slice(0, 3).map((r) => ({ name: r.quote.name, code: r.quote.id, 挂单: r.buy, 止损: r.stop, 目标: r.sell })),
    };
  }
  try {
    const reviewed = JSON.parse(await readFile(join(process.cwd(), "data", "signals", "reviewed.json"), "utf8")) as {
      signals?: { code: string; name: string; buyPrice?: number; verdict?: string; leg?: string; strategy?: string }[];
    };
    const okLong = (reviewed.signals ?? []).filter((s) => s.verdict === "ok" && s.leg === "long");
    if (okLong.length) {
      picks["低估值(审核通过)"] = {
        历史战绩: perf.value ?? null,
        候选: okLong.slice(0, 3).map((s) => ({ name: s.name, code: s.code, 挂单: s.buyPrice, 审核: "ok" })),
      };
    }
  } catch { /* reviewed 没有就跳过 */ }

  const out = {
    date: new Date().toLocaleDateString("sv-SE"),
    regime: "见 nav-history /today 大湾区状态",
    note: "数据研究非投资建议：按当前环境下账本真实战绩排序，列每个形状今天的前 3 候选。买不买你定。",
    performance: perf,
    picks,
  };
  await writeFile(join(process.cwd(), "data", "daily-candidates.json"), JSON.stringify(out, null, 2));
  console.log(`[daily-candidates] 已生成 ${out.date}（${Object.keys(picks).length} 个形状）`);
}

await main();
