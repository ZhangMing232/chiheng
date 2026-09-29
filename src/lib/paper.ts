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
  style?: "early" | "trend" | "breakout" | "value" | "relay";
  hold?: number;
  exit: number | null;
  exitDate: string | null;
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
  settle: (date: string, id: string, exit: number, exitDate: string, entry: number) => void;
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
      settle: (date, id, exit, exitDate, entry) => {
        set({
          days: get().days.map((day) => {
            if (day.date !== date) return day;
            return {
              ...day,
              trades: day.trades.map((trade) => {
                if (trade.id !== id || trade.exit != null) return trade;
                return { ...trade, entry: entry > 0 ? entry : trade.entry, exit, exitDate };
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
