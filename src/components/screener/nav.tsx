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

export function TopNav() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  return (
    <nav className="flex rounded-full bg-surface-2 p-0.5">
      {LINKS.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          className={"rounded-full px-3 py-1 text-sm " + (path === link.to ? "bg-surface text-fg" : "text-muted")}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

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
      <header className="sticky top-0 z-20 border-b border-line bg-bg/90 backdrop-blur-md">
        <div className="mx-auto max-w-3xl px-4 md:px-6">
          <div className="flex min-h-14 flex-wrap items-center justify-between gap-2 py-2">
            <div className="flex min-w-0 items-center gap-3">
              <Link to="/" className="flex shrink-0 items-center gap-2 text-base font-semibold tracking-tight">
                <svg viewBox="0 0 32 32" className="size-6" aria-hidden>
                  <rect width="32" height="32" rx="8" fill="#161c25" />
                  <path d="M6 16h20" stroke="#8b95a6" strokeWidth="1.4" strokeLinecap="round" />
                  <circle cx="20" cy="16" r="2.2" fill="#f0535e" />
                </svg>
                候价
              </Link>
              <TopNav />
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {aside}
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                className="inline-flex h-8 items-center gap-1.5 rounded-full border border-line px-3 text-sm disabled:opacity-60"
              >
                <RefreshCw className={"size-3.5 " + (refreshing ? "animate-spin" : "")} />
                刷新
              </button>
              <details className="relative">
                <summary className="cursor-pointer list-none rounded-full px-2 py-1 text-xs text-muted [&::-webkit-details-marker]:hidden">显示</summary>
                <div className="absolute right-0 z-30 mt-2 flex flex-col gap-2 rounded-xl border border-line bg-surface p-2 shadow-card">
                  <ThemeMode />
                  <TypeSize />
                </div>
              </details>
            </div>
          </div>
          {extra}
        </div>
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-3 px-4 py-4 md:px-6">{children}</main>
    </div>
  );
}
