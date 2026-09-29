import { create } from "zustand";
import { persist } from "zustand/middleware";

type AccountState = {
  capital: number;
  slotPct: number;
  setCapital: (capital: number) => void;
  setSlotPct: (slotPct: number) => void;
};

export const useAccount = create<AccountState>()(
  persist(
    (set) => ({
      capital: 100_000,
      slotPct: 10,
      setCapital: (capital) => set({ capital: Math.max(0, capital) }),
      setSlotPct: (slotPct) => set({ slotPct: Math.min(20, Math.max(1, slotPct)) }),
    }),
    { name: "chiheng-account", skipHydration: true },
  ),
);
