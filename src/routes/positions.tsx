/**
 * 这个文件是干什么的：
 * 持仓页。按交易日期分组，每天一块：上面是当天的汇总（开仓笔数、合计数量和
 * 金额、盈亏），下面是这一天的每一笔明细。页头还有一条所有天的合计。
 *
 * 你需要知道的：
 * 原来持仓表是塞在选股页底下的，和策略切换、精选表挤在一起——盯盘时真正要盯的
 * 持仓被压在第三屏。这里把它拆成独立页面，选股页只留一个入口。
 *
 * 金额口径见 lib/market/positions.ts 的注释：**不记仓位大小，每笔按一手（100 股）
 * 折算名义金额**，不是投入的钱。收益率一律扣费。已实现和浮动分开显示。
 */
import { useEffect, useMemo, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { Bar, BarChart, Cell, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { StockName } from "@/components/screener/stock-name";
import { Frame } from "@/components/screener/nav";
import { DataStatusBadge, AccountStatus } from "@/components/screener/data-status";
import { StateBlock } from "@/components/state-block";
import { RowMenuPortal, useRowMenu, type RowMenuItem } from "@/components/row-menu";
import { Panel, Stat, Tag, Table, tdClass, thClass, pctClass } from "@/components/terminal";
import { signedPct, fmtPrice, fmtMoney, toneClass } from "@/lib/market/format";
import { dayReliable, liveGate, recentMean } from "@/lib/market/journal-book";
import { TRACK_NEED } from "@/lib/market/model";
import { limitTag, planExit } from "@/lib/market/model";
import { dayHeading, groupByDay, needsAction, overallOf, rowReturn, sortByUrgency, tradeState, type PositionRow } from "@/lib/market/positions";
import { STYLES, styleOf } from "@/lib/market/strategies";
import { DEFAULT_RULES, type EarlyRules } from "@/lib/market/rules";
import { shanghaiDate } from "@/lib/market/session";
import { getChallengers, getNavHistory, getServerJournal, getUniverse, type NavPoint } from "@/lib/market/quotes.functions";
import type { Challenger } from "@/lib/market/challenger";
import { CollapsibleSection } from "@/components/collapsible";
import { PageTabs } from "@/components/page-tabs";
import { usePaper, type PaperDay } from "@/lib/paper";
import { useSymbolUi } from "@/lib/ui/symbol-store";
import type { Universe } from "@/lib/market/types";

export const Route = createFileRoute("/positions")({
  loader: async () => {
    const [universe, journal, nav, chal] = await Promise.all([
      getUniverse({ data: { refresh: false } }).catch(() => null),
      getServerJournal(),
      // 净值史是收盘后记账进程沉淀的，读不到就当空的——页面显示空态而不是打不开。
      getNavHistory().catch(() => ({ points: [] as NavPoint[] })),
      getChallengers().catch(() => ({ list: [] as Challenger[], champions: {} as Record<string, string> })),
    ]);
    return {
      universe,
      journal,
      nav: nav.points,
      rules: DEFAULT_RULES,
      date: shanghaiDate(),
      chal: chal.list,
      champions: chal.champions,
    };
  },
  component: Positions,
});

const WEEKDAYS: Record<string, string> = { Mon: "周一", Tue: "周二", Wed: "周三", Thu: "周四", Fri: "周五", Sat: "周六", Sun: "周日" };

function weekdayOf(date: string): string {
  const match = date.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return "";
  const d = new Date(`${match[1]}-${match[2]}-${match[3]}T12:00:00+08:00`);
  return WEEKDAYS[new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", weekday: "short" }).format(d)] ?? "";
}

/** 把账本摊平成带收益率的行。未卖的去快照里找现价。 */
function buildRows(days: PaperDay[], universe: Universe | null, rules: EarlyRules): PositionRow[] {
  const byId = new Map((universe?.quotes ?? []).map((q) => [q.id, q]));
  const today = shanghaiDate();
  const rows: PositionRow[] = [];
  for (const day of days) {
    for (const trade of day.trades) {
      const live = byId.get(trade.id) ?? null;
      const price = live?.price ?? null;
      const ret = rowReturn(trade.entry, trade.exit, price);
      const exitPrice = trade.exit ?? price;
      // state 判定搬去了 lib/market/positions.ts 的 tradeState()——个股抽屉要用同一份，
      // 两处各写一份迟早出现「持仓页说止损、抽屉说持有」。
      const state = tradeState(trade, day.date, live, today, rules);
      rows.push({
        id: trade.id,
        code: trade.code,
        name: trade.name,
        style: trade.style,
        entry: trade.entry,
        stop: trade.stop,
        target: trade.target,
        exit: trade.exit,
        exitDate: trade.exitDate,
        day: day.date,
        signalTime: day.signalTime ?? "",
        live: live ? { price: live.price, chg: live.chg } : null,
        ret,
        state,
        pnl: exitPrice == null ? null : exitPrice - trade.entry,
        // 同期沪深300，用来算有没有跑赢指数
        indexRet: day.indexEntry && day.indexExit ? day.indexExit / day.indexEntry - 1 : null,
      });
    }
  }
  return rows;
}

function TradeTable({
  rows,
  rules,
  caption,
}: {
  rows: PositionRow[];
  rules: EarlyRules;
  /** 给读屏器的表格名字。同一张表在「需处理」和各日期分组里都用到，名字要跟着变 */
  caption: string;
}) {
  const navigate = useNavigate();
  const openSymbol = useSymbolUi((s) => s.open);
  const rowMenu = useRowMenu();
  // 和选股页结果表同一套右键菜单：看个股 / 看资金流向 / 复制代码。
  const menuFor = (row: PositionRow): RowMenuItem[] => [
    { label: "看个股", onClick: () => openSymbol(row.id, "positions") },
    { label: "看资金流向", onClick: () => void navigate({ to: "/flow", hash: "flow-stocks" }) },
    { label: "复制代码", onClick: () => void navigator.clipboard?.writeText(row.code) },
  ];
  return (
    <>
      <Table className="data-table" caption={caption}>
      <thead>
        <tr className="border-b border-line">
          <th className={thClass("sticky left-0 bg-surface px-2.5 py-1.5 text-left font-normal")}>名称</th>
          <th className={thClass()}>现价</th>
          <th className={thClass()}>涨跌幅</th>
          <th className={thClass()}>买入价</th>
          <th className={thClass()}>收益率</th>
          <th className={thClass()}>盈亏/股</th>
          <th className={thClass()}>卖出价</th>
          <th className={thClass("hidden md:table-cell")}>卖出/止损</th>
          <th className={thClass("hidden md:table-cell")}>策略</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => {
          const levels = row.stop && row.target ? { stop: row.stop, target: row.target } : planExit(row.entry, null, rules);
          const tone = row.state === "止损" ? "down" : row.state === "卖出" ? "up" : "muted";
          return (
            <tr
              key={`${row.day}-${row.id}-${row.exit ?? "open"}`}
              className="border-b border-line last:border-0 hover:bg-surface-2"
              onContextMenu={(event) => rowMenu.openFor(event, menuFor(row))}
            >
              <td data-l="名称" className="sticky left-0 bg-surface px-2.5 py-1.5 text-left">
                <StockName id={row.id} name={row.name} source="positions" className="font-medium" />
                <div className="text-xs text-muted">
                  {row.code} · <Tag tone={tone}>{row.state}</Tag>
                </div>
              </td>
              <td data-l="现价" className={tdClass("font-medium")}>{row.live ? fmtPrice(row.live.price) : "—"}</td>
              <td data-l="涨跌幅" className={tdClass(pctClass(row.live?.chg))}>{row.live ? signedPct(row.live.chg) : "—"}</td>
              <td data-l="买入价" className={tdClass()}>{fmtPrice(row.entry)}</td>
              <td data-l="收益率" className={tdClass(row.ret == null ? "text-muted" : pctClass(row.ret * 100))}>
                {row.ret == null ? "—" : signedPct(row.ret * 100)}
              </td>
              <td data-l="盈亏/股" className={tdClass(row.pnl == null ? "text-muted" : pctClass(row.pnl))}>
                {row.pnl == null ? "—" : row.pnl.toFixed(2)}
              </td>
              <td data-l="卖出价" data-opt className={tdClass("text-muted")}>
                {row.exit != null ? fmtPrice(row.exit) : "—"}
                {row.exitDate ? <div className="text-xs">{row.exitDate.slice(5)}</div> : null}
              </td>
              <td data-l="卖出/止损" data-opt className={tdClass("hidden text-muted md:table-cell")}>
                {fmtPrice(levels.target)} / {fmtPrice(levels.stop)}
              </td>
              <td data-l="策略" data-opt className={tdClass("hidden text-muted md:table-cell")}>
                {STYLES.find((s) => s.id === styleOf(row as never))?.name ?? "—"}
              </td>
            </tr>
          );
        })}
      </tbody>
      </Table>
      <RowMenuPortal menu={rowMenu.menu} onClose={rowMenu.close} />
    </>
  );
}
const CHAL_STATUS: Record<Challenger["status"], { label: string; className: string }> = {
  running: { label: "在跑", className: "text-fg" },
  promoted: { label: "已转正", className: "text-up" },
  rejected: { label: "已淘汰", className: "text-down" },
  inconclusive: { label: "停跑·未分胜负", className: "text-muted" },
};

/**
 * 冠军-挑战者 + AI 提名面板。挑战者和冠军同一套选股名单、只改出场参数，
 * 攒满 30 笔已平仓后 Welch t ≥ 1.5 转正 / t ≤ −2 淘汰——判决是记账进程里
 * 预先登记的函数算的，AI 只许提名，不许任命。
 */
function ChallengerPanel({
  list,
  champions,
}: {
  list: Challenger[];
  champions: Record<string, string>;
}) {
  const styleName = (id: string) => STYLES.find((s) => s.id === id)?.name ?? id;
  const runningCount = list.filter((c) => c.status === "running").length;
  // 失效的（已淘汰/停跑）不和在跑的混排——用户 2026-10-16：失效的东西单独放。
  const alive = list.filter((c) => c.status === "running" || c.status === "promoted");
  const dead = list.filter((c) => c.status === "rejected" || c.status === "inconclusive");
  const renderRow = (c: Challenger) => {
    const st = CHAL_STATUS[c.status];
    const isChampion = champions[c.style] === c.id;
    return (
      <li key={c.id} className="flex flex-wrap items-baseline gap-x-2 text-xs">
        <span className={`shrink-0 ${st.className}`}>{st.label}</span>
        <span className="font-medium">
          {c.name}
          {isChampion ? <span className="ml-1 text-[10px] text-brand-text">现任冠军</span> : null}
        </span>
        <span className="text-muted">
          {styleName(c.style)} · 持有{c.holdDays ?? "沿用冠军"}天 · 止损{c.stopPct ?? "沿用冠军"}% · 目标
          {c.targetPct ?? "沿用冠军"}%
        </span>
        {c.note ? <span className="w-full text-[11px] text-muted">{c.note}</span> : null}
      </li>
    );
  };
  return (
    <Panel
      title="冠军-挑战者"
      note={`${runningCount} 个在跑 · 转正要 Welch t ≥ 1.5（30 笔）`}
      bodyClassName="px-3 py-2"
    >
      {alive.length > 0 ? (
        <ul className="space-y-1">{alive.map(renderRow)}</ul>
      ) : (
        <p className="text-xs text-muted">还没有在跑的挑战者。AI 可以读策略闸和判决记录后提名，也可以手工编辑 data/challengers.json。</p>
      )}
      {dead.length > 0 ? (
        <CollapsibleSection
          className="mt-2"
          storageKey="ch-collapse-dead-challengers"
          defaultOpen={false}
          headerClassName="bg-surface-2"
          header={
            <>
              <h2 className="text-xs font-medium">已出结果（不再在跑）</h2>
              <p className="text-[11px] text-muted">{dead.length} 个 · 淘汰或停跑，记录保留</p>
            </>
          }
        >
          <ul className="space-y-1 px-3 py-2">{dead.map(renderRow)}</ul>
        </CollapsibleSection>
      ) : null}
      <p className="mt-2 border-t border-line pt-2 text-xs">
        <Link to="/ai" className="text-brand hover:underline">
          AI 提名挑战者、配接口 → AI 管理页
        </Link>
      </p>
    </Panel>
  );
}

/**
 * 持仓体检（X-ray）：两个图把「钱在哪、哪天赚的」一眼铺开（学 Vibe-Research
 * 的 portfolio X-ray 思路，图表用本页已有的 recharts）。
 * ① 每日盈亏柱：按开仓日分组的总收益率，红赚绿亏。
 * ② 未平仓按策略分布：只数笔数——这套模拟盘不记仓位大小，按金额分是假精确。
 */
function XrayPanel({ groups, openRows }: { groups: ReturnType<typeof groupByDay>; openRows: PositionRow[] }) {
  const daily = groups
    .filter((group) => group.total != null)
    .map((group) => ({ date: group.date.slice(5), pct: (group.total ?? 0) * 100 }))
    .reverse();
  const buckets = new Map<string, { name: string; count: number; chgSum: number; chgN: number }>();
  for (const row of openRows) {
    const style = styleOf(row as never);
    if (!style) continue;
    const name = STYLES.find((item) => item.id === style)?.name ?? style;
    const bucket = buckets.get(style) ?? { name, count: 0, chgSum: 0, chgN: 0 };
    bucket.count += 1;
    if (row.live?.chg != null) {
      bucket.chgSum += row.live.chg;
      bucket.chgN += 1;
    }
    buckets.set(style, bucket);
  }
  const styles = [...buckets.values()].sort((a, b) => b.count - a.count);
  const maxCount = Math.max(1, ...styles.map((bucket) => bucket.count));

  return (
    <Panel
      title="持仓体检"
      note={<span>每天盈亏 + 未平仓结构 · 口径和上面分组一致</span>}
      bodyClassName="px-3.5 py-3"
    >
      {daily.length >= 2 ? (
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={daily} margin={{ top: 4, right: 0, bottom: 0, left: 0 }}>
              <XAxis
                dataKey="date"
                tick={{ fontSize: 10, fill: "var(--color-muted)" }}
                tickLine={false}
                axisLine={false}
                minTickGap={32}
              />
              <YAxis
                tick={{ fontSize: 10, fill: "var(--color-muted)" }}
                tickLine={false}
                axisLine={false}
                width={44}
                tickFormatter={(v: number) => `${v.toFixed(1)}%`}
              />
              <Tooltip
                cursor={{ fill: "var(--color-surface-2)" }}
                contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-line)", borderRadius: 6, fontSize: 12 }}
                labelStyle={{ color: "var(--color-muted)" }}
                formatter={(value) => [typeof value === "number" ? signedPct(value) : "—", "当天合计盈亏"]}
              />
              <Bar dataKey="pct" radius={[2, 2, 0, 0]}>
                {daily.map((row) => (
                  <Cell key={row.date} fill={row.pct >= 0 ? "var(--color-up)" : "var(--color-down)"} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <p className="text-xs text-muted">攒够两个开仓日才画每日盈亏柱。</p>
      )}

      {styles.length > 0 ? (
        <div className="mt-3 border-t border-line pt-3">
          <h3 className="mb-2 text-xs text-muted">未平仓 {openRows.length} 只 · 按策略（按笔数，不按金额）</h3>
          <ul className="flex flex-col gap-1.5">
            {styles.map((bucket) => (
              <li key={bucket.name} className="flex items-baseline gap-2 text-xs">
                <span className="w-16 shrink-0 truncate">{bucket.name}</span>
                <span className="h-2.5 shrink-0 rounded bg-brand/70" style={{ width: `${(bucket.count / maxCount) * 40 + 8}%` }} aria-hidden />
                <span className="tabular-nums text-muted">{bucket.count} 只</span>
                <span className={bucket.chgN > 0 ? pctClass(bucket.chgSum / bucket.chgN) : "text-muted"}>
                  今日均值 {bucket.chgN > 0 ? signedPct(bucket.chgSum / bucket.chgN) : "—"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="mt-3 border-t border-line pt-3 text-xs text-muted">当前没有未平仓的票。</p>
      )}
    </Panel>
  );
}

function Positions() {
  const { universe, journal, nav, rules, date, chal, champions } = Route.useLoaderData();
  const browserDays = usePaper((state) => state.days);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    // rehydrate() 有时返回 void、有时返回 Promise，两种都当成「读完了」
    const done = usePaper.persist.rehydrate();
    if (done instanceof Promise) void done.then(() => setReady(true));
    else setReady(true);
  }, []);

  const onServer = journal.personal;
  const days = onServer || journal.days.length > 0 ? journal.days : browserDays;
  const rows = useMemo(() => buildRows(days, universe, rules), [days, universe, rules]);
  const groups = useMemo(() => groupByDay(rows), [rows]);
  const total = useMemo(() => overallOf(groups), [groups]);
  // 盘中第 ② 步是最高频动作：每 60 秒扫一眼「谁到止损/目标价了」。
  // 这些票散落在各个日期分组里，合并到最上面，省得在一屏 60 行里自己找。
  const urgent = useMemo(() => sortByUrgency(rows.filter(needsAction)), [rows]);
  // 组内也按紧迫度排，逻辑跟上面一致
  const sortedGroups = useMemo(
    () => groups.map((group) => ({ ...group, open: sortByUrgency(group.open), closed: sortByUrgency(group.closed) })),
    [groups],
  );
  const now = Date.now();

  // 历史战绩：收盘后补记的那天不算成绩（价格是拿休市后的快照倒推的）。
  // 持仓列表照常显示——那几笔确实拿着，只是不进统计。
  const closed = rows.filter((row) => row.exit != null);
  const scored = closed.filter((row) => dayReliable({ signalTime: row.signalTime }));
  const wins = scored.filter((row) => row.ret != null && row.ret > 0).length;
  const cum = scored.reduce((sum, row) => sum + (row.ret ?? 0), 0);
  // 指数只在账本记了 indexEntry/indexExit 的那些天上才有，全都没有就显示「—」
  const indexRows = scored.filter((row) => row.indexRet != null);
  const indexCum =
    indexRows.length === 0 ? null : indexRows.reduce((sum, row) => sum + (row.indexRet ?? 0), 0);
  const recent = recentMean(scored.map((row) => row.ret).filter((v): v is number => v != null), 20);
  const gate = liveGate(groups.length, scored, scored.filter((r) => r.ret != null).map((r) => ({ date: r.exitDate ?? r.day, ret: r.ret! })), rules);
  // 收益归因：按策略拆已平仓且计入统计的那几笔（和「历史战绩」同一口径，不各说各话）。
  const attribution = useMemo(() => {
    const buckets = new Map<string, { name: string; rets: number[] }>();
    for (const row of scored) {
      if (row.ret == null) continue;
      const style = styleOf(row as never);
      if (!style) continue;
      const name = STYLES.find((item) => item.id === style)?.name ?? style;
      const bucket = buckets.get(style) ?? { name, rets: [] };
      bucket.rets.push(row.ret);
      buckets.set(style, bucket);
    }
    return [...buckets.values()].map(({ name, rets }) => {
      const wins = rets.filter((ret) => ret > 0).length;
      return {
        name,
        count: rets.length,
        winRate: wins / rets.length,
        avg: rets.reduce((sum, ret) => sum + ret, 0) / rets.length,
        best: Math.max(...rets),
        worst: Math.min(...rets),
      };
    });
  }, [scored]);

  const holdTab = (
    <div className="flex flex-col gap-2">
        {/* 合计用一格一格的排法：分隔线是 1px 的 gap 垫出来的（gap-px + bg-line），
            不加阴影。和「资金」页概览、策略卡同一套版式。 */}
        <Panel
          title="合计"
          note={
            <span>
              {total.openCount} 只在拿 · {total.closedCount} 只已卖
              {!onServer && ready ? " · 本机浏览器的账" : ""}
            </span>
          }
          bodyClassName="grid grid-cols-2 gap-px bg-line sm:grid-cols-3 lg:grid-cols-6"
        >
          <Stat label="开仓笔数" value={total.count} className="bg-surface" />
          <Stat label="合计数量" value={`${total.shares} 股`} hint={`${total.shares / 100} 手`} className="bg-surface" />
          <Stat label="合计金额" value={fmtMoney(total.amount)} hint="名义金额，每笔按一手" className="bg-surface" />
          <Stat
            label="已实现"
            value={total.realized == null ? "—" : signedPct(total.realized * 100)}
            tone={pctClass(total.realized == null ? null : total.realized * 100)}
            hint="每笔收益率相加，已扣费"
            className="bg-surface"
          />
          <Stat
            label="浮动"
            value={total.unrealized == null ? "—" : signedPct(total.unrealized * 100)}
            tone={pctClass(total.unrealized == null ? null : total.unrealized * 100)}
            hint="按现价算"
            className="bg-surface"
          />
          <Stat
            label="合计盈亏"
            value={total.total == null ? "—" : signedPct(total.total * 100)}
            tone={pctClass(total.total == null ? null : total.total * 100)}
            className="bg-surface"
          />
        </Panel>

        {urgent.length > 0 ? (          <Panel
            title={
              <span className="flex items-baseline gap-2">
                需处理 <span className="num text-warn">{urgent.length}</span>
              </span>
            }
            note={<span>到价了能卖的排最前，跌停卖不出的也列出来</span>}
            bodyClassName="px-3.5 py-3"
          >
            {/*
              左边一条警示色，和消息页「利好 / 利空」两栏同一个手法：
              不读标题、只看色条就知道这块是要动手的，不是回顾用的。
              色条放在内容上而不是标题上——表格才是要被注意的东西，标题只是个名字。
            */}
            <div className="border-l-2 pl-3.5" style={{ borderLeftColor: "var(--color-warn)" }}>
              <TradeTable
                rows={urgent}
                rules={rules}
                caption={`需要现在处理的持仓，共 ${urgent.length} 笔`}
              />
            </div>
          </Panel>
        ) : null}

        {groups.length === 0 ? (
          <Panel>
            <StateBlock
              kind="empty"
              title={ready || onServer ? "还没有开过仓" : "正在读取记录"}
              hint="打到买入价才记一笔。名额按天算，每套策略每天最多 10 只；当天不能卖，跌停卖不出会顺延。"
            />
          </Panel>
        ) : (
          sortedGroups.map((group) => (
            // 一天一块。日期条用 surface-2 垫底：往下滚的时候，靠这一条深色就能分出
            // 「换了一天」，不用回去找标题。这是持仓页唯一需要扫读的边界。
            // 过去的天默认折起来（要看哪天的盈亏点开就是），今天的默认展开；
            // 用户点过的状态记在 localStorage，刷新保持。
            <CollapsibleSection
              key={group.date}
              storageKey={`ch-collapse-pos-${group.date}`}
              defaultOpen={group.date === date}
              headerClassName="flex-wrap justify-between gap-x-3 gap-y-1 bg-surface-2"
              header={
                <>
                  <h2 className="text-sm font-medium">{dayHeading(group.date, weekdayOf(group.date))}</h2>
                  <p className="text-xs text-muted">
                    {group.count} 笔 · {group.shares} 股 · 金额 {fmtMoney(group.amount)} ·{" "}
                    {group.total == null ? (
                      "盈亏 —"
                    ) : (
                      <span className={pctClass(group.total * 100)}>盈亏 {signedPct(group.total * 100)}</span>
                    )}
                  </p>
                </>
              }
            >
              <div className="grid grid-cols-2 gap-px border-b border-line bg-line sm:grid-cols-4">
                <Stat
                  label="开仓笔数"
                  value={group.count}
                  className="bg-surface"
                  hint={group.open.length > 0 ? `${group.open.length} 只在拿` : "都卖了"}
                />
                <Stat label="合计数量" value={`${group.shares} 股`} className="bg-surface" hint={`${group.shares / 100} 手`} />
                <Stat
                  label="已实现"
                  value={group.realized == null ? "—" : signedPct(group.realized * 100)}
                  tone={pctClass(group.realized == null ? null : group.realized * 100)}
                  className="bg-surface"
                  hint={group.pnlAmount == null ? "当天没卖出" : `${group.pnlAmount > 0 ? "+" : ""}${group.pnlAmount} 元`}
                />
                <Stat
                  label="浮动"
                  value={group.unrealized == null ? "—" : signedPct(group.unrealized * 100)}
                  tone={pctClass(group.unrealized == null ? null : group.unrealized * 100)}
                  className="bg-surface"
                  hint={
                    group.openPnlAmount == null
                      ? group.open.length > 0 ? "有持仓拿不到现价" : "没有持仓"
                      : `${group.openPnlAmount > 0 ? "+" : ""}${group.openPnlAmount} 元`
                  }
                />
              </div>
              <TradeTable
                rows={[...group.closed, ...group.open]}
                rules={rules}
                caption={`${dayHeading(group.date, weekdayOf(group.date))} 开仓的 ${group.count} 笔`}
              />
            </CollapsibleSection>
          ))
        )}

        {/* 两处口径不一样，得写出来，不然会以为哪边算错了。
            这里照常列已卖的盈亏，下面「历史战绩」却可能少几笔——少的那几笔
            记在收盘后补记的那天（signalTime ≥ 15:00），整天不进统计。 */}
        {closed.length > scored.length ? (
          <p className="px-1 text-xs leading-relaxed text-muted">
            下面「历史战绩」会比这里的已卖少 {closed.length - scored.length} 笔：那几笔记在收盘后补记的
            交易日（signalTime ≥ 15:00），按口径整天不进统计。持仓列表照常显示它们的盈亏。
          </p>
        ) : null}
    </div>
  );

  {/* 体检 tab：当前状态——挑战者赛马、净值曲线、持仓结构。 */}
  const checkTab = (
    <div className="flex flex-col gap-2">
        <ChallengerPanel list={chal} champions={champions} />

        {/* 净值曲线：收盘后记账进程逐日沉淀（record-journal.ts），这里只画不造数。
            不足两个点不出图——首日只有孤立一点，连不成线，硬画是误导。 */}
        {nav.length >= 2 ? (
          <Panel
            title="净值曲线"
            note={
              <span className="flex items-center gap-3">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-fg" aria-hidden /> 策略净值</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-muted" aria-hidden /> 沪深300</span>
              </span>
            }
            bodyClassName="px-3 py-3"
          >
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={nav} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 10, fill: "var(--color-muted)" }}
                    tickLine={false}
                    axisLine={false}
                    minTickGap={48}
                    tickFormatter={(d: string) => d.slice(5)}
                  />
                  <YAxis
                    domain={["dataMin", "dataMax"]}
                    tick={{ fontSize: 10, fill: "var(--color-muted)" }}
                    tickLine={false}
                    axisLine={false}
                    width={48}
                    tickFormatter={(v: number) => `${((v - 1) * 100).toFixed(1)}%`}
                  />
                  <Tooltip
                    contentStyle={{ background: "var(--color-surface)", border: "1px solid var(--color-line)", borderRadius: 6, fontSize: 12 }}
                    labelStyle={{ color: "var(--color-muted)" }}
                    formatter={(value, name) => [
                      typeof value === "number" ? `${((value - 1) * 100).toFixed(2)}%` : "—",
                      name,
                    ]}
                  />
                  <Line type="monotone" dataKey="nav" name="策略净值" stroke="var(--color-fg)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  <Line type="monotone" dataKey="benchmark" name="沪深300" stroke="var(--color-muted)" strokeWidth={1} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
            <p className="border-t border-line pt-2 text-xs leading-relaxed text-muted">
              策略净值 = 1 + 全部逐笔收益的平均（已平仓按卖出价、持仓按收盘现价）；沪深300 对首个记录交易日归一。每个收盘记一个点，由记账进程写入。
            </p>
          </Panel>
        ) : (
          <Panel title="净值曲线">
            <StateBlock
              kind="empty"
              title="净值曲线从今天开始沉淀"
              hint="每个收盘记一个点：策略净值是全部逐笔收益的平均，对照沪深300。攒够两个交易日自动出图，数据由记账进程写入，这里不估算。"
            />
          </Panel>
        )}

        {/* 体检图放在净值曲线下面：先看见「跑得怎么样」，再展开看「为什么」。 */}
        <XrayPanel groups={sortedGroups} openRows={rows.filter((row) => row.exit == null)} />
    </div>
  );

  {/* 战绩 tab：回头看的统计——历史战绩、按策略归因、口径说明。 */}
  const recordTab = (
    <div className="flex flex-col gap-2">
        <Panel title="历史战绩" note={<span>{closed.length === 0 ? "还没有卖出" : `${closed.length} 笔已卖`}</span>}>
          <div className="grid grid-cols-2 gap-px bg-line sm:grid-cols-4">
            <Stat
              label="上涨占比"
              value={scored.length === 0 ? "—" : `${((wins / scored.length) * 100).toFixed(2)}%`}
              className="bg-surface"
            />
            <Stat
              label="累计收益"
              value={scored.length === 0 ? "—" : signedPct(cum * 100)}
              tone={toneClass(scored.length ? cum * 100 : null)}
              className="bg-surface"
            />
            <Stat
              label="最近 20 笔均值"
              value={recent == null ? "—" : signedPct(recent * 100)}
              className="bg-surface"
            />
            <Stat
              label="沪深300"
              value={indexCum == null ? "—" : signedPct(indexCum * 100)}
              tone={toneClass(indexCum == null ? null : indexCum * 100)}
              className="bg-surface"
            />
          </div>
          <p className="border-t border-line px-3 py-2 text-xs leading-relaxed text-muted">
            卖出看目标价，不看 60 天。{gate.reason}。累计收益是每笔扣费后收益相加。
            不满 {TRACK_NEED} 个交易日时，上涨占比还只是样本。
          </p>
        </Panel>

        {/* 收益归因：同一批 scored 按策略拆开，看钱是在哪套赚的、哪套在亏。
            样本太少的策略不单独成行——一两笔撑不起「归因」两个字，混在合计里更诚实。 */}
        {attribution.length > 0 ? (
          <Panel title="收益归因 · 按策略" note={<span>已平仓且计入统计的 {scored.length} 笔</span>}>
            <Table className="data-table" caption="按策略分组的已平仓收益归因">
              <thead>
                <tr className="border-b border-line">
                  <th className={thClass("sticky left-0 bg-surface px-2.5 py-1.5 text-left font-normal")}>策略</th>
                  <th className={thClass()}>笔数</th>
                  <th className={thClass()}>胜率</th>
                  <th className={thClass()}>平均盈亏</th>
                  <th className={thClass()}>最佳</th>
                  <th className={thClass()}>最差</th>
                </tr>
              </thead>
              <tbody>
                {attribution.map((row) => (
                  <tr key={row.name} className="border-b border-line last:border-0 hover:bg-surface-2">
                    <td data-l="策略" className="sticky left-0 bg-surface px-2.5 py-1.5 text-left font-medium">{row.name}</td>
                    <td data-l="笔数" className={tdClass("tabular-nums")}>{row.count}</td>
                    <td data-l="胜率" className={tdClass()}>{(row.winRate * 100).toFixed(1)}%</td>
                    <td data-l="平均盈亏" className={tdClass(pctClass(row.avg * 100))}>{signedPct(row.avg * 100)}</td>
                    <td data-l="最佳" className={tdClass(pctClass(row.best * 100))}>{signedPct(row.best * 100)}</td>
                    <td data-l="最差" className={tdClass(pctClass(row.worst * 100))}>{signedPct(row.worst * 100)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
            <p className="border-t border-line px-3 py-2 text-xs leading-relaxed text-muted">
              和「历史战绩」同一口径：收盘后补记的信号日不进统计。每笔收益率已扣费，是简单平均、不按金额加权。
            </p>
          </Panel>
        ) : null}

        <p className="px-1 text-xs leading-relaxed text-muted">
          金额是名义金额：这套模拟盘不记仓位大小、每笔按满仓记，所以这里按每笔一手（100 股）折算，不是投入的钱。
          收益率已扣佣金和印花税，汇总是每笔收益率相加，不是按金额加权。
        </p>
    </div>
  );

  return (
    <Frame
      wide
      aside={
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
          <span className="text-fg">持仓</span>
          <span className="tabular-nums">{date}</span>
          <AccountStatus personal={journal.personal} why={journal.why} />
          <DataStatusBadge universe={universe} now={now} onRefresh={() => window.location.reload()} />
        </div>
      }
    >
      <PageTabs
        storageKey="chiheng-pos-tab"
        tabs={[
          {
            key: "hold",
            label: urgent.length > 0 ? `持仓 · 需处理 ${urgent.length}` : "持仓",
            content: holdTab,
          },
          { key: "check", label: "体检", content: checkTab },
          { key: "record", label: "战绩", content: recordTab },
        ]}
      />
    </Frame>
  );
}
