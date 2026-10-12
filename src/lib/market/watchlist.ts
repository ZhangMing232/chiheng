/**
 * 这个文件是干什么的：
 * 自选股名单。**它和「策略追踪」不是一回事**——自选是我感兴趣的票（不一定在账上），
 * 策略追踪是账本里真的买了的。网站上以前只有后者，想看别的研究标的没有地方放。
 *
 * 你需要知道的（纪律）：
 * 1. **落盘必须原子写**。临时文件名带 pid + 随机数——固定名字的话，两个进程同时写
 *    会把文件写没（record-journal.ts 踩过的坑，账本丢过一次）。
 * 2. 上限 `WATCH_LIMIT` 只。盯盘页一屏装得下的量，超了说明在拿它当收藏夹用。
 * 3. 纯函数（增删判定）和 I/O（读写）分开，前者直接单测。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomInt } from "node:crypto";

/** 自选只数上限。 */
export const WATCH_LIMIT = 50;

export type WatchItem = {
  /** 内部编号，带市场前缀，例如 sh600519（和账本的股票 id 同口径） */
  id: string;
  code: string;
  name: string;
  addedAt: string;
};

export type WatchList = { items: WatchItem[] };

export const EMPTY_WATCH: WatchList = { items: [] };

/**
 * 加一只。已在名单里 → 原样返回（不算错误，重复添加是正常操作）；
 * 到上限 → 抛错，让调用方告诉用户「装不下了」。
 */
export function addWatch(list: WatchList, item: WatchItem): WatchList {
  if (list.items.some((row) => row.id === item.id)) return list;
  if (list.items.length >= WATCH_LIMIT) {
    throw new Error(`自选已满 ${WATCH_LIMIT} 只，先移除几只再加`);
  }
  return { items: [...list.items, item] };
}

/** 移除一只。不在名单里也返回原样（幂等），不让「删一个不存在的」变成错误。 */
export function removeWatch(list: WatchList, id: string): WatchList {
  return { items: list.items.filter((row) => row.id !== id) };
}

export function watchDir(root = process.cwd()): string {
  return join(root, "data");
}

function watchPath(root = process.cwd()): string {
  return join(watchDir(root), "watchlist.json");
}

/** 读名单。文件不在（没加过 / data 不在 git 换了机器）= 空名单，不报错。 */
export async function readWatchlist(root = process.cwd()): Promise<WatchList> {
  try {
    const parsed = JSON.parse(await readFile(watchPath(root), "utf-8")) as WatchList;
    if (!parsed || !Array.isArray(parsed.items)) return EMPTY_WATCH;
    return { items: parsed.items.filter((row) => typeof row?.id === "string") };
  } catch {
    return EMPTY_WATCH;
  }
}

/**
 * 写名单。**原子替换**：先写临时文件再 rename。
 *
 * 临时名必须带 pid + 随机数。固定名字的话两个进程同时写会互相覆盖，
 * 最终留下一个空文件或半截 JSON——record-journal.ts 为此丢过账本。
 */
export async function writeWatchlist(list: WatchList, root = process.cwd()): Promise<void> {
  const dir = watchDir(root);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.watchlist.${process.pid}.${randomInt(1e9).toString(36)}.tmp`);
  await writeFile(tmp, JSON.stringify(list, null, 1), "utf-8");
  await rename(tmp, watchPath(root));
}
