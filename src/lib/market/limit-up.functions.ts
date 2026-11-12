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
 *    - `getMarketSnapshot` = 只读心跳落盘的当日快照（盘中每 3 分钟 / 收盘 15:12），
 *      零外部请求，给首页和盯盘页用。
 * 2. 采集与限速统一在 `limit-pools.server.ts`，本文件不再自己写 fetch/sleep。
 * 3. `date` 必须传交易日，非交易日东财 `data` 返回 null → 解析层给空表，
 *    页面显示"这天不是交易日"，**不显示全 0**（0 会被读成"今天没涨停"）。
 * 4. 当天盘中拉到的可能是**不完整**的（涨停池在收盘后才定）。快照带 `sealed`
 *    与 `capturedAt`，页面要标"盘中数据未定"，别让人拿半截数据当结论。
 * 5. 2026-11-12 起按日归档 `data/history/limit-pools/<date>.json` 给盯盘回看用，
 *    盘中采集**只写今日快取、不写归档**，半截数据绝不混进历史档。
 */

import { createServerFn } from "@tanstack/react-start";
import { collectPools, type PoolSnapshot } from "./limit-pools.server.ts";
import { shanghaiDate } from "./session.ts";
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

/* ── 盯盘回看（2026-11-12）─────────────────────────────────────────────
 * 规矩：
 * - 盘中「今天」只读 data/signals/limit-pools-today.json（每 3 分钟由心跳刷新），
 *   页面轮询也是读文件，零外部请求；
 * - 历史某天读 data/history/limit-pools/<date>.json（收盘定盘归档，永不覆写别天）；
 * - **归档没有 ≠ 那天没涨停**。读不到返回 null + why，页面给「补拉这天」按钮，
 *   用户主动点了才去东财现拉（3 池串行 ~4 秒），绝不拿空数组顶替。
 * - 补拉只补过去的日子，今天交给 15:12 的收盘采集，免得半截盘中数据混进历史档。
 */

const isIsoDay = (s: unknown): s is string => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
const archivePath = (day: string): string => dataPath("data", "history", "limit-pools", `${day}.json`);

export type WatchDays = {
  /** 已有收盘归档的日子（新→旧）。 */
  archived: string[];
  /** 最近约三周的过去工作日（新→旧），含还没归档的——选中它们可以补拉。 */
  candidates: string[];
};

/**
 * 盯盘日期下拉的数据。
 * 不能只返回「已归档」：那样本来就没有归档的日子选不到，补拉按钮永远点不出来。
 * 候选按最近 24 个自然日的工作日算（东财 push2ex 实测大约留三周），
 * 超出保留窗口的日子补拉时会如实报「接口没返回」，不写空档。
 */
export const getWatchDays = createServerFn({ method: "GET" }).handler(async (): Promise<WatchDays> => {
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(dataPath("data", "history", "limit-pools")).catch(() => [] as string[]);
  const archived = files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort()
    .reverse();
  const today = shanghaiDate();
  const anchor = new Date(`${today}T12:00:00+08:00`);
  const candidates: string[] = [];
  for (let back = 1; back <= 24; back++) {
    const d = new Date(anchor.getTime() - back * 24 * 3_600_000);
    const wd = d.getUTCDay(); // T12:00+08:00 = 04:00Z，同一天
    if (wd === 0 || wd === 6) continue;
    candidates.push(d.toISOString().slice(0, 10));
  }
  return { archived, candidates };
});

export type WatchDay = {
  snapshot: PoolSnapshot | null;
  /** archive=读本地归档；none=没有这份数据（不是「那天没涨停」） */
  source: "archive" | "none";
  why: string | null;
};

/** 读某个历史交易日的封板快照。只读盘，不联网。 */
export const getWatchDay = createServerFn({ method: "GET" })
  .validator((input: unknown): { date: string } => {
    const v = (input ?? {}) as Record<string, unknown>;
    return { date: isIsoDay(v.date) ? v.date : "" };
  })
  .handler(async ({ data }): Promise<WatchDay> => {
    if (!data.date) return { snapshot: null, source: "none", why: "没给日期" };
    try {
      const { readFile } = await import("node:fs/promises");
      const parsed = JSON.parse(await readFile(archivePath(data.date), "utf8")) as PoolSnapshot;
      if (!parsed || !Array.isArray(parsed.limitUp)) {
        return { snapshot: null, source: "none", why: `${data.date} 的归档格式不对` };
      }
      return { snapshot: parsed, source: "archive", why: null };
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      return {
        snapshot: null,
        source: "none",
        why: code === "ENOENT" ? `${data.date} 没有归档（这天可能还没采过，或超出东财保留窗口）` : `归档读不到：${code ?? "未知错误"}`,
      };
    }
  });

/**
 * 用户点「补拉这天」才走：去东财按日期现拉三池，成功就补写归档。
 * 东财 push2ex 实测支持历史日期，但只留最近约三周；再往前返回空，
 * 这时明确报「接口没返回」，不写空档、不让页面显示成「那天没涨停」。
 */
export const backfillWatchDay = createServerFn({ method: "GET" })
  .validator((input: unknown): { date: string } => {
    const v = (input ?? {}) as Record<string, unknown>;
    return { date: isIsoDay(v.date) ? v.date : "" };
  })
  .handler(async ({ data }): Promise<WatchDay> => {
    if (!data.date) return { snapshot: null, source: "none", why: "没给日期" };
    if (data.date >= shanghaiDate()) {
      return { snapshot: null, source: "none", why: "今天/未来不补历史档，等 15:12 收盘采集" };
    }
    let snap: PoolSnapshot;
    try {
      snap = await collectPools(data.date);
    } catch (e) {
      return { snapshot: null, source: "none", why: `东财现拉失败：${e instanceof Error ? e.message : String(e)}` };
    }
    if (!snap.summary || snap.limitUp.length === 0) {
      return {
        snapshot: null,
        source: "none",
        why: `东财对 ${data.date} 没返回三池（超出约三周保留窗口，或这天不是交易日）——不是「那天没涨停」`,
      };
    }
    try {
      const { mkdir, rename, writeFile } = await import("node:fs/promises");
      const full = archivePath(data.date);
      await mkdir(full.slice(0, full.lastIndexOf("/")), { recursive: true });
      const tmp = `${full}.tmp-${process.pid}`;
      // 过去的日子已经定盘，sealed 写死 true，不看当下几点。
      await writeFile(tmp, JSON.stringify({ ...snap, sealed: true }, null, 2));
      await rename(tmp, full);
      return { snapshot: { ...snap, sealed: true }, source: "archive", why: null };
    } catch (e) {
      // 拉到了但写盘失败：照样把数据给页面看，同时如实说没归档。
      return {
        snapshot: snap,
        source: "archive",
        why: `补拉到了，但归档写盘失败（${e instanceof Error ? e.message : String(e)}）；下次还得重拉`,
      };
    }
  });
