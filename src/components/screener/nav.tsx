/**
 * 这个文件是干什么的：
 * 每个页面顶上共用的那一排。原来是一条品牌红横幅，参考财联社；现在收成
 * 「2px 品牌线 + 中性色的名字、页签、按钮」，参考 design/app.html。
 * 点「选股 / 持仓 / 消息 / 个股 / 资金」换页，点「显示」改字号和深浅色。
 *
 * 你需要知道的：
 * 字号和明暗只存在这台浏览器里，不改账，也不改买入价。
 */

import { DecorBackdrop, DecorHeader, DecorOrnament } from "@/components/page-decor";
import { decorFor } from "@/lib/ui/page-decor";
import { useHotkeys } from "@/lib/ui/hotkeys";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate, useRouter, useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  Bell,
  Bot,
  ChevronDown,
  FileSearch,
  FlaskConical,
  Gauge,
  Globe,
  History,
  Image,
  LayoutDashboard,
  LayoutList,
  LineChart,
  Menu,
  Newspaper,
  RefreshCw,
  Search,
  Settings,
  Settings2,
  Sparkles,
  Star,
  type LucideIcon,
} from "lucide-react";
import { getPushStatus, getQuickSearch, getRecorder, getSellAlerts, savePushConfig } from "@/lib/market/quotes.functions";
import { isPaidPlan, planLabel } from "@/lib/auth/plan";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { snapshotAge } from "@/lib/market/format";

/** 顶栏账号入口：已登录显示邮箱（或名字）+ 付费档位徽章，点进 /membership 看档位与定价；
 *  未登录显示「登录」。会话解析中渲染空，不闪。 */
function AccountChip() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) return null;
  if (!user) {
    return (
      <Link
        to="/login"
        className="inline-flex h-8 shrink-0 items-center rounded border border-line bg-surface px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg"
      >
        登录
      </Link>
    );
  }
  const label = user.primaryEmail ?? user.displayName ?? user.id;
  const short = label.length > 14 ? `${label.slice(0, 13)}…` : label;
  return (
    <Link
      to="/membership"
      title={`${label} · ${planLabel(user.plan)}`}
      className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-line bg-surface px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg"
    >
      <span className="max-w-36 truncate">{short}</span>
      {isPaidPlan(user.plan) && (
        <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[10px] font-medium text-brand-text">
          {planLabel(user.plan)}
        </span>
      )}
    </Link>
  );
}


/**
 * 左侧分组导航。2026-10-26 按《UI 升级方案》（design/ui-upgrade-2026-10.md）
 * 重组成七组信息架构：
 *
 *   总览 / 市场 / 资讯 / 研究 / 组合 / 进化 / AI，外加设置。
 *
 * 这轮动了什么（对照上一版 5 组）：
 *   - 新增「总览」组承载首页（当前指向 /，P0-4 首页落地后由新首页接管）
 *   - 「资讯」独立成组：快讯 / 消息提醒 / 自媒体图文（老板拍板：studio 保持独立入口）
 *   - 「进化」从「策略因子」改名并收编策略看板：策略看板 / 因子实验室 / 回测
 *     （挑战者、进化日志两个入口等 P0-6 的独立页落地后再加，不挂死链）
 *   - AI 从底部 pinned 单链扩成整组：工作台 / 大管家 / 接口与模型 / 行为边界
 *   - admin / membership 按方案藏出侧栏（直链可达，会员功能落地后再亮出）
 *   - 板块、日历、模拟持仓维持重定向现状：它们的真实页面在资金流向/复盘/策略追踪下，
 *     侧栏不再单列，避免和二级子页撞车
 *
 * 保留的三条老原则：
 *   1. 最多两级（分组 + 页面）；第三级只许在页面里切，不占侧栏
 *   2. 顺序按每天使用先后：先看总览 → 市场 → 资讯 → 研究 → 组合 → 进化 → AI
 *   3. 旧路由全部留重定向文件，书签不断链
 */
const SIDEBAR: {
  label: string;
  items: { to: "/" | "/overview" | "/review" | "/overseas" | "/news" | "/inbox" | "/studio" | "/research" | "/my-stocks" | "/strategies/screener" | "/factors" | "/backtest" | "/ai" | "/butler" | "/ai/config" | "/settings"; label: string; icon: LucideIcon }[];
}[] = [
  { label: "总览", items: [{ to: "/", label: "总览", icon: LayoutDashboard }] },
  {
    label: "市场",
    items: [
      { to: "/overview", label: "涨跌分布", icon: Gauge },
      // 2026-10-26 三合一：每日复盘 / 资金流向 / 信号 / 公司事件合成一个「每日复盘」页，
      // 里面二级 tab 切换（SectionTabs），侧栏不再平铺四个入口。
      { to: "/review", label: "每日复盘", icon: History },
      { to: "/overseas", label: "全球行情", icon: Globe },
    ],
  },
  {
    label: "资讯",
    items: [
      { to: "/news", label: "快讯", icon: Newspaper },
      { to: "/inbox", label: "消息与提醒", icon: Bell },
      { to: "/studio", label: "自媒体图文", icon: Image },
    ],
  },
  {
    label: "研究",
    // 2026-10-26 四合一：个股研判 / 多空辩论 / 研报库 / 笔记合成一个「研究」页，
    // 里面二级 tab 切换；旧地址 /debate /reports /notes 保留重定向。
    items: [{ to: "/research", label: "研究", icon: FileSearch }],
  },
  {
    label: "组合",
    // 2026-10-26 去掉「持仓与追踪」：持仓明细在首页与策略看板都有出口，
    // 平铺入口重复率太高；/strategies/positions 路由保留，直链仍可达。
    items: [{ to: "/my-stocks", label: "自选", icon: Star }],
  },
  {
    label: "进化",
    items: [
      { to: "/strategies/screener", label: "策略看板", icon: LayoutList },
      { to: "/factors", label: "因子实验室", icon: FlaskConical },
      { to: "/backtest", label: "回测", icon: LineChart },
    ],
  },
  {
    label: "AI",
    items: [
      { to: "/ai", label: "工作台", icon: Sparkles },
      { to: "/butler", label: "大管家", icon: Bot },
      { to: "/ai/config", label: "接口与模型", icon: Settings2 },
      // 2026-10-26 去掉「行为边界」侧栏入口：AI 能做什么全文在 AI-BOUNDARY.md，
      // 页面直链 /ai/rules 仍可达。
    ],
  },
  { label: "设置", items: [{ to: "/settings", label: "设置与状态", icon: Settings }] },
];

/** 所有分组项摊平，按路径查「当前在哪儿」。顶栏页面名和边栏激活态共用这一张表。 */
function navHit(path: string) {
  for (const group of SIDEBAR) {
    const item = group.items.find((entry) => entry.to === path);
    if (item) return { group: group.label, ...item };
  }
  // 子页面（/strategies/positions、/review/signals 这类）归到所属的一级入口，
  // 顶栏页面名和侧栏激活组才不会丢。「/」是所有路径的前缀，不能参与前缀匹配。
  for (const group of SIDEBAR) {
    const item = group.items.find((entry) => entry.to !== "/" && path.startsWith(entry.to + "/"));
    if (item) return { group: group.label, ...item };
  }
  return null;
}

function SideNav() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  // 折叠状态记在浏览器里，默认全开——第一次来的人应该看见全部入口。
  // localStorage 只能在 effect 里碰：服务端渲染阶段没有它（和 AlertBell 的已读水位同一个坑）。
  const [closed, setClosed] = useState<string[]>([]);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("chiheng-nav-closed") ?? "[]");
      if (Array.isArray(saved)) setClosed(saved.filter((item) => typeof item === "string"));
    } catch {
      /* 存坏了就当没存过，全开 */
    }
  }, []);
  function toggle(label: string) {
    setClosed((prev) => {
      const next = prev.includes(label) ? prev.filter((item) => item !== label) : [...prev, label];
      localStorage.setItem("chiheng-nav-closed", JSON.stringify(next));
      return next;
    });
  }
  return (
    <aside className="sticky top-0 hidden h-screen w-52 shrink-0 flex-col border-r border-line md:flex">
      <Link to="/" className="flex items-center gap-2 px-4 pt-4 pb-2">
        <span className="h-4 w-[3px] rounded-full bg-brand" aria-hidden />
        <span className="text-[15px] font-medium tracking-widest">赤轨</span>
        <span className="text-xs text-muted">策略实验台</span>
      </Link>
      <nav className="flex-1 overflow-y-auto scroll-slim px-2 pb-4" aria-label="主导航">
        {SIDEBAR.map((group) => {
          const open = !closed.includes(group.label);
          return (
            <div key={group.label}>
              <button
                type="button"
                onClick={() => toggle(group.label)}
                aria-expanded={open}
                className="flex w-full items-center justify-between rounded px-3 pt-4 pb-1 text-[10px] tracking-widest text-muted hover:text-fg"
              >
                {group.label}
                <ChevronDown className={"size-3 transition-transform " + (open ? "" : "-rotate-90")} aria-hidden />
              </button>
              {open &&
                group.items.map((item) => {
                  const active = path === item.to;
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      aria-current={active ? "page" : undefined}
                      className={
                        "flex items-center gap-2 rounded px-3 py-2 text-sm " +
                        (active ? "bg-brand-soft font-medium text-brand-text" : "text-muted hover:bg-surface-2 hover:text-fg")
                      }
                    >
                      <Icon className="size-3.5 shrink-0" aria-hidden />
                      {item.label}
                    </Link>
                  );
                })}
            </div>
          );
        })}
      </nav>
      <SystemStatus />
    </aside>
  );
}

/**
 * 侧栏底部的系统状态块（对齐参考图「系统状态」区）。
 * 只有「系统状态 / 记账心跳」两项有真实数据源（data/recorder.json，经 getRecorder）；
 * 参考图里的「数据延迟 / 计算节点」在代码里没有任何数据源——按纪律不编数字，
 * 标「暂无数据源」，等主人指明来源再接。心跳 5 分钟没更新算超时（进程可能挂了）。
 */
function SystemStatus() {
  const { data } = useQuery({
    queryKey: ["recorder-status"],
    queryFn: () => getRecorder(),
    refetchInterval: 60_000,
  });
  const at = data?.at ?? null;
  const ok = data?.ok ?? false;
  const beat = at != null ? snapshotAge(at) : "无心跳";
  const fresh = at != null && Date.now() - at < 5 * 60_000;
  const online = ok && fresh;
  const dotClass = online ? "bg-down" : ok ? "bg-warn" : "bg-up";
  const stateText = online ? "运行中" : ok ? "心跳超时" : "离线";
  return (
    <div className="mt-auto shrink-0 space-y-1.5 border-t border-line px-4 py-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-muted">
          <span className={"h-2 w-2 rounded-full " + dotClass} aria-hidden />
          系统状态
        </span>
        <span className={online ? "text-down" : "text-muted"}>{stateText}</span>
      </div>
      <div className="flex items-center justify-between text-muted">
        <span>记账心跳</span>
        <span className="tabular-nums">{beat}</span>
      </div>
      <div className="flex items-center justify-between text-muted">
        <span>数据延迟</span>
        <span className="text-muted/70">暂无数据源</span>
      </div>
      <div className="flex items-center justify-between text-muted">
        <span>计算节点</span>
        <span className="text-muted/70">暂无数据源</span>
      </div>
    </div>
  );
}

/** 顶栏左侧的当前页面名（学 Vibe-Research 的「工作空间 / 首页」面包屑）：
 *  分组名 / 页面名。数据直接复用边栏那张表，两处永远不会对不上。
 *  窄屏不显示——窄屏顶栏已经有赤轨 logo，塞不下两样。 */
function PageTitle() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const hit = navHit(path);
  if (!hit) return null;
  return (
    <div className="hidden shrink-0 items-baseline gap-1.5 text-sm md:flex" aria-hidden>
      <span className="text-muted">{hit.group}</span>
      <span className="text-muted">/</span>
      <span className="font-medium">{hit.label}</span>
    </div>
  );
}

/**
 * 顶栏全局搜索（⌘K）。两种模式：
 * - 默认：输名称或六位代码，下拉出最多 8 只股票，回车或点选跳到个股页。
 * - 命令模式：输入以 > 开头，匹配站内页面（路由跳转），回车去第一个匹配。
 * 数据走 getQuickSearch（服务端在缓存的全市场名单里过滤），不打断当前页。
 */
const COMMANDS: { label: string; keywords: string; to: string; search?: Record<string, unknown> }[] = [
  { label: "总览", keywords: "home dashboard 首页", to: "/" },
  { label: "涨跌分布", keywords: "market overview 大盘 广度", to: "/overview" },
  { label: "复盘与资金", keywords: "review flow 资金流向", to: "/review" },
  { label: "情绪信号", keywords: "signals 涨停", to: "/review/signals" },
  { label: "公司事件", keywords: "events 日历 业绩", to: "/review/events" },
  { label: "全球市场", keywords: "overseas hk us 港美", to: "/overseas", search: { tab: "indices", market: "hk", page: 1, sort: "chg" } },
  { label: "热点资讯", keywords: "news 快讯", to: "/news" },
  { label: "消息与提醒", keywords: "inbox 提醒", to: "/inbox" },
  { label: "自媒体", keywords: "studio 海报", to: "/studio" },
  { label: "研究", keywords: "research 个股研判", to: "/research/" },
  { label: "多空辩论", keywords: "debate 辩论", to: "/research/debate" },
  { label: "研报库", keywords: "reports", to: "/research/reports" },
  { label: "笔记", keywords: "notes", to: "/research/notes" },
  { label: "自选", keywords: "watchlist my-stocks", to: "/my-stocks" },
  { label: "策略看板", keywords: "screener 策略 选股 持仓", to: "/strategies/screener" },
  { label: "因子实验室", keywords: "factors 因子", to: "/factors" },
  { label: "回测", keywords: "backtest", to: "/backtest" },
  { label: "AI 工作台", keywords: "ai 智能", to: "/ai" },
  { label: "大管家", keywords: "butler", to: "/butler" },
  { label: "接口与模型", keywords: "ai config 配置 token", to: "/ai/config" },
  { label: "设置", keywords: "settings", to: "/settings" },
];

function QuickSearch() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const cmdMode = q.startsWith(">");
  const cmdQuery = q.slice(1).trim().toLowerCase();
  const { data } = useQuery({
    queryKey: ["quick-search", q],
    queryFn: () => getQuickSearch({ data: { q } }),
    enabled: q.trim().length > 0 && !cmdMode,
    staleTime: 30_000,
  });
  const matches = data?.matches ?? [];
  const commands = cmdMode
    ? COMMANDS.filter(
        (c) =>
          cmdQuery.length === 0 ||
          c.label.toLowerCase().includes(cmdQuery) ||
          c.keywords.toLowerCase().includes(cmdQuery),
      ).slice(0, 8)
    : [];

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

  function jumpCommand(cmd: (typeof COMMANDS)[number]) {
    setOpen(false);
    setQ("");
    void navigate({ to: cmd.to, search: (cmd.search ?? {}) as never });
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
          if (event.key === "Enter") {
            if (cmdMode && commands[0]) jumpCommand(commands[0]);
            else if (!cmdMode && matches[0]) jump(matches[0].code);
          }
          if (event.key === "Escape") {
            setQ("");
            setOpen(false);
            inputRef.current?.blur();
          }
        }}
        placeholder="搜索股票，或 > 跳转页面"
        aria-label="全局搜索"
        className="w-full rounded border border-line bg-surface py-1.5 pr-12 pl-8 text-sm text-fg placeholder:text-muted focus:border-accent"
      />
      <kbd className="kbd absolute top-1/2 right-2 -translate-y-1/2" aria-hidden>
        ⌘K
      </kbd>
      {open && q.trim() && (
        <div className="absolute z-30 mt-1 w-full min-w-56 overflow-hidden rounded border border-line bg-surface shadow-pop">
          {cmdMode ? (
            commands.length === 0 ? (
              <div className="px-3 py-2 text-xs text-muted">没有匹配的页面</div>
            ) : (
              commands.map((cmd) => (
                <button
                  key={cmd.to}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => jumpCommand(cmd)}
                  className="flex w-full items-baseline justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-surface-2"
                >
                  <span className="text-fg">{cmd.label}</span>
                  <span className="text-xs text-muted">{cmd.to}</span>
                </button>
              ))
            )
          ) : matches.length === 0 ? (
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
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0c0d10" : "#f5f6f8");
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

/**
 * 铃铛下拉里的微信推送配置（PushPlus）。
 * 只给主人账号显示——推送本身只在主人账本上触发，别人配置了也不会收到。
 * 填新 token 覆盖旧的；留空点保存 = 关闭微信推送（回到只发 Mac 通知）。
 */
function PushConfig() {
  const { data } = useQuery({ queryKey: ["push-status"], queryFn: () => getPushStatus() });
  const [token, setToken] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  if (!data?.allowed) return null;
  const save = async () => {
    try {
      const res = await savePushConfig({ data: { token } });
      setMessage(res.configured ? `已保存，尾号 ${res.tail ?? ""}`.trim() : "已关闭微信推送");
      setToken("");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "保存失败");
    }
  };
  return (
    <div className="border-t border-line px-3 py-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="shrink-0 text-xs font-medium text-muted">微信推送（PushPlus）</span>
        <span className="truncate text-xs text-muted">
          {data.configured ? `已配置 · 尾号 ${data.tail}` : "未配置"}
        </span>
      </div>
      <div className="mt-1.5 flex gap-1.5">
        <input
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={data.configured ? "填新 token 替换，留空保存可关闭" : "粘贴 PushPlus token"}
          className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-xs text-fg outline-none placeholder:text-muted focus:border-brand"
        />
        <button
          type="button"
          onClick={() => void save()}
          className="shrink-0 rounded bg-brand px-2.5 py-1 text-xs font-medium text-white transition hover:opacity-90"
        >
          保存
        </button>
      </div>
      {message ? <p className="mt-1 text-xs text-muted">{message}</p> : null}
    </div>
  );
}

/**
 * 顶栏铃铛 + 右下角 Toast（PPT 交互规范 05 预警推送的落地版）。
 *
 * 数据源是记账进程的去重账本 sell-alerts.json（同一笔只提醒一次）。
 * "已读水位"是浏览器里存的最后一条 key：铃铛红点数 = 水位之后的新条目；
 * 页面打开时如果没有水位，就把当前最新一条当水位——旧账不补报，不弹 Toast 风暴。
 */
function AlertBell() {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["sell-alerts"],
    queryFn: () => getSellAlerts(),
    refetchInterval: 60_000,
  });
  const alerts = data?.alerts ?? [];
  // 已读水位存在浏览器里。SSR 阶段没有 localStorage，初始给 null，挂载后再读。
  const [seenKey, setSeenKey] = useState<string | null>(null);
  const [toast, setToast] = useState<(typeof alerts)[number] | null>(null);
  const toastedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    setSeenKey(localStorage.getItem("chiheng-alerts-seen"));
  }, []);

  // 第一次拿到数据时定水位：没见过任何水位 → 当前最新一条即全部已读。
  useEffect(() => {
    if (alerts.length === 0 || seenKey != null) return;
    const newest = alerts[0];
    if (newest) {
      localStorage.setItem("chiheng-alerts-seen", newest.key);
      setSeenKey(newest.key);
    }
  }, [alerts, seenKey]);

  // 新预警 → Toast。只在会话内弹一次（按 key 去重），静默期间不打扰。
  useEffect(() => {
    const newest = alerts[0];
    if (!newest || seenKey == null) return;
    if (newest.key === seenKey || newest.key === toastedKeyRef.current) return;
    toastedKeyRef.current = newest.key;
    setToast(newest);
  }, [alerts, seenKey]);

  // 一条 Toast 8 秒后自己消失（可静默的落地版：不堆叠、不强制）。
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 8_000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const seenIndex = seenKey ? alerts.findIndex((alert) => alert.key === seenKey) : 0;
  const unread = seenIndex === -1 ? 0 : seenIndex;

  function markAllRead() {
    const newest = alerts[0];
    if (!newest) return;
    localStorage.setItem("chiheng-alerts-seen", newest.key);
    setSeenKey(newest.key);
  }

  return (
    <>
      <details className="group relative shrink-0">
        <summary
          aria-label={`卖出提醒，${unread} 条未读`}
          className="relative inline-flex h-8 cursor-pointer list-none items-center rounded border border-line bg-surface px-2.5 text-muted hover:bg-surface-2 hover:text-fg [&::-webkit-details-marker]:hidden"
        >
          <Bell className="size-3.5" />
          {unread > 0 ? (
            <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-up px-1 text-[10px] font-medium text-white tabular-nums">
              {unread}
            </span>
          ) : null}
        </summary>
        <div className="absolute right-0 z-40 mt-2 w-80 rounded border border-line bg-surface shadow-pop">
          <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
            <span className="text-sm font-medium">卖出提醒</span>
            <button type="button" onClick={markAllRead} className="text-xs text-accent hover:underline">
              全部已读
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto scroll-slim">
            {alerts.length === 0 ? (
              <div className="px-3 py-6 text-center text-sm text-muted">还没有触发过卖出提醒</div>
            ) : (
              alerts.map((alert, index) => (
                <div key={alert.key} className={"border-b border-line px-3 py-2 text-sm last:border-b-0 " + (index < unread ? "bg-up-soft/50" : "")}>
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="min-w-0 truncate">
                      {alert.name ?? alert.id}
                      <span className="ml-2 text-xs text-muted">{alert.reason}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted">{alert.date.slice(5)}</span>
                  </div>
                  {alert.exit != null ? (
                    <div className="mt-0.5 text-xs tabular-nums text-muted">卖出价 {alert.exit.toFixed(2)}</div>
                  ) : null}
                </div>
              )))}
          </div>
          <Link
            to="/strategies/positions"
            className="block border-t border-line px-3 py-2 text-center text-xs text-accent hover:bg-surface-2"
          >
            去策略追踪看持仓 →
          </Link>
          <PushConfig />
        </div>
      </details>
      {toast ? (
        <button
          type="button"
          onClick={() => {
            markAllRead();
            setToast(null);
            void navigate({ to: "/strategies/positions" });
          }}
          className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-0.5 rounded border border-warn/60 bg-surface px-3 py-2.5 text-left shadow-pop"
        >
          <span className="text-xs text-warn">卖出提醒</span>
          <span className="text-sm text-fg">
            {toast.name ?? toast.id} 触发{toast.reason}
            {toast.exit != null ? `，卖出价 ${toast.exit.toFixed(2)}` : ""}
          </span>
          <span className="text-xs text-muted">点击去策略追踪 · 8 秒后自动消失</span>
        </button>
      ) : null}
    </>
  );
}

/** 窄屏主导航：一个「当前页 ▾」按钮，点开是和桌面侧边栏**同一组数据**的分组菜单
 *  （2026-10-16 用户反馈：原来摊平成一排 19 个页签，又占地方又看不出层级）。
 *  换页自动收起；数据直接复用 SIDEBAR，两处永不打架。 */
export function MobileNav() {
  const path = useRouterState({ select: (state) => state.location.pathname });
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(false);
  }, [path]);
  const hit = navHit(path);
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label="页面菜单"
        className="nav-tab inline-flex items-center gap-1.5 rounded text-sm"
      >
        <Menu className="size-3.5" aria-hidden />
        <span className="font-medium">{hit?.label ?? "菜单"}</span>
        <ChevronDown className={"size-3 transition-transform " + (open ? "" : "-rotate-90")} aria-hidden />
      </button>
      {open && (
        <div className="absolute left-0 z-40 mt-1 max-h-[70vh] w-60 overflow-y-auto scroll-slim rounded border border-line bg-surface shadow-pop">
          {SIDEBAR.map((group) => (
            <div key={group.label} className="border-b border-line/60 last:border-0">
              <p className="px-3 pt-2.5 pb-0.5 text-[10px] tracking-widest text-muted">{group.label}</p>
              {group.items.map((item) => {
                const active = path === item.to;
                const Icon = item.icon;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    aria-current={active ? "page" : undefined}
                    className={
                      "flex items-center gap-2 px-3 py-2 text-sm " +
                      (active ? "bg-brand-soft font-medium text-brand-text" : "text-muted hover:bg-surface-2 hover:text-fg")
                    }
                  >
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
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
  /** 页头的状态药丸：必须来自本页 loader 的真实数据，没有就不传 */
  status,
  /** 页头专属装饰件的额外内容（真实数据，null 就不显示） */
  ornamentContent,
  children,
}: {
  aside?: ReactNode;
  extra?: ReactNode;
  onRefresh?: () => void | Promise<void>;
  /** 主控台这类一屏一任务的宽页面用 true，其余阅读型页面保持窄栏 */
  wide?: boolean;
  /** 状态药丸：页面 loader 算出来的真实状态（口径纪律：不许编） */
  status?: import("@/lib/ui/page-decor").PageStatus | null;
  /** 专属装饰件的额外内容（真实数据） */
  ornamentContent?: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();
  // 装饰层要拿到「当前路径 + 页面名 + 配置」，这里一次算完传给三个子件。
  const path = useRouterState({ select: (state) => state.location.pathname });
  // 页面名不再从 navHit 取（有几个页面没侧栏入口，会拿到空串）——
  // 标题由 page-decor 配置表负责，那是页头的权威来源。
  const decor = decorFor(path);
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

  // F5 / r 刷新本页（复用缓存）。**注册在 Frame 而不是各页面**：绝大多数页面
  // 没有自己的 onRefresh，但它们的 loader 也能 invalidate——之前只有选股页
  // 注册了，别的地方按 F5 没反应，而 `?` 面板上明明写着「刷新」。
  // 选股页会再注册一次（子组件 effect 先跑、父组件后跑，后注册的赢），
  // 把「复用缓存」和「⌥F5 强制重拉」两个语义都补全。
  // onToggleTheme 也注册在这里：cycleTheme 本来是选股页单独注册的，别的地方按 `t`
  // 没反应，而 `?` 面板上写着「深浅色」是全局键——同一类漂移（面板说有、按下没反应）。
  // 选股页会再注册一次覆盖掉，两个入口指向同一个 cycleTheme，不冲突。
  useHotkeys({ onRefresh: () => refresh(), onToggleTheme: cycleTheme });
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
            <PageTitle />
            <QuickSearch />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <AccountChip />
              <AlertBell />
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
          <div className="px-3 pb-2 md:hidden">
            <MobileNav />
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
            "relative mx-auto flex w-full flex-1 flex-col gap-3 px-3 py-3 md:px-4 " +
            (wide ? "max-w-[1440px]" : "max-w-3xl")
          }
        >
          {/* L1 底纹：功能组色相的极淡氛围。放在内容区最底层，不拦截点击。 */}
          {decor ? <DecorBackdrop hue={decor.hue} /> : null}

          {/* L2 页头：图标 + 页面名 + 一句话职能 + 状态药丸。
              没有配置装饰的页面（不在 page-decor 表里的）不渲染这一段——
              装饰是加分项，不该在某些页面上留个空壳。 */}
          {decor ? (
            <DecorHeader decor={decor} status={status} />
          ) : null}

          {/* L3 专属装饰件：只有配置表里写了 ornament 的页面才有。 */}
          {decor?.ornament ? (
            <DecorOrnament kind={decor.ornament}>{ornamentContent}</DecorOrnament>
          ) : null}

          <div className="relative z-[1] flex flex-col gap-3">{children}</div>
        </main>
      </div>
    </div>
  );
}
