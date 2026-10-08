/**
 * 这个文件是干什么的：
 * 全局键盘管理器。所有快捷键在这里注册一次，各页面通过 `useHotkeys()` 挂自己的实现。
 *
 * 你需要知道的：
 * 1. **键位表 `HOTKEYS` 是唯一一份**，`?` 面板（shortcut-panel.tsx）直接渲染它。
 *    面板和实现分开写两份，文档必然会和代码漂。
 * 2. **F5 / ⌥F5 的区别是刻意的**：F5 只 `router.invalidate()` 复用 3 分钟缓存，
 *    ⌥F5 才真拉全市场。理由在 `quotes.functions.ts:34-38`——全量重拉 5200 只股票
 *    会把腾讯顶到 WAF（返回 501），K 线拉不到、结算就卡住。所以「按一下就重来一遍全网」
 *    这种语义很危险，放在需要按两次的 ⌥F5 上。
 * 3. **和输入框的冲突规则**（钉死，别改）：
 *    - 焦点在 input / textarea / select / contenteditable 时，除 Esc 外全部让位。
 *      F5 在输入框里按会立刻刷掉半句话，这个代价远大于「少一个快捷键」。
 *    - 带 metaKey / ctrlKey / altKey 的一律不劫持（⌘K、⌘R、⌥F5 除外，见下）。
 *    - `?` 只比 `e.key === "?"`，不手动拼 shift。
 * 4. **`onRun` 不做**（那会全量重拉，见第 2 条），F5 走 `onRefresh`。
 */
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { ShortcutPanel } from "@/components/screener/shortcut-panel";
import { useSymbolUi } from "@/lib/ui/symbol-store";

/** 各页面注册自己的实现。没注册的键按下什么都不做。 */
export type HotkeyHandlers = {
  /** F5 / r：刷新当前页（复用缓存） */
  onRefresh?: () => void | Promise<void>;
  /** ⌥F5：真去拉一遍全市场。危险，见文件头第 2 条 */
  onForceRefresh?: () => void | Promise<void>;
  /** ← →：切换策略 */
  onCycleStyle?: (dir: -1 | 1) => void;
  /** 1-6：直接选第 N 套策略 */
  onPickStyle?: (index: number) => void;
  /** t：深浅色轮换 */
  onToggleTheme?: () => void;
};

/**
 * 键位表。`?` 面板渲染它，实现也按它注册——**改这里就等于改了快捷键**，
 * 不要在别处另写一份文案。
 */
export const HOTKEYS: { keys: string[]; label: string; desc: string; group: string }[] = [
  { keys: ["⌘", "K"], label: "全局搜索", desc: "跳到顶栏搜索框，输入代码或名称搜全市场", group: "页面" },
  { keys: ["F5"], label: "刷新", desc: "重跑当前页的 loader，复用行情缓存", group: "页面" },
  { keys: ["⌥", "F5"], label: "强制重拉行情", desc: "绕过缓存真拉一遍全市场。慢，且腾讯可能限流", group: "页面" },
  { keys: ["r"], label: "刷新", desc: "和 F5 同一件事", group: "页面" },
  { keys: ["←", "→"], label: "切换策略", desc: "在启用的策略之间循环", group: "选股" },
  { keys: ["1", "…", "6"], label: "直接选策略", desc: "按序号切到第 N 套", group: "选股" },
  { keys: ["t"], label: "深浅色", desc: "系统 / 浅色 / 深色轮着切", group: "页面" },
  { keys: ["Esc"], label: "关闭", desc: "关掉抽屉或这张表", group: "页面" },
  { keys: ["?"], label: "快捷键面板", desc: "打开 / 关闭这张表", group: "页面" },
];

const HotkeyContext = createContext<{ setTarget: (target: HotkeyHandlers) => void }>({ setTarget: () => {} });

/** 焦点在可编辑元素里吗。Esc 之外的所有键位都要给它让位。 */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true'], [contenteditable='']"));
}

export function HotkeyProvider({ children }: { children: ReactNode }) {
  const [panelOpen, setPanelOpen] = useState(false);
  const closeSymbol = useSymbolUi((s) => s.close);
  // 用 ref 存 handlers：页面每次渲染都会传新对象字面量，
  // 塞进 state 会让监听反复重绑；ref 只在读取时拿最新值。
  const targetRef = useRef<HotkeyHandlers>({});
  const setTarget = useCallback((target: HotkeyHandlers) => {
    targetRef.current = target;
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const handlers = targetRef.current;

      // Esc 永远生效：抽屉和快捷键面板都要能随手关掉，包括焦点在输入框里的时候。
      if (event.key === "Escape") {
        if (panelOpen) setPanelOpen(false);
        else closeSymbol();
        return;
      }
      // ⌘K / ⌘R / ⌘⇧I 等一律不劫持，交给浏览器。
      if (event.metaKey || event.ctrlKey) return;
      // ⌥F5 是本项目唯一要用的带修饰键组合，先于 altKey 通用拦截处理。
      if (event.altKey) {
        if (event.key === "F5" && handlers.onForceRefresh) {
          event.preventDefault();
          void handlers.onForceRefresh();
        }
        return;
      }
      if (isEditable(event.target)) return;

      switch (event.key) {
        case "F5":
          if (handlers.onRefresh) {
            event.preventDefault();
            void handlers.onRefresh();
          }
          return;
        case "r":
          if (handlers.onRefresh) {
            event.preventDefault();
            void handlers.onRefresh();
          }
          return;
        case "t":
          if (handlers.onToggleTheme) {
            event.preventDefault();
            handlers.onToggleTheme();
          }
          return;
        case "?":
          event.preventDefault();
          setPanelOpen((v) => !v);
          return;
        case "ArrowLeft":
          if (handlers.onCycleStyle) {
            event.preventDefault();
            handlers.onCycleStyle(-1);
          }
          return;
        case "ArrowRight":
          if (handlers.onCycleStyle) {
            event.preventDefault();
            handlers.onCycleStyle(1);
          }
          return;
        default: {
          // 1-6 直选策略。只在注册了 onPickStyle 的页面生效。
          const n = Number(event.key);
          if (Number.isInteger(n) && n >= 1 && n <= 6 && handlers.onPickStyle) {
            event.preventDefault();
            handlers.onPickStyle(n);
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [closeSymbol, panelOpen]);

  return (
    <HotkeyContext.Provider value={{ setTarget }}>
      {children}
      <ShortcutPanel open={panelOpen} onClose={() => setPanelOpen(false)} />
    </HotkeyContext.Provider>
  );
}

/**
 * 页面用它注册自己的实现。**全项目只有几个地方调**，都挂在各自的内容组件上。
 *
 * 传对象字面量就行——每次渲染重建没关系，handlers 最终存在 ref 里。
 */
export function useHotkeys(target: HotkeyHandlers): void {
  const { setTarget } = useContext(HotkeyContext);
  useEffect(() => {
    setTarget(target);
  }, [target, setTarget]);
}