import { create } from "zustand";
import { persist } from "zustand/middleware";

type WatchState = {
  ids: string[];
  toggle: (id: string) => void;
};

export const useWatch = create<WatchState>()(
  persist(
    (set, get) => ({
      ids: [],
      toggle: (id) => {
        const ids = get().ids;
        set({ ids: ids.includes(id) ? ids.filter((item) => item !== id) : [id, ...ids] });
      },
    }),
    { name: "chiheng-watch", skipHydration: true },
  ),
);
