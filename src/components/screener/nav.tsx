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
import {
  Bell,
  ChevronDown,
  Coins,
  FileSearch,
  FileText,
  FlaskConical,
  Gauge,
  Globe,
  History,
  LayoutDashboard,
  LineChart,
  ListFilter,
  Menu,
  Newspaper,
  NotebookPen,
  RefreshCw,
  Scale,
  Search,
  Settings,
  Sparkles,
  Star,
  Users,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { getPushStatus, getQuickSearch, getSellAlerts, savePushConfig } from "@/lib/market/quotes.functions";
import { isPaidPlan, planLabel } from "@/lib/auth/plan";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

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
 * 左侧分组导航。2026-10-16 按用户「页面太多」的反馈二次整合（此前 10-13 已学
 * Vibe-Research 的 nav.ts 做过一轮）：
 *
 * 信息架构约定（三级）：
 *   一级 = 侧边栏分组（5 组）· 二级 = 组内页面（共 18 项）· 三级 = 页内 tab
 *   （首例：日历与事件页 ?tab=plan|events，原 /events 独立页并入）。
 *
 * 这轮动了什么：
 *   - 原 4 组 21 项 → 5 组 19 项；「市场情报」组太杂，按用途拆成「市场 / 实验室 / 研究」
 *   - 「个股查询」从导航撤掉：顶栏 ⌘K 全局搜索就是干这个的，独立入口重复
 *   - 「事件」页并入「日历与事件」页（页内 tab），/events 旧路由重定向不断链
 *   - AI 入口仍 pinned 在侧栏底部（学 Vibe），不混进分组
 *
 * 2026-10-21 又两轮：复盘区整合（/review 下每日复盘+信号+公司事件）、策略区整合
 * （/strategies 下选股+追踪）、日历页撤销、板块并入资金流向（/flow 下两个子页），
 * 二级项 19 → 18；旧路由（/sectors 等）都留重定向文件，书签不断链。
 *
 * 保留 Vibe 的三条原则：
 *   1. 最多两级（分组 + 页面）；第三级只许在页面里切，不占侧栏
 *   2. 顺序按炒股的人每天的先后：先看主控台 → 看盘情报 → 实验 → 研究 → 我的
 *   3. 接入 AI 固定在侧栏底部（pinned）
 */
const SIDEBAR: {
  label: string;
  items: { to: "/" | "/overview" | "/butler" | "/desk" | "/strategies" | "/strategies/screener" | "/strategies/positions" | "/factors" | "/ai" | "/news" | "/flow" | "/research" | "/reports" | "/debate" | "/my-stocks" | "/review" | "/review/signals" | "/review/events" | "/inbox" | "/backtest" | "/notes" | "/settings" | "/admin" | "/overseas"; label: string; icon: LucideIcon }[];
}[] = [
  { label: "工作台", items: [{ to: "/", label: "主控台", icon: LayoutDashboard }, { to: "/butler", label: "大管家", icon: Sparkles }, { to: "/desk", label: "合成台", icon: Workflow }] },
  {
    label: "市场",
    items: [
      { to: "/overview", label: "股市总览", icon: Gauge },
      { to: "/review", label: "每日复盘", icon: History },
      { to: "/news", label: "快讯", icon: Newspaper },
      { to: "/flow", label: "资金流向", icon: Coins },
      { to: "/overseas", label: "港美行情", icon: Globe },
    ],
  },
  {
    label: "实验室",
    items: [
      { to: "/strategies/screener", label: "策略", icon: ListFilter },
      { to: "/factors", label: "因子发掘", icon: FlaskConical },
      { to: "/backtest", label: "回测", icon: LineChart },
    ],
  },
  {
    label: "研究",
    items: [
      { to: "/research", label: "个股研判", icon: FileSearch },
      { to: "/debate", label: "多空辩论", icon: Scale },
      { to: "/reports", label: "研报库", icon: FileText },
      { to: "/notes", label: "笔记", icon: NotebookPen },
    ],
  },
  {
    label: "我的",
    items: [
      { to: "/my-stocks", label: "自选与持仓", icon: Star },
      { to: "/inbox", label: "提醒", icon: Bell },
      { to: "/settings", label: "设置与状态", icon: Settings },
      { to: "/admin", label: "管理系统", icon: Users },
    ],
  },
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
      {/* 边栏底部常驻 AI 入口（学 Vibe-Research 的「接入 AI」）。
          这里的 brand-soft 垫底和激活项同语汇：全站正文其余区域仍是中性灰。 */}
      <div className="border-t border-line p-2">
        <Link
          to="/ai"
          className="flex items-center gap-2 rounded bg-brand-soft px-3 py-2 text-sm font-medium text-brand-text transition hover:opacity-80"
        >
          <Sparkles className="size-3.5 shrink-0" aria-hidden />
          接入 AI
          <span className="ml-auto text-[10px] font-normal text-muted">提议 · 闸门判决</span>
        </Link>
      </div>
    </aside>
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
          <Link
            to="/ai"
            className="flex items-center gap-2 bg-brand-soft px-3 py-2.5 text-sm font-medium text-brand-text"
          >
            <Sparkles className="size-3.5 shrink-0" aria-hidden />
            接入 AI
          </Link>
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
