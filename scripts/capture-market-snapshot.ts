/**
 * 采集当日市场快照并**按日落盘**，为「预测市场」攒历史样本。
 *
 * 背景（2026-11-11 用户拍板 B 档）：
 * - `data/theme-heat.json` 原为每日 writeFileSync 直接覆写，全机只有 1 份；
 * - 涨停/炸板/跌停三池实时拉、零历史落盘；
 * - 情绪温度计只有当日读数、无历史序列。
 * 没有历史样本就不可能做样本外验证。本脚本只负责「真实数据按日归档」，
 * 不做预测、不拟合、不写死结论。
 *
 * 纪律：
 * - 缺的分量写 null 并列进 missing，**不补 0、不拿占位顶替**。
 * - 采集走 limit-pools.server.ts（限速唯一出处 fetch-policy.ts，串行 1300ms）。
 * - 原子写（tmp + rename），避免采集中断留下半截文件。
 * - 盘中拉到的涨停池是半截，sealed=false 会写进文件，页面必须标「盘中未定」。
 *
 * 用法：
 *   NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs \
 *     scripts/capture-market-snapshot.ts
 * 由 home-server.mjs 每日 15:12 心跳调用；也可手动补跑（同日覆盖，幂等）。
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { collectPools } from "@/lib/market/limit-pools.server";
import { marketBreadth } from "@/lib/market/slim-universe";
import type { Quote } from "@/lib/market/types";

const ROOT = process.cwd();
const TODAY_FILE = "data/signals/limit-pools-today.json";

function atomicWrite(path: string, value: unknown): void {
  const full = `${ROOT}/${path}`;
  const dir = full.slice(0, full.lastIndexOf("/"));
  mkdirSync(dir, { recursive: true });
  const tmp = `${full}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, full);
}

function shanghaiToday(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
}

/** 从全市场快照算涨跌广度。读不到就返回 null，不编空表。 */
function breadthOf(): ReturnType<typeof marketBreadth> | null {
  try {
    const raw = JSON.parse(readFileSync(`${ROOT}/data/universe-cache.json`, "utf8"));
    const quotes = raw?.payload?.quotes;
    if (!Array.isArray(quotes) || quotes.length === 0) return null;
    return marketBreadth(quotes as Quote[]);
  } catch (e) {
    console.error("[capture] 全市场快照读不到，广度记 null：", e instanceof Error ? e.message : String(e));
    return null;
  }
}

async function main(): Promise<void> {
  const day = shanghaiToday();
  const pools = await collectPools(day);
  const breadth = breadthOf();

  // 当日快取：页面 getMarketSnapshot 只读这个，零外部请求。
  atomicWrite(TODAY_FILE, pools);

  // 历史归档：一天一份，永不覆写别天。
  atomicWrite(`data/history/limit-pools/${day}.json`, pools);
  atomicWrite(`data/history/theme-components/${day}.json`, {
    date: day,
    capturedAt: pools.capturedAt,
    sealed: pools.sealed,
    source: "universe-cache + eastmoney-push2ex",
    breadth,
    ladder: pools.summary?.ladder ?? null,
    breakRate: pools.summary?.breakRate ?? null,
    limitUpCount: pools.limitUp.length,
    brokenCount: pools.broken.length,
    limitDownCount: pools.limitDown.length,
    // 这两个分量目前没有落盘源，明确记缺口，不拿 0 或近似值顶。
    indexPcts: null,
    mainInflow: null,
    missing: [
      ...(breadth ? [] : ["breadth（universe-cache 读不到）"]),
      "indexPcts（指数行情未落盘）",
      "mainInflow（资金流账本未落盘）",
    ],
  });

  const nUp = pools.limitUp.length;
  const nBroken = pools.broken.length;
  const nDown = pools.limitDown.length;
  const maxStreak = pools.summary?.ladder?.length
    ? Math.max(...pools.summary.ladder.map((l) => l.streak))
    : 0;
  console.log(
    `[capture] ${day} sealed=${pools.sealed} 涨停=${nUp} 炸板=${nBroken} 跌停=${nDown} ` +
      `最高连板=${maxStreak} 炸板率=${pools.summary?.breakRate?.toFixed(3) ?? "算不出"} ` +
      `广度=${breadth ? `${breadth.up}/${breadth.down}` : "读不到"} ` +
      `缺口=${pools.why ?? "无"}`,
  );
  console.log(`[capture] 已写 ${TODAY_FILE} 与 data/history/{limit-pools,theme-components}/${day}.json`);
}

main().catch((e) => {
  console.error("[capture] 失败：", e);
  process.exitCode = 1;
});
