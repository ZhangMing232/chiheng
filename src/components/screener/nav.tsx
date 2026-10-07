/**
 * 这个文件是干什么的：
 * 每个页面顶上共用的那一排。原来是一条品牌红横幅，参考财联社；现在收成
 * 「2px 品牌线 + 中性色的名字、页签、按钮」，参考 design/app.html。
 * 点「选股 / 持仓 / 消息 / 个股 / 资金」换页，点「显示」改字号和深浅色。
 *
 * 你需要知道的：
 * 字号和明暗只存在这台浏览器里，不改账，也不改买入价。
 */

import { useEffect, useState, type ReactNode } from "react";
import { Link, useRouter, useRouterState } from "@tanstack/react-router";
import { RefreshCw } from "lucide-react";

const LINKS = [
  { to: "/", label: "选股" },
  // 持仓从选股页里拆出来之后给了独立入口，放在选股后面——盯盘时第二常看的就是它
  { to: "/positions", label: "持仓" },
  { to: "/news", label: "消息" },
  { to: "/symbol", label: "个股" },
  { to: "/flow", label: "资金" },
  // 因子研究：这一页不是盯盘用的，是看「这套规则到底有没有信号」的判据，放最后
  { to: "/factors", label: "因子" },
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

/** 四个页面入口。选中态用 surface-2 垫底，不再用红线加红字——
 *  之前选中的页签是全页唯一一处品牌色，五个页签抢一个颜色，反而哪页都不突出。
 *  品牌色现在只留给顶部那条 2px 品牌条和焦点环（见 styles.css 的注释）。 */
export function TopNav() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  return (
    <nav className="order-last -mx-1 flex w-full min-w-0 gap-0.5 overflow-x-auto scroll-slim md:order-none md:ml-auto md:w-auto">
      {LINKS.map((link) => (
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

/** 每个页面的外壳。原来的顶部是一整条品牌红横幅（logo、标题、按钮全在红底上），
 *  那是券商 App 的门面：颜色只证明了「这是个行情软件」，别的什么都没说。
 *  现在照 app.html 收掉：一条 2px 品牌线 + 中性色的名字和页签。
 *  aside、extra 是顶栏下面额外的一行（页面状态、指数条）。 */
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
      {/* 全站唯一的大面积用色：顶上这条 2px。正文区全中性灰，颜色是稀缺资源 */}
      <div className="h-0.5 bg-brand" aria-hidden />
      <header className="sticky top-0 z-20 border-b border-line bg-bg/95 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 px-4 pt-1 md:px-6">
          <Link to="/" className="flex shrink-0 items-center gap-2 py-2">
            <span className="h-4 w-[3px] rounded-full bg-brand" aria-hidden />
            <span className="text-[15px] font-medium tracking-widest">赤轨</span>
            <span className="hidden text-xs text-muted sm:inline">策略实验台</span>
          </Link>
          <TopNav />
          <div className="ml-auto flex shrink-0 items-center gap-2 py-2 md:ml-0">
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={refreshing}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-line bg-surface px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-60"
            >
              <RefreshCw className={"size-3.5 " + (refreshing ? "animate-spin" : "")} />
              刷新
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
        {aside || extra ? (
          <div className="mx-auto max-w-3xl px-4 pb-2 md:px-6">
            {aside}
            {extra}
          </div>
        ) : null}
      </header>
      <main className="mx-auto flex max-w-3xl flex-col gap-3 px-3 py-3 md:px-6">{children}</main>
    </div>
  );
}
