/**
 * 这个文件是干什么的：
 * 每个页面顶上共用的那一排，参考财联社的版面：红色品牌条、扁平页签、刷新，以及字号和明暗。
 * 点「选股 / 消息 / 个股 / 资金」换页，点「显示」改字号和深浅色。
 *
 * 你需要知道的：
 * 字号和明暗只存在这台浏览器里，不改账，也不改买入价。
 */

import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";

const LINKS = [
  { to: "/", label: "选股" },
  { to: "/news", label: "消息" },
  { to: "/symbol", label: "个股" },
  { to: "/flow", label: "资金" },
] as const;

const TYPE_SIZES = [
  { id: "14", label: "小" },
  { id: "16", label: "标准" },
  { id: "18", label: "大" },
  { id: "20", label: "超大" },
] as const;

function useTypeSize() {
  const [size, setSize] = useState("16");
  useEffect(() => {
    const saved = localStorage.getItem("chiheng-type");
    if (TYPE_SIZES.some((item) => item.id === saved)) setSize(saved!);
  }, []);
  useEffect(() => {
    document.documentElement.style.fontSize = `${size}px`;
    localStorage.setItem("chiheng-type", size);
  }, [size]);
  return [size, setSize] as const;
}

const THEMES = [
  { id: "system", label: "系统" },
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
] as const;

function applyTheme(mode: string) {
  const root = document.documentElement;
  if (mode === "light" || mode === "dark") root.dataset.theme = mode;
  else delete root.dataset.theme;
  const dark = mode === "dark" || (mode !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0e1218" : "#f5f6f8");
}

function useTheme() {
  const [mode, setMode] = useState("system");
  useEffect(() => {
    const saved = localStorage.getItem("chiheng-theme");
    if (saved === "light" || saved === "dark" || saved === "system") setMode(saved);
  }, []);
  useEffect(() => {
    applyTheme(mode);
    localStorage.setItem("chiheng-theme", mode);
    if (mode !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode]);
  return [mode, setMode] as const;
}

/** 浅色、深色，或跟系统走。点中的那一项会记在这台浏览器里。 */
export function ThemeMode() {
  const [mode, setMode] = useTheme();
  return (
    <div className="flex rounded-full bg-surface-2 p-0.5" aria-label="明暗">
      {THEMES.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => setMode(item.id)}
          className={"rounded-full px-2 py-1 text-xs " + (mode === item.id ? "bg-surface text-fg" : "text-muted")}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** 把整页字号调成小、标准、大或超大。选好后立刻生效，并记在本地。 */
export function TypeSize() {
  const [size, setSize] = useTypeSize();
  return (
    <div className="flex rounded-full bg-surface-2 p-0.5" aria-label="字号">
      {TYPE_SIZES.map((item) => (
        <button
          key={item.id}
          type="button"
          onClick={() => setSize(item.id)}
          className={"rounded-full px-2 py-1 text-xs " + (size === item.id ? "bg-surface text-fg" : "text-muted")}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** 四个页面入口，财联社式扁平页签：选中的那页标红加底线。 */
export function TopNav() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  return (
    <nav className="flex min-w-0 flex-1 gap-5 overflow-x-auto scroll-slim">
      {LINKS.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          className={"shrink-0 border-b-2 py-2 text-sm " + (path === link.to ? "border-brand font-medium text-brand" : "border-transparent text-muted")}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

/** 每个页面的外壳：顶部品牌红条、导航、刷新和「显示」。aside、extra 是顶栏里额外的一行。 */
export function Frame({
  aside,
  extra,
  onRefresh,
  children,
}: {
  aside?: ReactNode;
  extra?: ReactNode;
  onRefresh?: () => void | Promise<void>;
  children: ReactNode;
}) {
  const router = useRouter();
  const [refreshing, setRefreshing] = useState(false);
  async function refresh() {
    setRefreshing(true);
    try {
      if (onRefresh) await onRefresh();
      else await router.invalidate();
    } finally {
      setRefreshing(false);
    }
  }
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20">
        <div className="bg-brand text-white">
          <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 pt-3 pb-2 md:px-6">
            <Link to="/" className="flex items-center gap-2">
              <svg viewBox="0 0 72 24" className="h-6 w-18" aria-hidden>
                <rect x="0" y="12" width="30" height="8" fill="currentColor" />
                <rect x="42" y="2" width="30" height="8" fill="currentColor" opacity="0.6" />
              </svg>
              <span className="text-xl font-semibold tracking-tight">赤轨</span>
            </Link>
            <span className="hidden text-xs text-white/70 sm:inline">A股自动选股</span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-white/40 px-3 text-sm text-white disabled:opacity-60"
              >
                <RefreshCw className={"size-3.5 " + (refreshing ? "animate-spin" : "")} />
                刷新
              </button>
              <details className="relative shrink-0">
                <summary className="cursor-pointer list-none rounded-md border border-white/40 px-2.5 py-1.5 text-xs text-white [&::-webkit-details-marker]:hidden">显示</summary>
                <div className="absolute right-0 z-30 mt-2 flex flex-col gap-2 rounded-md border border-line bg-surface p-2 shadow-card">
                  <ThemeMode />
                  <TypeSize />
                </div>
              </details>
            </div>
          </div>
        </div>
        <div className="border-b border-line bg-bg/95 backdrop-blur-md">
          <div className="mx-auto max-w-3xl px-4 md:px-6">
            <div className="flex items-center gap-3">
              <TopNav />
            </div>
            {aside ? <div className="pb-2">{aside}</div> : null}
            {extra}
          </div>
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 md:px-6">{children}</main>
    </div>
  );
}
