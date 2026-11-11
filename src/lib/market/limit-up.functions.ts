/**
 * 这个文件是干什么的：
 * 涨停/炸板/跌停三个池的服务端接口（/signals 信号页 + 首页快照）。
 *
 * 接口来自 a-stock-data SKILL V3.10.2 §8.1（东财 push2ex 四池），
 * 赤轨只接东财这三个池，不接同花顺涨停揭秘——那个的"涨停原因题材"是市场叙事
 * 不是核验过的因果，接了要在页面上标清性质，这一步先不做。
 *
 * 你需要知道的：
 * 1. **两个读口，别混用**：
 *    - `getSignals` = 实时采集，串行 3 池 × 1300ms ≈ 4 秒，只给「用户主动打开
 *      /review/signals 或点刷新」用，**绝不进首页 SSR loader**（2026-11-11 首页
 *      4.386620s 回归就是这么来的）。
 *    - `getMarketSnapshot` = 只读盘后心跳落盘的当日快照，零外部请求，给首页用。
 * 2. 采集与限速统一在 `limit-pools.server.ts`，本文件不再自己写 fetch/sleep。
 * 3. `date` 必须传交易日，非交易日东财 `data` 返回 null → 解析层给空表，
 *    页面显示"这天不是交易日"，**不显示全 0**（0 会被读成"今天没涨停"）。
 * 4. 当天盘中拉到的可能是**不完整**的（涨停池在收盘后才定）。快照带 `sealed`
 *    与 `capturedAt`，页面要标"盘中数据未定"，别让人拿半截数据当结论。
 */

import { createServerFn } from "@tanstack/react-start";
import { collectPools, type PoolSnapshot } from "./limit-pools.server.ts";
import type { LimitUpRow } from "./limit-up.ts";

/** 实时读口返回结构 = 采集快照（多带采集时刻，页面可标新鲜度）。 */
export type SignalPayload = PoolSnapshot;

const dataPath = (...parts: string[]): string => [process.cwd(), ...parts].join("/");

export const getSignals = createServerFn({ method: "GET" })
  .validator((input: unknown): { date?: string } => {
    const v = (input ?? {}) as Record<string, unknown>;
    const date = typeof v.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.date) ? v.date : undefined;
    return { date };
  })
  .handler(async ({ data }): Promise<SignalPayload> => collectPools(data.date));

/** 当日快照文件名（capture-limit-pools.ts 写，这里读，两边别改口径）。 */
export const POOL_SNAPSHOT_FILE = ["data", "signals", "limit-pools-today.json"] as const;

export type MarketSnapshot = {
  snapshot: PoolSnapshot | null;
  /** 读不到时写明原因，页面要标缺口，不许拿空数组冒充「今天没涨停」。 */
  why: string | null;
};

/**
 * 首页专用：只读盘后落盘快照，零外部请求。
 * 文件不存在 = 今天还没采集（盘中或管道没跑），返回 null + why，由页面给空态。
 */
export const getMarketSnapshot = createServerFn({ method: "GET" }).handler(
  async (): Promise<MarketSnapshot> => {
    try {
      const { readFile } = await import("node:fs/promises");
      const raw = await readFile(dataPath(...POOL_SNAPSHOT_FILE), "utf8");
      const parsed = JSON.parse(raw) as PoolSnapshot;
      if (!parsed || !Array.isArray(parsed.limitUp)) {
        return { snapshot: null, why: "快照格式不对，等下一次采集" };
      }
      return { snapshot: parsed, why: null };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return {
        snapshot: null,
        why: code === "ENOENT" ? "今天还没采集三池快照（收盘后 15:12 落盘）" : `快照读不到：${code ?? "未知错误"}`,
      };
    }
  },
);

/** 供页面做类型标注。 */
export type { LimitUpRow };
