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
  Compass,
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
  Sparkles,
  Star,
  type LucideIcon,
} from "lucide-react";
import { getAILog, getFactorQueue, getPushStatus, getQuickSearch, getRecorder, getSellAlerts, getStrategyGates, getUniverse, savePushConfig } from "@/lib/market/quotes.functions";
import { getAlerts } from "@/lib/market/alerts.functions";
import { FreshnessBar } from "@/components/status-widgets";
import type { StatusSnapshot } from "@/lib/ui/app-status";
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
 *     （2026-11-06 收敛：接口与模型、行为边界都是 /ai 页内 tab，侧栏不再单列；
 *      现为 工作台 / 大管家 两项。下面「保留的三条老原则」第 1 条即此依据。）
 *   - admin / membership 按方案藏出侧栏（直链可达，会员功能落地后再亮出）
 *   - 板块、日历、模拟持仓维持重定向现状：它们的真实页面在资金流向/复盘/策略追踪下，
 *     侧栏不再单列，避免和二级子页撞车
 *
 * 保留的三条老原则：
 *   1. 最多两级（分组 + 页面）；第三级只许在页面里切，不占侧栏
 *   2. 顺序按每天使用先后：先看总览 → 市场 → 资讯 → 研究（含自选）→ 进化 → AI
 *   3. 旧路由全部留重定向文件，书签不断链
 */
const SIDEBAR: {
  label: string;
  items: { to: "/" | "/guide" | "/overview" | "/review" | "/overseas" | "/news" | "/inbox" | "/studio" | "/research" | "/my-stocks" | "/strategies/screener" | "/factors" | "/backtest" | "/ai" | "/butler" | "/ai/config" | "/settings"; label: string; icon: LucideIcon }[];
}[] = [
  { label: "总览", items: [{ to: "/", label: "总览", icon: LayoutDashboard }, { to: "/guide", label: "系统导览", icon: Compass }] },
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
    // 2026-10-27 组合 + 研究 合成一个侧栏分组：两个分组各只有一项（研究页 / 自选），
    // 平铺成两个分组纯属占行；自选（持仓观察）作为研究工作流的一环归到研究下。
    // 旧地址 /debate /reports /notes 保留重定向，/strategies/positions 路由保留直链可达。
    items: [
      { to: "/research", label: "研究", icon: FileSearch },
      { to: "/my-stocks", label: "自选", icon: Star },
    ],
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
      // 2026-11-06 收掉「接口与模型」(/ai/config) 侧栏入口：它本来就是 /ai 页内
      // AISectionTabs 的第 2 个 tab，侧栏再列一次是同一目的地的两级重复导航，
      // 也违反本文件头注释「最多两级，第三级只许在页面里切，不占侧栏」。
      // 沿用 10-26 处理「行为边界」的同一做法：入口收进 tab，直链不删。
      // /ai/config 路由、页面、smoke PAGES、QuickSearch 直达词条全部保留；
      // navHit 的前缀匹配会把 /ai/config 归到 /ai，顶栏名和激活态都不丢。
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
  // 侧栏收窄（2026-11-06 参考实现 §2）：208px → 68px，只留图标 + title 悬浮提示。
  // 默认展开；收窄记在浏览器里。
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    try {
      setNarrow(localStorage.getItem("ch-side-narrow") === "1");
    } catch {
      /* 默认展开 */
    }
  }, []);
  function toggleNarrow() {
    setNarrow((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("ch-side-narrow", next ? "1" : "0");
      } catch {
        /* 隐私模式：本次会话内生效 */
      }
      return next;
    });
  }
  // 侧栏「消息与提醒」的未读红点：和 /inbox 页用**同一个**已读水位
  // （chiheng-alert-read-at），两处计数永远一致。
  const inboxQuery = useQuery({
    queryKey: ["sidebar-inbox-unread"],
    queryFn: () => getAlerts(),
    refetchInterval: 120_000,
  });
  const [inboxMark, setInboxMark] = useState<string | null>(null);
  useEffect(() => {
    try {
      setInboxMark(localStorage.getItem("chiheng-alert-read-at") ?? "");
    } catch {
      setInboxMark("");
    }
  }, []);
  const inboxRows = inboxQuery.data ?? [];
  const inboxUnread =
    inboxMark == null ? 0 : inboxRows.filter((r) => r.at > inboxMark && r.id !== inboxMark).length;
  return (
    <aside
      className={
        "sticky top-0 hidden h-screen shrink-0 flex-col border-r border-sidebar-line bg-sidebar transition-[width] duration-200 md:flex " +
        (narrow ? "w-[68px]" : "w-52")
      }
    >
      <Link to="/" className={"flex items-center px-4 pt-4 pb-3 " + (narrow ? "justify-center px-0" : "gap-2.5")} title={narrow ? "赤轨 · 策略实验台" : undefined}>
        {/* 效果图签名：渐变红圆角方块 mark。全站唯一的大面积品牌用色之一。 */}
        <span
          className="h-[26px] w-[26px] shrink-0 rounded-[8px]"
          aria-hidden
          style={{
            background: "radial-gradient(circle at 32% 30%, #ff6a5e, var(--color-brand) 60%, #a82f33)",
            boxShadow: "inset 0 0 0 1px rgba(229,72,77,.4)",
          }}
        />
        {narrow ? null : (
          <span className="leading-tight">
            <span className="block text-[15px] font-bold tracking-wide text-fg">赤轨</span>
            <span className="block text-[10px] text-muted">策略实验台</span>
          </span>
        )}
      </Link>
      <nav className="flex-1 overflow-y-auto scroll-slim px-2 pb-4" aria-label="主导航">
        {SIDEBAR.map((group) => {
          const open = !closed.includes(group.label);
          return (
            <div key={group.label}>
              {narrow ? (
                <div className="mx-3 mt-3 border-t border-sidebar-line/70 pt-1" aria-hidden />
              ) : (
                <button
                  type="button"
                  onClick={() => toggle(group.label)}
                  aria-expanded={open}
                  className="flex w-full items-center justify-between rounded px-3 pt-4 pb-1 text-[10px] tracking-widest text-muted hover:text-fg"
                >
                  {group.label}
                  <ChevronDown className={"size-3 transition-transform " + (open ? "" : "-rotate-90")} aria-hidden />
                </button>
              )}
              {open &&
                group.items.map((item) => {
                  const active = path === item.to;
                  const Icon = item.icon;
                  const isInbox = item.to === "/inbox";
                  return (
                    <Link
                      key={item.to}
                      to={item.to}
                      aria-current={active ? "page" : undefined}
                      title={narrow ? item.label : undefined}
                      className={
                        "relative flex items-center rounded text-sm " +
                        (narrow ? "justify-center px-0 py-2.5" : "gap-2 px-3 py-2") +
                        // 效果图导航激活态：品牌浅底 + 主文字 + 悬挂在侧栏左缘的 3px 红条
                        (active
                          ? " bg-brand-soft font-medium text-fg before:absolute before:-left-2 before:top-1.5 before:bottom-1.5 before:w-[3px] before:rounded-r-full before:bg-brand"
                          : " text-muted hover:bg-surface-2 hover:text-fg")
                      }
                    >
                      <Icon className={"size-3.5 shrink-0 " + (active ? "text-brand-text" : "")} aria-hidden />
                      {narrow ? null : item.label}
                      {isInbox && inboxUnread > 0 ? (
                        <span
                          className={
                            "flex h-4 min-w-4 items-center justify-center rounded-full bg-up px-1 text-[10px] font-medium text-white tabular-nums " +
                            (narrow ? "absolute right-1 top-1 h-2 min-w-2 px-0 text-[0px]" : "ml-auto")
                          }
                          aria-label={`${inboxUnread} 条未读`}
                        >
                          {narrow ? null : inboxUnread}
                        </span>
                      ) : null}
                    </Link>
                  );
                })}
            </div>
          );
        })}
      </nav>
      {narrow ? null : <SystemStatus />}
      <button
        type="button"
        onClick={toggleNarrow}
        aria-label={narrow ? "展开侧栏" : "收起侧栏"}
        title={narrow ? "展开侧栏" : "收起侧栏"}
        className={
          "border-t border-sidebar-line py-2 text-[11px] text-muted transition hover:text-fg " +
          (narrow ? "text-center" : "px-4 text-left")
        }
      >
        {narrow ? "›" : "‹ 收起侧栏"}
      </button>
    </aside>
  );
}

/**
 * 侧栏底部的系统状态块（对齐参考图「系统状态」区）。
 * 全部接真实数据源，不编假数：
 * - 系统状态 / 上次记账：data/recorder.json（经 getRecorder），5 分钟没更新算超时。
 * - 数据延迟：行情快照时间戳 universe.asOf（getUniverse 返回），延迟 = now - asOf。
 * - 因子待验：因子队列里还没过关、仍在管道中的条目数（pending + tested，来自 getFactorQueue）。
 * - AI 今日轮数：ai-log 里 at 落在今天（本地日期）的闭环次数（来自 getAILog）。
 * 之前占位的「计算节点 12/16」是效果图的假数，代码里无此数据源，已撤掉。
 */
/**
 * 系统状态数据源（侧栏底部块与全局底部状态条共用同一份查询，两处数字永不打架）。
 * 全部接真实数据源，不编假数：
 * - 系统状态 / 上次记账：data/recorder.json（经 getRecorder），5 分钟没更新算超时。
 * - 数据延迟：行情快照时间戳 universe.asOf（getUniverse 返回），延迟 = now - asOf。
 * - 因子待验：因子队列里还没过关、仍在管道中的条目数（pending + tested，来自 getFactorQueue）。
 * - AI 今日轮数：ai-log 里 at 落在今天（本地日期）的闭环次数（来自 getAILog）。
 * - 风控闸门：strategy-gates.json 里停用/假释的策略套数（getStrategyGates）。
 * 之前占位的「计算节点 12/16」是效果图的假数，代码里无此数据源，已撤掉。
 */
function useSysStatus() {
  const { data } = useQuery({
    queryKey: ["sys-status"],
    queryFn: async () => {
      const [rec, uni, queue, log, gates] = await Promise.all([
        getRecorder(),
        getUniverse({ data: { refresh: false } }).catch(() => null),
        getFactorQueue().catch(() => null),
        getAILog().catch(() => null),
        getStrategyGates().catch(() => null),
      ]);
      // 当前时刻随查询结果一起序列化：SSR 与 hydration 拿到同一个值，
      // 底部状态条那些秒级文本（「行情延迟 Ns」「上次记账 N 秒前」）才不会对不上
      // 触发 #418；每 60s refetch 时这个时刻自然刷新。
      return { rec, uni, queue, log, gates, serverNow: Date.now() };
    },
    refetchInterval: 60_000,
  });
  const serverNow = data?.serverNow ?? 0;
  const rec = data?.rec ?? null;
  const uni = data?.uni ?? null;
  const at = rec?.at ?? null;
  const ok = rec?.ok ?? false;
  // snapshotAge 要的是「多久之前」（时长），不是时间戳——传 at 本身会算出
  // 「1970 年距今 49 万小时」这种鬼数（2026-11-06 实测踩到）。
  const beat = at != null ? snapshotAge(serverNow - at) : "还没跑";
  const fresh = at != null && serverNow - at < 5 * 60_000;
  const online = ok && fresh;
  const dotClass = online ? "bg-down" : ok ? "bg-warn" : "bg-up";
  const stateText = online ? "运行中" : ok ? "心跳超时" : "离线";
  const asOf = uni?.asOf ?? null;
  const delaySec = asOf != null ? Math.max(0, Math.round((serverNow - asOf) / 1000)) : null;
  const entries = data?.queue?.entries ?? [];
  const pending = entries.filter((e) => e.status === "pending" || e.status === "tested").length;
  const allEntries = data?.log?.allowed ? data.log.entries : [];
  // 查询还没回来时没有可用时刻，就别编一个 1970 的日期去数——today 为 null，
  // 今日轮数按「拿不到」处理（此时 allEntries 本来也是空的）。
  const today = data ? new Date(serverNow).toISOString().slice(0, 10) : null;
  const todayRounds = today == null ? 0 : allEntries.filter((e) => (e.at ?? "").slice(0, 10) === today).length;
  const gateValues = Object.values(data?.gates?.gates ?? {});
  const gatesOff = gateValues.filter((g) => g.state === "disabled").length;
  const gatesParole = gateValues.filter((g) => g.state === "paroled").length;
  return { online, ok, beat, stateText, dotClass, delaySec, pending, entries, todayRounds, allEntries, gatesOff, gatesParole };
}

/** 状态点的辉光（效果图签名）：运行中绿光、异常红光、降级琥珀光。 */
function dotGlow(dotClass: string): string {
  if (dotClass.includes("bg-down")) return "shadow-[0_0_6px_rgba(67,165,131,.7)]";
  if (dotClass.includes("bg-up")) return "shadow-[0_0_6px_rgba(232,77,77,.7)]";
  if (dotClass.includes("bg-warn")) return "shadow-[0_0_6px_rgba(217,164,65,.7)]";
  return "";
}

function SystemStatus() {
  const s = useSysStatus();
  return (
    <div className="mt-auto shrink-0 space-y-1.5 border-t border-sidebar-line px-4 py-3 text-xs">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-muted">
          <span className={"h-2 w-2 rounded-full " + s.dotClass + " " + dotGlow(s.dotClass)} aria-hidden />
          系统状态
        </span>
        <span className={s.online ? "text-down" : "text-muted"}>{s.stateText}</span>
      </div>
      <div className="flex items-center justify-between text-muted">
        <span>上次记账</span>
        <span className="tabular-nums">{s.beat}</span>
      </div>
      <div className="flex items-center justify-between text-muted">
        <span>数据延迟</span>
        <span className="tabular-nums">{s.delaySec != null ? `${s.delaySec}s` : "—"}</span>
      </div>
      <div className="flex items-center justify-between text-muted">
        <span>因子待验</span>
        <span className="tabular-nums">{s.entries.length ? `${s.pending} 只` : "—"}</span>
      </div>
      <div className="flex items-center justify-between text-muted">
        <span>AI 今日</span>
        <span className="tabular-nums">{s.allEntries.length ? `${s.todayRounds} 轮` : "—"}</span>
      </div>
    </div>
  );
}

/**
 * 全局底部状态条（重设计效果图签名件，桌面端常驻）：
 * 系统状态 · 数据接口 · 行情延迟 · 策略引擎 · 风控闸门 + 查看详细日志入口。
 * 数据和侧栏底部块同源（useSysStatus），不编数——闸门那格「N 套停用」来自
 * strategy-gates.json，没有文件就是已就绪。
 */
function StatusBar() {
  const s = useSysStatus();
  const linkCls = "inline-flex items-center gap-1 text-muted transition-colors hover:text-fg";
  return (
    <footer
      className="sticky bottom-0 z-20 hidden border-t border-sidebar-line bg-sidebar/95 backdrop-blur-md md:block"
      role="contentinfo"
      aria-label="系统状态条"
    >
      <div className="flex h-8 items-center gap-5 px-4 text-[11px] text-muted">
        <span className="flex items-center gap-1.5">
          <span className={"h-1.5 w-1.5 rounded-full " + s.dotClass + " " + dotGlow(s.dotClass)} aria-hidden />
          系统状态
        </span>
        <span>
          数据接口: <span className={s.delaySec != null && s.delaySec < 120 ? "text-down" : "text-warn"}>{s.delaySec != null && s.delaySec < 120 ? "正常" : "延迟"}</span>
        </span>
        <span className="tabular-nums">行情延迟: {s.delaySec != null ? `${s.delaySec}s` : "—"}</span>
        <span>
          策略引擎: <span className={s.online ? "text-down" : "text-warn"}>{s.online ? "正常" : s.ok ? "心跳超时" : "离线"}</span>
        </span>
        <span>
          风控闸门: <span className={s.gatesOff === 0 ? "text-down" : "text-warn"}>{s.gatesOff === 0 ? "已就绪" : `${s.gatesOff} 套停用${s.gatesParole > 0 ? ` · ${s.gatesParole} 套假释` : ""}`}</span>
        </span>
        <Link to="/settings" className={`${linkCls} ml-auto`}>
          查看详细日志
          <span aria-hidden>→</span>
        </Link>
      </div>
    </footer>
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
  { label: "系统导览", keywords: "guide 导览 帮助 术语 怎么用", to: "/guide" },
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
  { label: "策略管理", keywords: "arena 竞技场 策略管理", to: "/strategies/manage" },
  { label: "每日信号", keywords: "signals 竞技场 信号", to: "/strategies/signals" },
  { label: "失败归因", keywords: "autopsy 归因 亏损", to: "/strategies/autopsy" },
  { label: "因子实验室", keywords: "factors 因子", to: "/factors" },
  { label: "回测", keywords: "backtest", to: "/backtest" },
  { label: "AI 工作台", keywords: "ai 智能", to: "/ai" },
  { label: "大管家", keywords: "butler", to: "/butler" },
  { label: "接口配置", keywords: "接口与模型 ai config 配置 token 工作台 tab", to: "/ai/config" },
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
  // ready：等读完 localStorage 再让 applyTheme 跑。否则首帧会用初始的 "system"
  // 调 applyTheme，把 __root.tsx 内联脚本已经设好的深色 data-theme 删掉——
  // 切换页面时先白一下再切回深色，闪眼睛（2026-10-27 修）。
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem("chiheng-theme");
    if (saved === "light" || saved === "dark" || saved === "system") setMode(saved);
    setReady(true);
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
    // 没读好之前不动主题：保留内联脚本设好的 data-theme，避免闪白。
    if (!ready) return;
    applyTheme(mode);
    localStorage.setItem("chiheng-theme", mode);
    if (mode !== "system") return;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [mode, ready]);
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
/**
 * 顶栏铃铛 + 右侧统一通知抽屉（2026-11-06 按参考实现 §5「提醒中心」升级：
 * 原来的 details 下拉只装得下卖出提醒，现在四个 tab——全部 / 未读 / 卖出提醒 /
 * 系统提醒，两个真实数据源（卖出提醒 getAlerts 卖出册 + 系统提醒 /inbox 的
 * alerts），**各用各的已读水位，和铃铛红点、侧栏红点、inbox 页四处计数一致**。
 * Toast（新提醒 8 秒自动消失）原样保留。
 * 空态规则：没有未读时「全部标为已读」禁用并给下一步动作（参考实现 §5 的要求）。
 * PushConfig（微信推送配置）挪进抽屉底部的「通知设置」——低频配置不占顶栏。
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
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"all" | "unread" | "sell" | "inbox">("all");

  // 系统提醒（/inbox 的 alerts）：打开抽屉才拉，60s 轮询。
  const inboxQuery = useQuery({
    queryKey: ["bell-inbox-alerts"],
    queryFn: () => getAlerts(),
    enabled: open,
    refetchInterval: 60_000,
  });
  const inboxRows = inboxQuery.data ?? [];
  // 系统提醒的已读水位：和 /inbox 页同一个 key（chiheng-alert-read-at）。
  const [inboxMark, setInboxMark] = useState<string | null>(null);
  useEffect(() => {
    try {
      setInboxMark(localStorage.getItem("chiheng-alert-read-at") ?? "");
    } catch {
      setInboxMark("");
    }
  }, []);

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
  const sellUnread = seenIndex === -1 ? 0 : seenIndex;
  const inboxUnread = inboxMark == null ? 0 : inboxRows.filter((r) => r.at > inboxMark && r.id !== inboxMark).length;
  const totalUnread = sellUnread + inboxUnread;

  function markAllRead() {
    const newest = alerts[0];
    if (newest) {
      localStorage.setItem("chiheng-alerts-seen", newest.key);
      setSeenKey(newest.key);
    }
    const newestInbox = inboxRows[0];
    if (newestInbox) {
      try {
        localStorage.setItem("chiheng-alert-read-at", newestInbox.id);
      } catch {
        /* 隐私模式：不影响查看 */
      }
      setInboxMark(newestInbox.id);
    }
  }

  const TABS: { id: typeof tab; label: string }[] = [
    { id: "all", label: "全部" },
    { id: "unread", label: totalUnread > 0 ? `未读 ${totalUnread}` : "未读" },
    { id: "sell", label: "卖出提醒" },
    { id: "inbox", label: "系统提醒" },
  ];

  /** 卖出提醒一条。unread = 水位之后的。 */
  const sellRow = (alert: (typeof alerts)[number], index: number) => (
    <div key={alert.key} className={"border-b border-line px-3 py-2 text-sm last:border-b-0 " + (index < sellUnread ? "bg-up-soft/50" : "")}>
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 truncate">
          {alert.name ?? alert.id}
          <span className="ml-2 text-xs text-muted">{alert.reason}</span>
        </span>
        <span className="shrink-0 text-xs text-muted">{alert.date.slice(5)}</span>
      </div>
      {alert.exit != null ? <div className="mt-0.5 text-xs tabular-nums text-muted">卖出价 {alert.exit.toFixed(2)}</div> : null}
    </div>
  );

  /** 系统提醒一条（/inbox 同源同貌）。 */
  const inboxRow = (r: (typeof inboxRows)[number], i: number) => {
    const isUnread = inboxMark != null && r.at > inboxMark && r.id !== inboxMark;
    return (
      <div key={r.id} className={"border-b border-line px-3 py-2 text-sm last:border-b-0 " + (isUnread ? "bg-brand-soft/30" : "")}>
        <div className="flex items-baseline justify-between gap-2">
          <span className={"min-w-0 truncate " + (isUnread ? "font-medium text-fg" : "text-muted")}>
            {r.kind === "failed" ? <span className="mr-1.5 rounded bg-warn-soft px-1 text-[10px] text-warn">没跑成</span> : null}
            {r.title}
          </span>
          <span className="shrink-0 text-xs text-muted tabular-nums">{r.at.slice(5, 16).replace("T", " ")}</span>
        </div>
        <p className="mt-0.5 text-xs leading-snug text-muted">{r.detail}</p>
      </div>
    );
  };

  return (
    <>
      <button
        type="button"
        aria-label={`消息与提醒，${totalUnread} 条未读`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex h-8 shrink-0 items-center rounded border border-line bg-surface px-2.5 text-muted hover:bg-surface-2 hover:text-fg"
      >
        <Bell className="size-3.5" />
        {totalUnread > 0 ? (
          <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-up px-1 text-[10px] font-medium text-white tabular-nums">
            {totalUnread}
          </span>
        ) : null}
      </button>
      {open ? <div className="fixed inset-0 z-40 bg-fg/30" aria-hidden onClick={() => setOpen(false)} /> : null}
      {open ? (
        <aside
          className="fixed top-0 right-0 z-50 flex h-screen w-[380px] max-w-[calc(100vw-1.5rem)] flex-col border-l border-line bg-surface shadow-pop"
          aria-label="消息与提醒"
        >
          <div className="flex items-center justify-between border-b border-line px-4 py-3">
            <span className="flex items-baseline gap-2">
              <span className="text-sm font-medium">消息与提醒</span>
              {totalUnread > 0 ? <span className="text-xs text-up">未读 {totalUnread}</span> : null}
            </span>
            <button type="button" onClick={() => setOpen(false)} aria-label="关闭通知抽屉" className="text-muted hover:text-fg">
              ×
            </button>
          </div>
          <div className="flex gap-1 border-b border-line px-3 py-2">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={
                  "rounded px-2.5 py-1 text-xs transition " +
                  (tab === t.id ? "bg-brand-soft font-medium text-brand-text" : "text-muted hover:bg-surface-2 hover:text-fg")
                }
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto scroll-slim">
            {tab === "all" || tab === "sell" ? (
              <section>
                {(tab === "all" || tab === "sell") && (
                  <p className="sticky top-0 border-b border-line/60 bg-surface px-3 py-1.5 text-[10px] tracking-widest text-muted">卖出提醒</p>
                )}
                {alerts.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-muted">
                    还没有触发过卖出提醒
                    <Link to="/strategies/positions" onClick={() => setOpen(false)} className="mt-2 block text-xs text-accent hover:underline">
                      去策略追踪看持仓 →
                    </Link>
                  </div>
                ) : (
                  alerts.map(sellRow)
                )}
              </section>
            ) : null}
            {tab === "all" || tab === "inbox" ? (
              <section>
                <p className="sticky top-0 border-b border-line/60 bg-surface px-3 py-1.5 text-[10px] tracking-widest text-muted">系统提醒</p>
                {inboxRows.length === 0 ? (
                  <div className="px-3 py-6 text-center text-sm text-muted">
                    收件箱还是空的
                    <Link to="/my-stocks" onClick={() => setOpen(false)} className="mt-2 block text-xs text-accent hover:underline">
                      把股票加进自选，收盘后自动核对预警 →
                    </Link>
                  </div>
                ) : (
                  inboxRows.map(inboxRow)
                )}
              </section>
            ) : null}
            {tab === "unread" ? (
              totalUnread === 0 ? (
                <div className="px-3 py-6 text-center text-sm text-muted">
                  没有未读提醒
                  <p className="mt-1 text-xs">卖出提醒和系统提醒都会在这里聚齐；下次触发会自动亮红点。</p>
                </div>
              ) : (
                <>
                  {sellUnread > 0 ? (
                    <section>
                      <p className="sticky top-0 border-b border-line/60 bg-surface px-3 py-1.5 text-[10px] tracking-widest text-muted">卖出提醒 · {sellUnread}</p>
                      {alerts.slice(0, sellUnread).map(sellRow)}
                    </section>
                  ) : null}
                  {inboxUnread > 0 ? (
                    <section>
                      <p className="sticky top-0 border-b border-line/60 bg-surface px-3 py-1.5 text-[10px] tracking-widest text-muted">系统提醒 · {inboxUnread}</p>
                      {inboxRows
                        .filter((r) => inboxMark != null && r.at > inboxMark && r.id !== inboxMark)
                        .map(inboxRow)}
                    </section>
                  ) : null}
                </>
              )
            ) : null}
          </div>
          <div className="border-t border-line px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <button
                type="button"
                onClick={markAllRead}
                disabled={totalUnread === 0}
                className="rounded border border-line px-2.5 py-1 text-xs text-muted transition hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                title={totalUnread === 0 ? "没有未读，无需标记" : undefined}
              >
                全部标为已读
              </button>
              <Link to="/inbox" onClick={() => setOpen(false)} className="text-xs text-accent hover:underline">
                打开收件箱 →
              </Link>
            </div>
            <div className="mt-2 border-t border-line/60 pt-2">
              <p className="mb-1 text-[10px] tracking-widest text-muted">通知设置</p>
              <PushConfig />
            </div>
          </div>
        </aside>
      ) : null}
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
  /** 模块级数据新鲜度条（状态·数据源·更新时间·延迟·重试）——
   *  口径纪律：必须来自本页 loader/universe 的真实时间戳，不许编。 */
  freshness,
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
  freshness?: StatusSnapshot | null;
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

          {/* L3.5 模块级新鲜度条：状态 · 数据源 · 更新时间 · 延迟 · 重试。
              只有页面传了真实 snapshot 才渲染——没有数据源的页面不挂空壳。 */}
          {freshness ? <FreshnessBar snapshot={freshness} onRetry={refresh} className="relative z-[1]" /> : null}

          <div className="relative z-[1] flex flex-col gap-3">{children}</div>
        </main>
        <StatusBar />
      </div>
    </div>
  );
}
