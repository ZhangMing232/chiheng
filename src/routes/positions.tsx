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
import { createFileRoute, Link } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { DataStatusBadge, AccountStatus } from "@/components/screener/data-status";
import { StateBlock } from "@/components/state-block";
import { Panel, Stat, Tag, Table, tdClass, thClass, pctClass } from "@/components/terminal";
import { signedPct, fmtPrice, fmtMoney, toneClass } from "@/lib/market/format";
import { dayReliable, liveGate, recentMean } from "@/lib/market/journal-book";
import { TRACK_NEED } from "@/lib/market/model";
import { limitTag, planExit } from "@/lib/market/model";
import { dayHeading, groupByDay, needsAction, overallOf, rowReturn, sortByUrgency, type PositionRow } from "@/lib/market/positions";
import { STYLES, styleOf } from "@/lib/market/strategies";
import { DEFAULT_RULES, type EarlyRules } from "@/lib/market/rules";
import { shanghaiDate } from "@/lib/market/session";
import { getServerJournal, getUniverse } from "@/lib/market/quotes.functions";
import { usePaper, type PaperDay } from "@/lib/paper";
import type { Universe } from "@/lib/market/types";

export const Route = createFileRoute("/positions")({
  loader: async () => {
    const [universe, journal] = await Promise.all([
      getUniverse({ data: { refresh: false } }).catch(() => null),
      getServerJournal(),
    ]);
    return { universe, journal, rules: DEFAULT_RULES, date: shanghaiDate() };
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
  const rows: PositionRow[] = [];
  for (const day of days) {
    for (const trade of day.trades) {
      const live = byId.get(trade.id) ?? null;
      const price = live?.price ?? null;
      const ret = rowReturn(trade.entry, trade.exit, price);
      const exitPrice = trade.exit ?? price;
      const state =
        trade.exit != null
          ? "已卖"
          : day.date >= shanghaiDate()
            ? "T+1"
            : live && limitTag(live) === "跌停"
              ? "跌停"
              : live && live.price <= (trade.stop ?? planExit(trade.entry, null, rules).stop)
                ? "止损"
                : live && live.price >= (trade.target ?? planExit(trade.entry, null, rules).target)
                  ? "卖出"
                  : "持有";
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
  return (
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
            <tr key={`${row.day}-${row.id}-${row.exit ?? "open"}`} className="border-b border-line last:border-0 hover:bg-surface-2">
              <td data-l="名称" className="sticky left-0 bg-surface px-2.5 py-1.5 text-left">
                <Link to="/symbol" search={{ q: row.code }} className="font-medium hover:text-brand">
                  {row.name}
                </Link>
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
  );
}

function Positions() {
  const { universe, journal, rules, date } = Route.useLoaderData();
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

  return (
    <Frame
      aside={
        <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted">
          <span className="text-fg">持仓</span>
          <span className="tabular-nums">{date}</span>
          <AccountStatus personal={journal.personal} why={journal.why} />
          <DataStatusBadge universe={universe} now={now} onRefresh={() => window.location.reload()} />
        </div>
      }
    >
      <div className="flex flex-col gap-2">
        <Panel
          title="合计"
          note={
            <span>
              {total.openCount} 只在拿 · {total.closedCount} 只已卖
              {!onServer && ready ? " · 本机浏览器的账" : ""}
            </span>
          }
          bodyClassName="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6"
        >
          <Stat label="开仓笔数" value={total.count} />
          <Stat label="合计数量" value={`${total.shares} 股`} hint={`${total.shares / 100} 手`} />
          <Stat label="合计金额" value={fmtMoney(total.amount)} hint="名义金额，每笔按一手" />
          <Stat
            label="已实现"
            value={total.realized == null ? "—" : signedPct(total.realized * 100)}
            tone={pctClass(total.realized == null ? null : total.realized * 100)}
            hint="每笔收益率相加，已扣费"
          />
          <Stat
            label="浮动"
            value={total.unrealized == null ? "—" : signedPct(total.unrealized * 100)}
            tone={pctClass(total.unrealized == null ? null : total.unrealized * 100)}
            hint="按现价算"
          />
          <Stat
            label="合计盈亏"
            value={total.total == null ? "—" : signedPct(total.total * 100)}
            tone={pctClass(total.total == null ? null : total.total * 100)}
          />
        </Panel>

        {urgent.length > 0 ? (
          <Panel
            title={
              <span className="flex items-baseline gap-2">
                <span className="size-1.5 rounded-full bg-warn align-middle" aria-hidden />
                需处理 <span className="num" style={{ color: "var(--color-warn)" }}>{urgent.length}</span>
              </span>
            }
            note={<span>到价了能卖的排最前，跌停卖不出的也列出来</span>}
            bodyClassName="overflow-x-auto"
          >
            <TradeTable
              rows={urgent}
              rules={rules}
              caption={`需要现在处理的持仓，共 ${urgent.length} 笔`}
            />
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
            <Panel
              key={group.date}
              title={
                <span className="flex items-baseline gap-2">
                  {dayHeading(group.date, weekdayOf(group.date))}
                  <span className="text-xs font-normal text-muted">
                    {group.count} 笔 · {group.shares} 股
                  </span>
                </span>
              }
              note={
                <span className="flex items-baseline gap-2">
                  <span>金额 {fmtMoney(group.amount)}</span>
                  {group.total == null ? (
                    <span className="text-muted">盈亏 —</span>
                  ) : (
                    <span className={pctClass(group.total * 100)}>盈亏 {signedPct(group.total * 100)}</span>
                  )}
                </span>
              }
              bodyClassName="overflow-x-auto"
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
            </Panel>
          ))
        )}

        <Panel title="历史战绩" note={<span>{closed.length === 0 ? "还没有卖出" : `${closed.length} 笔已卖`}</span>}>
          <div className="grid grid-cols-2 sm:grid-cols-4">
            <Stat
              label="上涨占比"
              value={scored.length === 0 ? "—" : `${((wins / scored.length) * 100).toFixed(2)}%`}
              className="border-r border-line"
            />
            <Stat
              label="累计收益"
              value={scored.length === 0 ? "—" : signedPct(cum * 100)}
              tone={toneClass(scored.length ? cum * 100 : null)}
              className="border-r border-line"
            />
            <Stat
              label="最近 20 笔均值"
              value={recent == null ? "—" : signedPct(recent * 100)}
              className="border-r border-line"
            />
            <Stat
              label="沪深300"
              value={indexCum == null ? "—" : signedPct(indexCum * 100)}
              tone={toneClass(indexCum == null ? null : indexCum * 100)}
            />
          </div>
          <p className="border-t border-line px-3 py-2 text-xs leading-relaxed text-muted">
            卖出看目标价，不看 60 天。{gate.reason}。累计收益是每笔扣费后收益相加。
            不满 {TRACK_NEED} 个交易日时，上涨占比还只是样本。
          </p>
        </Panel>

        <p className="px-1 text-xs leading-relaxed text-muted">
          金额是名义金额：这套模拟盘不记仓位大小、每笔按满仓记，所以这里按每笔一手（100 股）折算，不是投入的钱。
          收益率已扣佣金和印花税，汇总是每笔收益率相加，不是按金额加权。
        </p>
      </div>
    </Frame>
  );
}
