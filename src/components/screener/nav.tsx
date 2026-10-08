/**
 * 这个文件是干什么的：
 * 每个页面顶上共用的那一排。原来是一条品牌红横幅，参考财联社；现在收成
 * 「2px 品牌线 + 中性色的名字、页签、按钮」，参考 design/app.html。
 * 点「选股 / 持仓 / 消息 / 个股 / 资金」换页，点「显示」改字号和深浅色。
 *
 * 你需要知道的：
 * 字号和明暗只存在这台浏览器里，不改账，也不改买入价。
 */

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Bell, RefreshCw, Search } from "lucide-react";
import { getQuickSearch } from "@/lib/market/quotes.functions";

/** 桌面端左侧分组导航（PPT 新信息架构）。窄屏隐藏，改用顶栏下的页签。 */
const SIDEBAR: { label: string; items: { to: "/" | "/screener" | "/factors" | "/positions" | "/news" | "/flow" | "/symbol"; label: string }[] }[] = [
  { label: "工作台", items: [{ to: "/", label: "主控台" }] },
  {
    label: "策略研究",
    items: [
      { to: "/screener", label: "策略选股" },
      { to: "/factors", label: "因子发掘" },
      { to: "/positions", label: "策略追踪" },
    ],
  },
  {
    label: "市场情报",
    items: [
      { to: "/news", label: "消息追踪" },
      { to: "/flow", label: "资金流向" },
      { to: "/symbol", label: "个股查询" },
    ],
  },
];

function SideNav() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  return (
    <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-line md:flex">
      <Link to="/" className="flex items-center gap-2 px-4 pt-4 pb-2">
        <span className="h-4 w-[3px] rounded-full bg-brand" aria-hidden />
        <span className="text-[15px] font-medium tracking-widest">赤轨</span>
        <span className="text-xs text-muted">策略实验台</span>
      </Link>
      <nav className="flex-1 overflow-y-auto scroll-slim px-2 pb-4" aria-label="主导航">
        {SIDEBAR.map((group) => (
          <div key={group.label}>
            <div className="px-3 pt-4 pb-1 text-[10px] tracking-widest text-muted">{group.label}</div>
            {group.items.map((item) => {
              const active = path === item.to;
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  aria-current={active ? "page" : undefined}
                  className={
                    "block rounded px-3 py-2 text-sm " +
                    (active ? "bg-brand-soft font-medium text-brand-text" : "text-muted hover:bg-surface-2 hover:text-fg")
                  }
                >
                  {item.label}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>
    </aside>
  );
}

/**
 * 顶栏全局搜索（⌘K）。输入名称或六位代码，下拉出最多 8 只，回车或点选跳到个股页。
 * 数据走 getQuickSearch（服务端在缓存的全市场名单里过滤），不打断当前页。
 */
function QuickSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { data } = useQuery({
    queryKey: ["quick-search", q],
    queryFn: () => getQuickSearch({ data: { q } }),
    enabled: q.trim().length > 0,
    staleTime: 30_000,
  });
  const matches = data?.matches ?? [];

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function jump(code: string) {
    setOpen(false);
    setQ("");
    void navigate({ to: "/symbol", search: { q: code } });
  }

  return (
    <div className="relative min-w-0 flex-1 md:max-w-sm">
      <Search className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" aria-hidden />
      <input
        ref={inputRef}
        value={q}
        onChange={(event) => {
          setQ(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && matches[0]) jump(matches[0].code);
          if (event.key === "Escape") {
            setQ("");
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
        placeholder="搜索股票代码或名称"
        aria-label="全局搜索"
        className="w-full rounded border border-line bg-surface py-1.5 pr-12 pl-8 text-sm text-fg placeholder:text-muted focus:border-accent"
      />
      <kbd className="kbd absolute top-1/2 right-2 -translate-y-1/2" aria-hidden>
        ⌘K
      </kbd>
      {open && q.trim() && (
        <div className="absolute z-30 mt-1 w-full min-w-56 overflow-hidden rounded border border-line bg-surface shadow-pop">
          {matches.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted">没有匹配的股票</div>
          ) : (
            matches.map((item) => (
              <button
                key={item.id}
                type="button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => jump(item.code)}
                className="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2"
              >
                <span className="min-w-0">
                  <span className="text-fg">{item.name}</span>
                  <span className="ml-2 text-xs text-muted">{item.code}</span>
                </span>
                <span className={"text-xs tabular-nums " + (item.chg == null || item.chg === 0 ? "text-muted" : item.chg > 0 ? "text-up" : "text-down")}>
                  {item.chg == null ? "—" : `${item.chg > 0 ? "+" : ""}${item.chg.toFixed(2)}%`}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}

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
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0b0e15" : "#f5f6f8");
}

/**
 * 明暗轮换：系统 → 浅色 → 深色 → 系统。快捷键 `t` 调它。
 *
 * 为什么是独立函数而不是让快捷键去动组件：`useTheme` 是组件内 state，快捷键拿不到它。
 * 所以改完 localStorage 之后必须**再发一个事件通知**「显示」那排按钮更新选中态——
 * 否则主题已经换了、按钮还停在旧的一档，看起来像没生效。
 */
export function cycleTheme(): void {
  const order = THEMES.map((item) => item.id);
  const current = localStorage.getItem("chiheng-theme") ?? "system";
  const at = order.indexOf(current as (typeof order)[number]);
  const next = order[(at + 1) % order.length] ?? "system";
  applyTheme(next);
  localStorage.setItem("chiheng-theme", next);
  window.dispatchEvent(new CustomEvent("chiheng-theme-change", { detail: next }));
}

function useTheme() {
  const [mode, setMode] = useState("system");
  useEffect(() => {
    const saved = localStorage.getItem("chiheng-theme");
    if (saved === "light" || saved === "dark" || saved === "system") setMode(saved);
  }, []);
  // 快捷键 t 改了 localStorage 之后，这里要跟着走 —— 见 cycleTheme 的注释。
  useEffect(() => {
    const onChange = (event: Event) => {
      const next = (event as CustomEvent<string>).detail;
      if (next === "light" || next === "dark" || next === "system") setMode(next);
    };
    window.addEventListener("chiheng-theme-change", onChange);
    return () => window.removeEventListener("chiheng-theme-change", onChange);
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
          className={"rounded-full px-2.5 py-1.5 text-xs " + (mode === item.id ? "bg-surface text-fg" : "text-muted")}
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
          className={"rounded-full px-2.5 py-1.5 text-xs " + (size === item.id ? "bg-surface text-fg" : "text-muted")}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/** 窄屏用的页签条。桌面端主导航在左侧边栏，这个只在 768px 以下出现。 */
export function TopNav() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const items = SIDEBAR.flatMap((group) => group.items);
  return (
    <nav className="flex w-full gap-0.5 overflow-x-auto scroll-slim px-3 pb-2" aria-label="页面">
      {items.map((link) => (
        <Link
          key={link.to}
          to={link.to}
          className={
            "nav-tab inline-flex shrink-0 items-center rounded text-sm " +
            // aria-current 给读屏器；视觉上靠 surface-2 那块垫底
            (path === link.to
              ? "bg-surface-2 font-medium text-fg"
              : "text-muted hover:bg-surface-2 hover:text-fg")
          }
          aria-current={path === link.to ? "page" : undefined}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

/** 每个页面的外壳。桌面端是「左侧分组导航 + 顶栏」两栏（PPT 新信息架构）；
 *  窄屏收成单栏，导航退化成顶栏下的一排页签。
 *  aside、extra 是顶栏下面额外的一行（页面状态、指数条）。wide 给主控台用，
 *  内容区放宽到 1440，其余页面保持 max-w-3xl 的阅读宽度。 */
export function Frame({
  aside,
  extra,
  onRefresh,
  wide = false,
  children,
}: {
  aside?: ReactNode;
  extra?: ReactNode;
  onRefresh?: () => void | Promise<void>;
  /** 主控台这类一屏一任务的宽页面用 true，其余阅读型页面保持窄栏 */
  wide?: boolean;
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
    <div className="min-h-screen md:flex">
      {/* 全站唯一的大面积用色：品牌条。窄屏在顶上（2px），桌面端是侧边栏 logo 旁那一竖 */}
      <div className="h-0.5 bg-brand md:hidden" aria-hidden />
      <SideNav />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-20 border-b border-line bg-bg/95 backdrop-blur-md">
          <div className="flex h-12 items-center gap-3 px-3 md:px-4">
            <Link to="/" className="flex shrink-0 items-center gap-1.5 md:hidden">
              <span className="h-4 w-[3px] rounded-full bg-brand" aria-hidden />
              <span className="text-[15px] font-medium tracking-widest">赤轨</span>
            </Link>
            <QuickSearch />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <Link
                to="/news"
                aria-label="消息追踪"
                className="inline-flex h-8 items-center rounded border border-line bg-surface px-2.5 text-muted hover:bg-surface-2 hover:text-fg"
              >
                <Bell className="size-3.5" />
              </Link>
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-line bg-surface px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-60"
              >
                <RefreshCw className={"size-3.5 " + (refreshing ? "animate-spin" : "")} />
                <span className="hidden sm:inline">刷新</span>
              </button>
              <details className="relative shrink-0">
                <summary className="cursor-pointer list-none rounded border border-line bg-surface px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg [&::-webkit-details-marker]:hidden">显示</summary>
                <div className="absolute right-0 z-30 mt-2 flex flex-col gap-2 rounded border border-line bg-surface p-2">
                  <ThemeMode />
                  <TypeSize />
                </div>
              </details>
            </div>
          </div>
          <div className="md:hidden">
            <TopNav />
          </div>
          {aside || extra ? (
            <div className="px-3 pb-2 md:px-4">
              {aside}
              {extra}
            </div>
          ) : null}
        </header>
        <main
          className={
            "mx-auto flex w-full flex-1 flex-col gap-3 px-3 py-3 md:px-4 " +
            (wide ? "max-w-[1440px]" : "max-w-3xl")
          }
        >
          {children}
        </main>
      </div>
    </div>
  );
}
