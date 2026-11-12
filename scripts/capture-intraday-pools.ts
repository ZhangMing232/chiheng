/**
 * 盘中三池采集（每 3 分钟由 scripts/home-server.mjs 调度）。
 *
 * 为什么单独一个脚本、不去改 capture-market-snapshot.ts：
 * 那个是**收盘定盘**链路，除了写今日快取还要按日归档、算广度、串下游（情绪周期/简报），
 * 一天只跑一次，已经验过。盘中采集只想做一件事：把「今天到现在封住/炸板/跌停了谁」
 * 写进 data/signals/limit-pools-today.json，让盯盘页和首页读到新鲜数据。
 * 两条链路分开，盘中半截数据就**绝不会**混进 data/history/limit-pools/<date>.json。
 *
 * 纪律：
 * - 只写今日快取，不写历史归档、不算广度、不跑下游。
 * - 走 limit-pools.server.ts 的 collectPools（限速唯一出处 fetch-policy.ts，
 *   3 池串行 ×1300ms，开并发实测立刻 403）。
 * - 盘中拉到的涨停池是半截，sealed=false 会写进文件，页面必须标「盘中未定」。
 * - 空表写清楚 why，不拿全 0 冒充「今天没涨停」。
 * - 原子写（tmp + rename），免得采集中断留下半截文件。
 *
 * 用法（一般由心跳调，不用手跑）：
 *   NODE_OPTIONS= node --experimental-strip-types --import ./scripts/alias.mjs \
 *     scripts/capture-intraday-pools.ts
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { collectPools } from "@/lib/market/limit-pools.server";
import { shanghaiDate } from "@/lib/market/session";

const ROOT = process.cwd();
const TODAY_FILE = `${ROOT}/data/signals/limit-pools-today.json`;

async function main(): Promise<void> {
  const day = shanghaiDate();
  const pools = await collectPools(day);
  mkdirSync(`${ROOT}/data/signals`, { recursive: true });
  const tmp = `${TODAY_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(pools, null, 2));
  renameSync(tmp, TODAY_FILE);
  console.log(
    `[intraday] ${day} ${new Date(pools.capturedAt).toLocaleTimeString("zh-CN", { hour12: false })} ` +
      `sealed=${pools.sealed} 涨停=${pools.limitUp.length} 炸板=${pools.broken.length} ` +
      `跌停=${pools.limitDown.length}${pools.why ? ` 缺口=${pools.why}` : ""}`,
  );
}

main().catch((e) => {
  console.error("[intraday] 采集失败：", e);
  process.exitCode = 1;
});
