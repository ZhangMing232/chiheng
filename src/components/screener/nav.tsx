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
  Activity,
  Bell,
  CalendarRange,
  CheckCircle2,
  Compass,
  Bot,
  ChevronDown,
  Coins,
  FileSearch,
  FileText,
  FlaskConical,
  Gauge,
  Globe,
  Grid3x3,
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
  Users,
  type LucideIcon,
} from "lucide-react";
import { getAILog, getFactorQueue, getPushStatus, getQuickSearch, getRecorder, getSellAlerts, getStrategyGates, getUniverse, savePushConfig } from "@/lib/market/quotes.functions";
import { getMailStatus } from "@/lib/market/mail.functions";
import { MailConfigCard } from "@/components/mail-config-card";
import { useMountedNow } from "@/lib/ui/relative-time";
import { getAlerts } from "@/lib/market/alerts.functions";
import { FreshnessBar } from "@/components/status-widgets";
import type { StatusSnapshot } from "@/lib/ui/app-status";
import { isPaidPlan, planLabel } from "@/lib/auth/plan";
import { useCurrentUserState } from "@/lib/auth/use-current-user";
import { snapshotAge } from "@/lib/market/format";
import { usePageVisible } from "@/lib/ui/use-visible-interval";

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
        <span className="rounded bg-brand-soft px-1.5 py-0.5 text-[12px] font-medium text-brand-text">
          {planLabel(user.plan)}
        </span>
      )}
    </Link>
  );
}


/**
 * 左侧分组导航。最近一次大改是 2026-11-11：从「按功能类型分组」改成
 * **按一天的节奏分组**（对标连板网 / 弈盘的导航组织方式）：
 *
 *   盘前 / 盯盘 / 盘后 / 研究 / 资讯 / 进化 / AI，外加设置。
 *
 * 为什么改：上一版（10-26 的七组）是「总览 / 市场 / 资讯 / 研究 / 组合 / 进化 / AI」，
 * 按「这是行情还是资讯」分类。用了半个月发现两个问题：市场组 7 项挤成一坨、
 * 研究组只剩「自选」一项名不符实。按时间走之后，早上打开看盘前、盘中看盯盘、
 * 收盘看盘后，每一组都是那个时段真会点的东西。
 *
 * 同日还做了三件结构合并（都留了重定向，书签不断链）：
 *   - 资金流向从复盘里拆回平级 /flow（它自己有 8 个子页，挂在复盘下就是三层导航）
 *   - 市场情报 + 题材轮动 + 题材简报 → /themes 三个 tab
 *   - 游资追踪 + 席位档案 → /youzi 两个 tab
 *
 * 以下是 10-26 那一版留下的说明，仍然成立：
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
 *      ——11-11 的三次合并都是照这条走的：子页进 tab，不占侧栏
 *   2. 顺序按每天使用先后：盘前 → 盯盘 → 盘后 → 研究 → 资讯 → 进化 → AI
 *   3. 旧路由全部留重定向文件，书签不断链
 */
const SIDEBAR: {
  label: string;
  items: { to: "/" | "/today" | "/decision" | "/huiyan" | "/watch" | "/watch/history" | "/review" | "/flow" | "/youzi" | "/themes" | "/cycle" | "/interval" | "/rs" | "/my-stocks" | "/news" | "/overseas" | "/strategies/screener" | "/strategies/positions" | "/factors" | "/backtest" | "/ai" | "/butler" | "/settings"; label: string; icon: LucideIcon }[];
}[] = [
  // 2026-11-13 按设计稿重排：五组，和 design/redesign-2026-11 的侧栏一致。
  //   今天 → 干什么（决策）
  //   行情 → 看什么（盘面事实）
  //   研究 → 信什么（证据与验证）
  //   策略 → 管什么（规则与持仓）
  //   我的 → 自己的对象（自选、快讯、提醒）
  // 再加一组「系统」放设置、管家、AI——它们不是业务任务，不该占业务位。
  // 原来的「盘前/盯盘/盘后/研究/资讯/进化/AI/设置」八组按时间分，
  // 结果是同一件事被拆到两组：资金在「盘后」、题材也在「盘后」，
  // 而「盯盘」组只有一项。分组跟着问题走，比跟着时钟走稳。
  {
    label: "今天",
    items: [
      { to: "/today", label: "今天该干什么", icon: Compass },
      { to: "/huiyan", label: "前瞻回验", icon: CheckCircle2 },
    ],
  },
  {
    label: "行情",
    items: [
      { to: "/watch", label: "盯盘", icon: Grid3x3 },
      { to: "/themes", label: "题材与情绪", icon: FileText },
      { to: "/youzi", label: "游资席位", icon: Users },
      { to: "/flow", label: "资金流向", icon: Coins },
      { to: "/overseas", label: "全球行情", icon: Globe },
    ],
  },
  {
    label: "研究",
    items: [
      { to: "/cycle", label: "情绪周期", icon: Activity },
      { to: "/interval", label: "区间统计", icon: CalendarRange },
      { to: "/rs", label: "趋势中军", icon: Gauge },
      { to: "/factors", label: "因子实验室", icon: FlaskConical },
    ],
  },
  {
    label: "策略",
    items: [
      { to: "/strategies/screener", label: "策略选股", icon: LayoutList },
      { to: "/strategies/positions", label: "策略跟踪", icon: Star },
      { to: "/backtest", label: "回测审计", icon: LineChart },
    ],
  },
  {
    label: "我的",
    items: [
      { to: "/my-stocks", label: "自选与持仓", icon: Star },
      { to: "/news", label: "快讯", icon: Newspaper },
    ],
  },
  {
    label: "系统",
    items: [
      { to: "/ai", label: "AI 工作台", icon: Sparkles },
      { to: "/butler", label: "大管家", icon: Bot },
      { to: "/settings", label: "设置与状态", icon: Settings },
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
            background: "radial-gradient(circle at 32% 30%, #7df4ff, #22e6ff 55%, #0f7f96)",
            boxShadow: "inset 0 0 0 1px rgba(34,230,255,.45)",
          }}
        />
        {narrow ? null : (
          <span className="leading-tight">
            <span className="block text-[15px] font-bold tracking-wide text-fg">赤轨</span>
            <span className="block text-[12px] text-muted">策略实验台</span>
          </span>
        )}
      </Link>
      <nav className="min-h-0 flex-1 overflow-y-auto scroll-slim px-2 pb-4" aria-label="主导航">
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
                  className="px-num flex w-full items-center justify-between rounded px-3 pt-4 pb-1 text-[12px] tracking-[0.16em] text-muted hover:text-fg"
                >
                  <span className="truncate">// {group.label}</span>
                  <ChevronDown className={"size-3 transition-transform " + (open ? "" : "-rotate-90")} aria-hidden />
                </button>
              )}
              {open &&
                group.items.map((item) => {
                  const active = path === item.to;
                  const Icon = item.icon;
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
                          ? " px-active bg-brand-soft font-medium text-fg"
                          : " text-muted hover:bg-surface-2 hover:text-fg")
                      }
                    >
                      {active && !narrow ? (
                        <span className="h-[5px] w-[5px] shrink-0 bg-brand" aria-hidden="true" />
                      ) : null}
                      <Icon className={"size-3.5 shrink-0 " + (active ? "text-brand-text" : "")} aria-hidden />
                      {narrow ? null : item.label}

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
          "border-t border-sidebar-line py-2 text-[12px] text-muted transition hover:text-fg " +
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
  // 后台不刷：状态条上一串「延迟 N 秒」没人看，回到前台后下一个周期自然补上。
  const visible = usePageVisible();
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
    refetchInterval: visible ? 60_000 : false,
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
  const linkCls = "inline-flex min-h-6 items-center gap-1 py-1 text-muted transition-colors hover:text-fg";
  return (
    <footer
      className="sticky bottom-0 z-20 hidden border-t border-sidebar-line bg-sidebar/95 backdrop-blur-md md:block"
      role="contentinfo"
      aria-label="系统状态条"
    >
      <div className="flex h-8 items-center gap-5 px-4 text-[12px] text-muted">
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
  { label: "涨跌分布", keywords: "market overview 大盘 广度 breadth", to: "/review/breadth" },
  { label: "每日复盘", keywords: "review 复盘", to: "/review" },
  { label: "资金流向", keywords: "flow 资金 北向 两融 期指 板块 个股", to: "/flow" },
  { label: "情绪信号", keywords: "signals 涨停", to: "/review/signals" },
  { label: "公司事件", keywords: "events 日历 业绩", to: "/review/events" },
  { label: "全球市场", keywords: "overseas hk us 港美", to: "/overseas", search: { tab: "indices", market: "hk", page: 1, sort: "chg" } },
  { label: "热点资讯", keywords: "news 快讯", to: "/news" },
  { label: "消息与提醒", keywords: "inbox 提醒", to: "/inbox" },
  { label: "自媒体", keywords: "studio 海报", to: "/studio" },
  { label: "研报库", keywords: "reports", to: "/research/reports" },
  { label: "笔记", keywords: "notes", to: "/research/notes" },
  { label: "自选", keywords: "watchlist my-stocks", to: "/my-stocks" },
  { label: "策略看板", keywords: "screener 策略 选股 持仓", to: "/strategies/screener" },
  { label: "策略管理", keywords: "arena 竞技场 策略管理", to: "/strategies/manage" },
  { label: "跟单与持仓", keywords: "signals 竞技场 信号 持仓 跟踪", to: "/strategies/positions" },
  { label: "失败归因", keywords: "autopsy 归因 亏损", to: "/strategies/autopsy" },
  { label: "盯盘", keywords: "watch 盯盘 同屏 grid 位置 封单 连板 天梯 ladder 晋级率", to: "/watch" },
  { label: "情绪周期", keywords: "cycle 周期 阶段 冰点 高潮 转移", to: "/cycle" },
  { label: "题材", keywords: "themes 题材 催化 前瞻 简报 brief 轮动 rotation 情报 intel", to: "/themes" },
  { label: "游资与席位", keywords: "youzi hotmoney seats 游资 席位 龙虎榜 营业部", to: "/youzi" },
  { label: "前瞻回验", keywords: "huiyan forecast 前瞻 落档 回验 命中", to: "/huiyan" },
  { label: "趋势中军", keywords: "rs 相对强度 趋势 中军 排名", to: "/rs" },
  { label: "区间统计", keywords: "interval 区间 涨幅 统计 板块", to: "/interval" },
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
  const dark = mode === "dark"; // 默认主题已固定浅色，不再跟系统（2026-11-10 换肤）
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#0c0d10" : "#f6f8fa");
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
          className={"whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs " + (mode === item.id ? "bg-surface text-fg" : "text-muted")}
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
          className={"whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs " + (size === item.id ? "bg-surface text-fg" : "text-muted")}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

/**
 * 涨跌配色：A 股约定（红涨绿跌，默认）还是国际习惯（绿涨红跌）。
 *
 * 只翻 --color-up / --color-down 两组 token，别的都不动。默认值必须留在 cn——
 * 红涨绿跌是这个项目的硬约定，不是个人偏好，开关只是给看外盘的人留个口子。
 * 存 localStorage 的 chiheng-scheme；__root.tsx 的内联脚本会在首帧就套上，
 * 避免切页时先红后绿地闪一下。
 */
export function ColorScheme() {
  const [intl, setIntl] = useState(false);
  useEffect(() => {
    setIntl(localStorage.getItem("chiheng-scheme") === "intl");
  }, []);
  const pick = (next: boolean) => {
    setIntl(next);
    if (next) document.documentElement.dataset.scheme = "intl";
    else delete document.documentElement.dataset.scheme;
    localStorage.setItem("chiheng-scheme", next ? "intl" : "cn");
  };
  return (
    <div className="flex rounded-full bg-surface-2 p-0.5" aria-label="涨跌配色">
      <button
        type="button"
        onClick={() => pick(false)}
        className={"whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs " + (!intl ? "bg-surface text-fg" : "text-muted")}
      >
        红涨绿跌
      </button>
      <button
        type="button"
        onClick={() => pick(true)}
        className={"whitespace-nowrap rounded-full px-2.5 py-1.5 text-xs " + (intl ? "bg-surface text-fg" : "text-muted")}
      >
        绿涨红跌
      </button>
    </div>
  );
}

/**
 * 摸鱼模式：把红红绿绿的行情页变成一份无聊的工作文档。
 *
 * 实现是动 token 不是加 filter——filter 会给元素造 containing block，
 * 页面上所有 fixed 浮层会跟着父元素跑，一开就全错位。详见 styles.css 的注释。
 * 存 localStorage 的 chiheng-slack。
 */
export function SlackMode() {
  const [on, setOn] = useState(false);
  useEffect(() => {
    setOn(localStorage.getItem("chiheng-slack") === "1");
  }, []);
  const toggle = () => {
    const next = !on;
    setOn(next);
    if (next) document.documentElement.dataset.slack = "1";
    else delete document.documentElement.dataset.slack;
    localStorage.setItem("chiheng-slack", next ? "1" : "0");
  };
  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={on}
      title="把涨跌配色抹成灰，看起来像在工作"
      className={
        "rounded-full px-2.5 py-1.5 text-xs " +
        (on ? "bg-surface text-fg ring-1 ring-line" : "bg-surface-2 text-muted hover:text-fg")
      }
    >
      {on ? "🐟 摸鱼中" : "🐟 摸鱼模式"}
    </button>
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
              <p className="px-3 pt-2.5 pb-0.5 text-[12px] tracking-widest text-muted">{group.label}</p>
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
            <Link to="/" className="flex h-full min-h-6 shrink-0 items-center gap-1.5 md:hidden">
              <span className="h-4 w-[3px] rounded-full bg-brand" aria-hidden />
              <span className="text-[15px] font-medium tracking-widest">赤轨</span>
            </Link>
            <PageTitle />
            <QuickSearch />
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <AccountChip />
              <button
                type="button"
                onClick={() => void refresh()}
                disabled={refreshing}
                className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded border border-line bg-surface px-3 text-sm text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-60"
              >
                <RefreshCw className={"size-3.5 " + (refreshing ? "animate-spin" : "")} />
                <span className="hidden sm:inline">刷新</span>
              </button>
              <details className="relative hidden shrink-0 sm:block">
                <summary className="cursor-pointer list-none rounded border border-line bg-surface px-2.5 py-1.5 text-xs text-muted hover:bg-surface-2 hover:text-fg [&::-webkit-details-marker]:hidden">显示</summary>
                <div className="absolute right-0 z-30 mt-2 flex flex-col gap-2 rounded border border-line bg-surface p-2">
                  <ThemeMode />
                  <TypeSize />
                  <ColorScheme />
                  <SlackMode />
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
