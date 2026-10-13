/**
 * 这个文件是干什么的：
 * 板块页（/sectors）的服务端接口。
 *
 * 你需要知道的：
 * - **这一页不联网**：板块清单和月度序列都读落盘缓存，所以接口挂了页面照样开，
 *   代价是数字不是实时的——数据日期必须上屏，别让人当成今天的行情。
 * - 合成逻辑全在 `sectors-view.ts`（有单测），这里只负责读文件和转手。
 * - 分类没抓过 / 月度没抓过是**两件事**，分开报，不合并成一句「行业数据缺失」。
 */

import { createServerFn } from "@tanstack/react-start";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { boardDetail, boardTable, type BoardDetail, type BoardTable, type MonthlyBook } from "./sectors-view.ts";
import { checkIndustryIndex, type IndustryIndex } from "./industry.ts";

const INDEX_PATH = join("data", "backtest", "industry.json");
const MONTHLY_PATH = join("data", "backtest", "industry-monthly.json");

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function loadIndex(): Promise<IndustryIndex | null> {
  const parsed = await readJson(INDEX_PATH);
  if (!parsed) return null;
  const checked = checkIndustryIndex(parsed);
  return checked.ok ? checked.index : null;
}

async function loadMonthly(): Promise<MonthlyBook | null> {
  const parsed = await readJson(MONTHLY_PATH);
  if (!parsed || typeof parsed !== "object") return null;
  return parsed as MonthlyBook;
}

/** 板块总表（列表页用）。 */
export const getSectorBoards = createServerFn({ method: "GET" }).handler(async (): Promise<BoardTable> => {
  const [index, monthly] = await Promise.all([loadIndex(), loadMonthly()]);
  return boardTable(index, monthly);
});

/** 单个板块的详情（月度序列 + 成分股）。 */
export const getSectorDetail = createServerFn({ method: "GET" })
  .validator((input: unknown): { code: string } => {
    const code = (input as { code?: unknown })?.code;
    return { code: typeof code === "string" && /^BK\d+$/.test(code) ? code : "" };
  })
  .handler(async ({ data }): Promise<BoardDetail | null> => {
    if (!data.code) return null;
    const [index, monthly] = await Promise.all([loadIndex(), loadMonthly()]);
    return boardDetail(index, monthly, data.code);
  });
