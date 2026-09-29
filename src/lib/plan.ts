import { create } from "zustand";
import { persist } from "zustand/middleware";

type PlanState = {
  holdDays: number;
  exitRule: string;
  maxLoss: number;
  savedAt: number | null;
  save: (holdDays: number, exitRule: string, maxLoss: number) => void;
  clear: () => void;
};

export const usePlan = create<PlanState>()(
  persist(
    (set) => ({
      holdDays: 0,
      exitRule: "",
      maxLoss: 0,
      savedAt: null,
      save: (holdDays, exitRule, maxLoss) => set({ holdDays, exitRule, maxLoss, savedAt: Date.now() }),
      clear: () => set({ holdDays: 0, exitRule: "", maxLoss: 0, savedAt: null }),
    }),
    { name: "chiheng-plan", skipHydration: true },
  ),
);
