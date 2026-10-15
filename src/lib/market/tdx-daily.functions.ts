/**
 * 这个文件是干什么的：
 * 读通达信盘后包的落盘文件，给 /flow 页面提供**收盘后的全市场截面**。
 *
 * 为什么这块和页面上的其他数字不一样（这是它存在的理由）：
 * 1. **它是收盘后的权威数据**，别处（腾讯快照）是盘中的，每分钟都在变。
 * 2. **它含北交所**——腾讯和新浪都把 bj 挡掉了（registry 里记着：两个源都不给北交所），
 *    盘后包有 349 只北交所票。这是页面别处拿不到的一块。
 * 3. 成交额是**真实成交额**（元），不是估算。
 *
 * 你需要知道的：
 * - 盘后包一天一个文件（`data/backtest/tdx-daily/{ymd}.json`），这里只读**最新一份**，
 *   不做历史累加——攒历史是回测的事，这个页面只回答「今天收盘长什么样」。
 * - **当天的包要收盘后数小时才发布**，读不到就说「今天的还没发布」，不给空表。
 * - 数据是**增量**（`fetch-tdx-package.py` 每天跑一次），所以这里可能缺好几天——
 *   页面显示「数据截至哪天」，别让它看起来是今天的。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { BOARD_LABEL, boardOf } from "./model.ts";

const DIR = () => join(process.cwd(), "data", "backtest", "tdx-daily");

export type CloseRow = {
  id: string;
  code: string;
  name: string;
  price: number;
  /** 涨跌幅（由盘后包的昨收算，不依赖任何快照源） */
  chg: number;
  /** 成交额，元 */
  amount: number;
  /** 成交量，股（注意这个源全是股，不是手） */
  volume: number;
  board: string;
};

export type CloseSnapshot = {
  /** 数据截至哪天 */
  date: string;
  fetchedAt: string;
  /** 全市场只有的板块（本页的重点） */
  bjCount: number;
  totalCount: number;
  /** 成交额 TOP N（全市场，含北交所但通常排不上） */
  top: CloseRow[];
  /**
   * **北交所成交额前 N**。为什么单列：全市场 TOP20 里一只北交所都没有
   * （2026-10-14 实测），流动性差着两个数量级——所以「含北交所 349 只」
   * 这句话在 TOP 榜上看不出来。**这一块是页面别处真拿不到的数据**
   *（腾讯和新浪都挡掉 bj），单列出来才兑现得了。
   */
  bjTop: CloseRow[];
};

export const getCloseSnapshot = createServerFn({ method: "GET" })
  .validator((input: unknown): { limit: number } => {
    const v = (input ?? {}) as Record<string, unknown>;
    const n = typeof v.limit === "number" ? v.limit : 20;
    return { limit: Math.max(5, Math.min(50, Math.round(n))) };
  })
  .handler(async ({ data }): Promise<{ snapshot: CloseSnapshot | null; why: string | null }> => {
    const dir = DIR();
    let latest = "";
    try {
      const names = (await readdir(dir))
        .filter((n) => n.endsWith(".json"))
        .sort();
      latest = names[names.length - 1] ?? "";
    } catch {
      return {
        snapshot: null,
        why: "还没抓过盘后包。跑一次 python3 scripts/fetch-tdx-package.py（收盘后数小时才有当天的包）",
      };
    }
    if (!latest) {
      return { snapshot: null, why: `目录 ${dir} 里还没有 json 文件` };
    }

    try {
      const raw = JSON.parse(await readFile(join(dir, latest), "utf-8")) as {
        date?: string;
        fetchedAt?: string;
        rows?: { id: string; code: string; name: string; close: number; prevClose: number; amount: number; volume: number }[];
      };
      const rows = Array.isArray(raw.rows) ? raw.rows : [];
      if (rows.length === 0) {
        return { snapshot: null, why: `${latest} 里没有数据行` };
      }
      const mapped: CloseRow[] = rows.map((r) => {
        const prev = Number(r.prevClose);
        const close = Number(r.close);
        // 涨跌幅由盘后包自己的昨收算——**不借任何快照源**，这是这一块的意义
        const chg = prev > 0 && Number.isFinite(close) ? ((close - prev) / prev) * 100 : 0;
        const board = boardOf(r.id);
        return {
          id: r.id,
          code: r.code,
          name: r.name,
          price: close,
          chg,
          amount: Number(r.amount) || 0,
          volume: Number(r.volume) || 0,
          board: BOARD_LABEL[board] ?? board,
        };
      });
      const byAmount = [...mapped].sort((a, b) => b.amount - a.amount);
      const top = byAmount.slice(0, data.limit);
      const bjTop = mapped.filter((r) => r.id.startsWith("bj")).sort((a, b) => b.amount - a.amount).slice(0, 5);
      return {
        snapshot: {
          date: raw.date ?? latest.replace(".json", ""),
          fetchedAt: raw.fetchedAt ?? "",
          bjCount: bjTop.length > 0 ? mapped.filter((r) => r.id.startsWith("bj")).length : 0,
          totalCount: mapped.length,
          top,
          bjTop,
        },
        why: null,
      };
    } catch (error) {
      return { snapshot: null, why: `读 ${latest} 失败：${error instanceof Error ? error.message : String(error)}` };
    }
  });