import { useEffect, useState } from "react";
import { fmtPrice, signedPct, toneClass } from "@/lib/market/format";
import { BOARD_LABEL, TRACK_NEED } from "@/lib/market/model";
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
  onOpen,
}: {
  date: string;
  picks: Pick[];
  quotes: Quote[];
  serverDays: PaperDay[];
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
        const ret = live && trade.entry > 0 ? live.price / trade.entry - 1 : null;
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
        ret: trade.exit! / trade.entry - 1,
      })),
  );
  const wins = closed.filter((trade) => trade.ret > 0).length;
  const featured = picks.slice(0, 3);

  return (
    <div className="mb-4 flex flex-col gap-3">
      <section className="rounded-lg border border-line bg-surface">
        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 rounded bg-fg px-2 py-1 text-xs text-bg">{dayLabel(date)}</span>
            <h2 className="truncate text-base font-semibold">精选 {featured.length} 只</h2>
          </div>
          <span className="shrink-0 text-xs text-muted">观察，不是下单</span>
        </div>
        {featured.length === 0 ? (
          <p className="border-t border-line px-4 py-6 text-sm text-muted">此刻没有刚启动、又还没走远的股票。</p>
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
                      <div className="text-xs text-muted">参考买入价</div>
                      <div className="font-medium tabular-nums">低于 {fmtPrice(pick.quote.price)}</div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-muted">现价</div>
                      <div className="text-lg font-semibold tabular-nums">{fmtPrice(pick.quote.price)}</div>
                    </div>
                  </div>
                  {pick.reasons[0] ? <p className="mt-2 text-sm text-pretty text-muted">{pick.reasons.join("。")}</p> : null}
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
            {ready && !onServer ? "还没有记下的持仓。早盘 9:25–9:30 或尾盘 14:40 以后打开这一页，才会写入信号。" : onServer ? "服务器还没有记下持仓。电脑开着时，到点会自动写入 data/journal.json。" : "正在读取本机记录。"}
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
                        买入信号 {trade.day.slice(5)} {trade.signalTime} · 参考价 {fmtPrice(trade.entry)}
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
            ? `未满 ${TRACK_NEED} 个交易日，上面的数字不能当成胜率。默认仍然空仓。`
            : "这是这套冻住规则自己的记录，不是买卖指令。"}
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
                    <td className={"px-4 py-3 text-right tabular-nums " + toneClass(trade.ret * 100)}>{signedPct(trade.ret * 100)}</td>
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
