/**
 * 这个文件是干什么的：
 * 自选股的服务端接口：读名单（连带报价）、加、移除。
 *
 * 你需要知道的：
 * - 报价从全市场快照里捞（`loadUniverse`）。拉不到时不阻塞名单——
 *   列表照常显示，价格列显示「—」并说明行情没拉到。
 * - 落盘原子写在 watchlist.ts 里做（临时名带 pid+随机数）。
 */

import { createServerFn } from "@tanstack/react-start";
import {
  WATCH_LIMIT,
  addWatch,
  readWatchlist,
  removeWatch,
  writeWatchlist,
  type WatchItem,
} from "./watchlist.ts";
import { loadUniverse } from "@/lib/market/quotes.functions";
import type { Quote } from "./types.ts";

export type WatchRow = WatchItem & { quote: Quote | null };

/** 读名单 + 报价。行情拉失败时 quote 为 null，不阻塞名单本身。 */
export const getWatchlistFn = createServerFn({ method: "GET" }).handler(async () => {
  const list = await readWatchlist();
  const uni = await loadUniverse(false).catch(() => null);
  const byId = new Map((uni?.quotes ?? []).map((q) => [q.id, q]));
  const items = list.items.map((item) => ({ ...item, quote: byId.get(item.id) ?? null }));
  return { items, limit: WATCH_LIMIT, universeOk: uni != null };
});

/** 加一只。code/name 由调用方给（页面上是从快照或搜索结果里选的，不让用户手打）。 */
export const addWatchFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const d = data as { id?: unknown; code?: unknown; name?: unknown };
    const id = typeof d?.id === "string" ? d.id.trim() : "";
    if (!/^(sh|sz)\d{6}$/.test(id)) throw new Error("id 要是 sh/sz 加六位代码");
    return {
      id,
      code: typeof d.code === "string" && d.code ? d.code.slice(0, 10) : id.slice(2),
      name: typeof d.name === "string" && d.name ? d.name.slice(0, 20) : id.slice(2),
    };
  })
  .handler(async ({ data }) => {
    const list = await readWatchlist();
    const next = addWatch(list, { ...data, addedAt: new Date().toISOString() });
    await writeWatchlist(next);
    return { items: next.items, limit: WATCH_LIMIT };
  });

/** 移除一只。 */
export const removeWatchFn = createServerFn({ method: "POST" })
  .validator((data: unknown) => {
    const id = typeof (data as { id?: unknown })?.id === "string" ? (data as { id: string }).id : "";
    if (!id) throw new Error("要给出要移除的 id");
    return { id: id.slice(0, 20) };
  })
  .handler(async ({ data }) => {
    const list = await readWatchlist();
    const next = removeWatch(list, data.id);
    await writeWatchlist(next);
    return { items: next.items, limit: WATCH_LIMIT };
  });
