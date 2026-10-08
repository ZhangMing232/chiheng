/**
 * 这个文件是干什么的：
 * 浏览器里的模拟账本。按天记下买了哪几只、买入价多少，以及后来卖在什么价。
 *
 * 你需要知道的：
 * 账存在这台浏览器本地，不会上传。同一天、同一套策略、同一只股票只记一次，记下的成交不会被改掉。
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type PaperTrade = {
  id: string;
  code: string;
  name: string;
  entry: number;
  stop?: number;
  target?: number;
  style?: "early" | "trend" | "breakout" | "value" | "relay" | "rebound";
  hold?: number;
  exit: number | null;
  exitDate: string | null;
  /**
   * 卖出价是「盘中现价快照」（intraday）还是「日线撮合」（daily）。
   * **没这个字段 = 修复之前记的旧账**：那一律按计划价记账、没做跳空修正，
   * 账面系统性偏乐观（见 data/books/PRE-FIX-NOTE.md）。
   * 两种口径可信度不同，统计时不该混在一起算。
   */
  exitKind?: "intraday" | "daily";
};

export type PaperDay = {
  date: string;
  savedAt: number;
  signalTime: string;
  status?: "provisional" | "locked";
  ruleVersion?: number;
  indexEntry: number | null;
  indexExit: number | null;
  trades: PaperTrade[];
};

type PaperState = {
  days: PaperDay[];
  recordDay: (day: PaperDay) => void;
  settle: (
    date: string,
    id: string,
    exit: number,
    exitDate: string,
    entry: number,
    /** 可选：这一笔的卖出价是哪把尺子量的。不传就当旧账（口径未知）。 */
    exitKind?: "intraday" | "daily",
  ) => void;
  settleIndex: (date: string, indexExit: number) => void;
};

/** 读写这笔模拟账。recordDay 记新买入，settle 记卖出，settleIndex 记沪深 300 的对照价。 */
export const usePaper = create<PaperState>()(
  persist(
    (set, get) => ({
      days: [],
      recordDay: (day) => {
        const existing = get().days.find((item) => item.date === day.date);
        if (!existing) {
          set({ days: [day, ...get().days].slice(0, 80) });
          return;
        }
        const ids = new Set(existing.trades.flatMap((trade) => {
          const style = trade.style;
          return style ? [`${style}:${trade.id}`] : [];
        }));
        const extras = day.trades.filter((trade) => trade.style && !ids.has(`${trade.style}:${trade.id}`));
        if (extras.length === 0) return;
        set({
          days: get().days.map((item) =>
            item.date === day.date ? { ...item, trades: [...item.trades, ...extras] } : item,
          ),
        });
      },
      settle: (date, id, exit, exitDate, entry, exitKind) => {
        set({
          days: get().days.map((day) => {
            if (day.date !== date) return day;
            return {
              ...day,
              trades: day.trades.map((trade) => {
                if (trade.id !== id || trade.exit != null) return trade;
                return {
                  ...trade,
                  entry: entry > 0 ? entry : trade.entry,
                  exit,
                  exitDate,
                  // 口径标记：现价快照还是日线撮合。没有它就分不清这本账是拿哪把尺子量的。
                  ...(exitKind ? { exitKind } : {}),
                };
              }),
            };
          }),
        });
      },
      settleIndex: (date, indexExit) => {
        set({
          days: get().days.map((day) => (day.date === date && day.indexExit == null ? { ...day, indexExit } : day)),
        });
      },
    }),
    { name: "chiheng-paper-v3", skipHydration: true },
  ),
);
