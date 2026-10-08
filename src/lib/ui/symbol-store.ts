/**
 * 这个文件是干什么的：
 * 个股抽屉的全局状态：现在打开的是哪只票、从哪个页面点开的。
 *
 * 你需要知道的：
 * 1. **为什么是全局 store 而不是 useState**：抽屉状态原先在 `screener.tsx` 里，是一个
 *    `useState`，所以只有选股页能用。而 PPT 要求的「点任意股票名滑出抽屉、不离开
 *    当前页」意味着持仓页、资金页、消息页都要能开——它们和选股页不在同一个组件树里，
 *    Context 要套四层 Provider，zustand 一行就够（项目本来就在用，`src/lib/paper.ts`）。
 * 2. **`source` 是给抽屉内容用的**：从持仓页点进来的要显示「所属策略」，从资金页点进来
 *    的重点是资金流。抽屉据此决定哪几块放前面，不是装饰。
 */

import { create } from "zustand";

/** 从哪个页面点开的。null = 不是从页面点开的（快捷键、Toast 等）。 */
export type SymbolSource = "screener" | "positions" | "flow" | "news" | "alert" | null;

/**
 * 选股页额外知道的东西：这只票在当前模型里的得分和入选理由。
 * 别的页面不知道这两个数（它们只看得到行情和账本），所以是可选的——
 * 抽屉拿不到就显示「未参加当前模型」，不能编一个分数出来。
 */
export type SymbolNote = {
  score: number | null;
  reasons: string[];
};

type SymbolUiState = {
  /** 当前打开的股票 id（sh600519 这种带市场前缀的），null = 关闭 */
  id: string | null;
  source: SymbolSource;
  note: SymbolNote | null;
  open: (id: string, source?: SymbolSource, note?: SymbolNote | null) => void;
  close: () => void;
};

export const useSymbolUi = create<SymbolUiState>()((set) => ({
  id: null,
  source: null,
  note: null,
  open: (id, source = null, note = null) => set({ id, source, note }),
  close: () => set({ id: null, source: null, note: null }),
}));