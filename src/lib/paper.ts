import { create } from "zustand";
import { persist } from "zustand/middleware";
import { dayLocked } from "@/lib/market/journal-book";

export type PaperTrade = {
  id: string;
  code: string;
  name: string;
  entry: number;
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
        if (dayLocked(existing)) {
          if (existing.indexEntry == null && day.indexEntry != null) {
            set({
              days: get().days.map((item) =>
                item.date === day.date ? { ...item, indexEntry: day.indexEntry } : item,
              ),
            });
          }
          return;
        }
        set({
          days: get().days.map((item) => (item.date === day.date ? day : item)),
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
    { name: "chiheng-paper-v2", skipHydration: true },
  ),
);
