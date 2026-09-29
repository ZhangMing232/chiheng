import { useEffect, useState } from "react";
import { fmtPrice, signedPct, toneClass } from "@/lib/market/format";
import { BOARD_LABEL, TRACK_NEED } from "@/lib/market/model";
import { dayLocked, liveGate, lotShares, netReturn, stopPrice, yuan } from "@/lib/market/journal-book";
import { useAccount } from "@/lib/account";
import { usePlan } from "@/lib/plan";
import type { EarlyRules } from "@/lib/market/rules";
import type { Quote } from "@/lib/market/types";
import { usePaper, type PaperDay } from "@/lib/paper";

type Pick = { quote: Quote; reasons: string[] };

function dayLabel(date: string): string {
  const match = date.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return date;
  return `${Number(match[2])}月${Number(match[3])}日`;
}

export function Picks({
  date,
  picks,
  quotes,
  serverDays,
  rules,
  benchmark,
  onOpen,
}: {
  date: string;
  picks: Pick[];
  quotes: Quote[];
  serverDays: PaperDay[];
  rules: EarlyRules;
  benchmark: { name: string; price: number; pct: number } | null;
  onOpen: (id: string) => void;
}) {
  const browserDays = usePaper((state) => state.days);
  const days = serverDays.length > 0 ? serverDays : browserDays;
  const onServer = serverDays.length > 0;
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let cancel = false;
    void (async () => {
      await usePaper.persist.rehydrate();
      await useAccount.persist.rehydrate();
      await usePlan.persist.rehydrate();
      if (!cancel) setReady(true);
    })();
    return () => {
      cancel = true;
    };
  }, []);

  const byId = new Map(quotes.map((quote) => [quote.id, quote]));
  const open = days.flatMap((day) =>
    day.trades
      .filter((trade) => trade.exit == null)
      .map((trade) => {
        const live = byId.get(trade.id);
        const ret = live && trade.entry > 0 ? netReturn(trade.entry, live.price) : null;
        return { ...trade, day: day.date, signalTime: day.signalTime ?? "", live, ret };
      }),
  );
  const closed = days.flatMap((day) =>
    day.trades
      .filter((trade) => trade.exit != null && trade.entry > 0)
      .map((trade) => ({
        ...trade,
        day: day.date,
        signalTime: day.signalTime ?? "",
        ruleVersion: day.ruleVersion ?? 1,
        ret: netReturn(trade.entry, trade.exit!),
        indexRet: day.indexEntry && day.indexExit ? day.indexExit / day.indexEntry - 1 : null,
      })),
  );
  const wins = closed.filter((trade) => trade.ret != null && trade.ret > 0).length;
  const capital = useAccount((state) => state.capital);
  const slotPct = useAccount((state) => state.slotPct);
  const setCapital = useAccount((state) => state.setCapital);
  const setSlotPct = useAccount((state) => state.setSlotPct);
  const maxLoss = usePlan((state) => state.maxLoss);
  const stopPct = maxLoss > 0 ? maxLoss : 8;
  const budget = capital * (slotPct / 100);
  const closedYuan = closed.reduce((sum, trade) => {
    if (trade.ret == null) return sum;
    return sum + lotShares(budget, trade.entry) * trade.entry * trade.ret;
  }, 0);
  const openYuan = open.reduce((sum, trade) => {
    if (trade.ret == null) return sum;
    return sum + lotShares(budget, trade.entry) * trade.entry * trade.ret;
  }, 0);
  const excesses = closed.filter((trade) => trade.ret != null && trade.indexRet != null);
  const excess = excesses.length === 0 ? null : excesses.reduce((sum, trade) => sum + (trade.ret! - trade.indexRet!), 0) / excesses.length;
  const counted = closed.filter((trade) => trade.ruleVersion === rules.version);
  const countedDays = days.filter((day) => (day.ruleVersion ?? 1) === rules.version).length;
  const gate = liveGate(countedDays, counted, rules);
  const featured = picks.slice(0, 3);
  const lockedToday = days.find((day) => day.date === date && dayLocked(day));

  return (
    <div className="mb-4 flex flex-col gap-3">
      <section className="rounded-lg border border-line bg-surface px-4 py-3 text-sm">
        <h2 className="text-base font-semibold">资金</h2>
        <p className={"mt-1 font-medium " + (gate.ok ? "" : "text-up")}>{gate.ok ? "真钱：可以按小仓位做" : "真钱：不允许"}</p>
        <p className="mt-1 text-pretty text-muted">
          {gate.reason}。筛选条件改了之后，只统计第 {rules.version} 版。{gate.ok ? "个股仍按单只仓位，最多 3 只。" : "开关关上时，真钱不买下面的个股，只买沪深300ETF（510300）。指数也会跌。"}
        </p>
        {benchmark ? (
          <div className="mt-3 flex items-baseline justify-between gap-3 rounded-md border border-line px-3 py-2">
            <div>
              <div className="font-medium">{benchmark.name}</div>
              <div className="text-xs text-muted">{gate.ok ? "对照基准" : "现在唯一的真钱标的 · 510300"}</div>
            </div>
            <div className="text-right">
              <div className="text-lg font-semibold tabular-nums">{fmtPrice(benchmark.price)}</div>
              <div className={toneClass(benchmark.pct) + " text-xs tabular-nums"}>{signedPct(benchmark.pct)}</div>
            </div>
          </div>
        ) : null}
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <label>
            <span className="mb-1 block text-xs text-muted">本金（元）</span>
            <input
              className="h-11 w-full rounded-md border border-line bg-bg px-3"
              inputMode="numeric"
              value={capital || ""}
              onChange={(event) => setCapital(Number(event.target.value))}
            />
          </label>
          <label>
            <span className="mb-1 block text-xs text-muted">单只仓位（%，最多 20）</span>
            <input
              className="h-11 w-full rounded-md border border-line bg-bg px-3"
              inputMode="decimal"
              value={slotPct || ""}
              onChange={(event) => setSlotPct(Number(event.target.value))}
            />
          </label>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div>
            <div className="text-xs text-muted">{gate.ok ? "单只金额" : "510300 可买"}</div>
            <div className="font-medium tabular-nums">
              {gate.ok ? yuan(budget) : benchmark ? `${lotShares(capital, benchmark.price)} 股` : "—"}
            </div>
          </div>
          <div>
            <div className="text-xs text-muted">已结算盈亏</div>
            <div className={"font-medium tabular-nums " + toneClass(closedYuan)}>{closed.length ? yuan(closedYuan) : "—"}</div>
          </div>
          <div>
            <div className="text-xs text-muted">未结算浮盈</div>
            <div className={"font-medium tabular-nums " + toneClass(openYuan)}>{open.length ? yuan(openYuan) : "—"}</div>
          </div>
        </div>
        <p className="mt-2 text-xs text-muted">
          已结算相对沪深 300：{excess == null ? "还没有能比的闭环" : signedPct(excess * 100)}。止损提醒按 {stopPct}%
          {maxLoss > 0 ? "" : "，纪律还没写，先用 8%"}。
        </p>
      </section>
      <section className="rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-fg px-2 py-1 text-xs text-bg">{dayLabel(date)}</span>
            <h2 className="truncate text-base font-semibold">{gate.ok ? `精选 ${featured.length} 只` : "纸面观察"}</h2>
          </div>
          <span className="shrink-0 text-xs text-muted">{lockedToday ? "买入价已锁定" : "尚未锁定"}</span>
        </div>
        {lockedToday ? (
          lockedToday.trades.length === 0 ? (
            <p className="border-t border-line px-4 py-6 text-sm text-muted">今天已经锁定，一只都没有，记为空仓。</p>
          ) : (
            <ul>
              {lockedToday.trades.slice(0, 3).map((trade) => {
                const live = byId.get(trade.id);
                const chased = live != null && live.price > trade.entry;
                return (
                  <li key={trade.id} className="border-t border-line">
                    <button type="button" onClick={() => onOpen(trade.id)} className="block w-full px-4 py-3 text-left">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="truncate text-base font-semibold">{trade.name}</div>
                          <div className="mt-1 text-xs text-muted">{trade.code}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-muted">{gate.ok ? "参考买入价" : "纸面价，不能买"}</div>
                          <div className="font-medium tabular-nums">{gate.ok ? `低于 ${fmtPrice(trade.entry)}` : fmtPrice(trade.entry)}</div>
                        </div>
                        <div className="text-right">
                          <div className="text-xs text-muted">现价</div>
                          <div className="text-lg font-semibold tabular-nums">{live ? fmtPrice(live.price) : "—"}</div>
                        </div>
                      </div>
                      {chased ? <p className="mt-2 text-sm">现价已高于参考价，不要追。</p> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : featured.length === 0 ? (
          <p className="border-t border-line px-4 py-6 text-sm text-muted">
            成交额要到全天 5000 万才入选，上午经常还没有。尾盘 14:40 以后才锁定买入价。
          </p>
        ) : (
          <ul>
            {featured.map((pick) => (
              <li key={pick.quote.id} className="border-t border-line">
                <button type="button" onClick={() => onOpen(pick.quote.id)} className="block w-full px-4 py-3 text-left">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div className="min-w-0">
                      <div className="truncate text-base font-semibold">
                        {pick.quote.name}
                        <span className="ml-2 rounded border border-line px-1.5 py-0.5 text-xs font-normal text-muted">
                          {BOARD_LABEL[pick.quote.board]}
                        </span>
                      </div>
                      <div className="mt-1 text-xs text-muted">{pick.quote.code}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted">{gate.ok ? "参考买入价" : "纸面价，不能买"}</div>
                      <div className="font-medium tabular-nums">{gate.ok ? `低于 ${fmtPrice(pick.quote.price)}` : fmtPrice(pick.quote.price)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted">现价</div>
                      <div className="text-lg font-semibold tabular-nums">{fmtPrice(pick.quote.price)}</div>
                    </div>
                  </div>
                  {pick.reasons[0] ? <p className="mt-2 text-sm text-pretty text-muted">{pick.reasons.join("。")} 价格还没锁定。</p> : null}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-line bg-surface">
        <div className="px-4 py-3">
          <h2 className="text-base font-semibold">等待卖出信号的股票池 共 {open.length} 只</h2>
          <p className="mt-1 text-sm text-muted">记下买入信号之后先持有，满 5 到 10 个交易日再结算。现价高于参考价就不要追。</p>
        </div>
        {open.length === 0 ? (
          <p className="border-t border-line px-4 py-6 text-sm text-muted">
            {ready && !onServer ? "还没有锁定的持仓。尾盘 14:40 以后才会写下买入价。" : onServer ? "服务器还没有锁定今天的名单。电脑开着时，尾盘或收盘后写入 data/journal.json。" : "正在读取本机记录。"}
          </p>
        ) : (
          <ul>
            {open.map((trade) => (
              <li key={`${trade.day}-${trade.id}`} className="border-t border-line px-4 py-3">
                <button type="button" onClick={() => onOpen(trade.id)} className="block w-full text-left">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="font-semibold">
                        {trade.name} <span className="font-normal text-muted">({trade.code})</span>
                      </div>
                      <div className="mt-2 text-xs text-muted">
                        买入信号 {trade.day.slice(5)} {trade.signalTime} · 参考价 {fmtPrice(trade.entry)} ·{" "}
                        {lotShares(budget, trade.entry)} 股 · 止损 {fmtPrice(stopPrice(trade.entry, stopPct) ?? 0)}
                      </div>
                    </div>
                    <div className="text-right">
                      <div className={toneClass(trade.ret == null ? null : trade.ret * 100) + " text-lg font-semibold tabular-nums"}>
                        {trade.ret == null ? "—" : signedPct(trade.ret * 100)}
                      </div>
                      <div className="text-xs text-muted">调入以来</div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-line bg-surface">
        <div className="flex items-baseline justify-between gap-3 px-4 py-3">
          <h2 className="text-base font-semibold">历史信号</h2>
          <span className="text-xs text-muted">
            {days.length}/{TRACK_NEED} 个交易日
          </span>
        </div>
        <div className="grid grid-cols-2 gap-3 border-t border-line px-4 py-3">
          <div>
            <div className="text-2xl font-semibold tabular-nums">
              {closed.length === 0 ? "—" : `${wins}/${closed.length}`}
            </div>
            <div className="text-xs text-muted">闭环上涨数 / 闭环总数</div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-semibold tabular-nums">
              {closed.length === 0 ? "—" : `${((wins / closed.length) * 100).toFixed(1)}%`}
            </div>
            <div className="text-xs text-muted">闭环上涨占比</div>
          </div>
        </div>
        <p className="px-4 pb-3 text-xs text-pretty text-muted">
          {days.length < TRACK_NEED
            ? `未满 ${TRACK_NEED} 个交易日，上面的数字不能当成胜率。闭环已扣约 0.15% 费用。默认仍然空仓。`
            : "闭环已扣约 0.15% 费用。这是这套冻住规则自己的记录，不是买卖指令。"}
        </p>
        {closed.length === 0 && open.length === 0 ? null : (
          <div className="overflow-x-auto border-t border-line">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted">
                <tr className="border-b border-line">
                  <th className="px-4 py-2 font-medium">名称</th>
                  <th className="px-3 py-2 font-medium">买入</th>
                  <th className="px-3 py-2 font-medium">卖出</th>
                  <th className="px-4 py-2 text-right font-medium">闭环</th>
                </tr>
              </thead>
              <tbody>
                {open.slice(0, 8).map((trade) => (
                  <tr key={`h-${trade.day}-${trade.id}`} className="border-b border-line">
                    <td className="px-4 py-3">
                      <div className="font-medium">{trade.name}</div>
                      <div className="text-xs text-muted">{trade.code}</div>
                    </td>
                    <td className="px-3 py-3 tabular-nums">
                      <div>{fmtPrice(trade.entry)}</div>
                      <div className="text-xs text-muted">
                        {trade.day.slice(5)} {trade.signalTime}
                      </div>
                    </td>
                    <td className="px-3 py-3 text-muted">持有中</td>
                    <td className="px-4 py-3 text-right text-muted">—</td>
                  </tr>
                ))}
                {closed.slice(0, 8).map((trade) => (
                  <tr key={`c-${trade.day}-${trade.id}`} className="border-b border-line last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium">{trade.name}</div>
                      <div className="text-xs text-muted">{trade.code}</div>
                    </td>
                    <td className="px-3 py-3 tabular-nums">
                      <div>{fmtPrice(trade.entry)}</div>
                      <div className="text-xs text-muted">
                        {trade.day.slice(5)} {trade.signalTime}
                      </div>
                    </td>
                    <td className="px-3 py-3 tabular-nums">
                      <div>{fmtPrice(trade.exit!)}</div>
                      <div className="text-xs text-muted">{trade.exitDate?.slice(5)}</div>
                    </td>
                    <td className={"px-4 py-3 text-right tabular-nums " + toneClass(trade.ret == null ? null : trade.ret * 100)}>
                      {trade.ret == null ? "—" : signedPct(trade.ret * 100)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
