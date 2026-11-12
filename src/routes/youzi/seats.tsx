/**
 * 席位档案（/seats）——龙虎榜营业部的历史账：谁买得多、跟买之后赚不赚。
 *
 * 为什么值得单独一页：赤轨唯一站得住的 edge 就是「龙虎榜反向信号」（游资驱动，
 * 机构净买单独不反向）。但原来只有信号，没有档案——你没法回答「这个席位以前
 * 上过榜的票后来怎么样了」。这一页就是把 360 天的席位记录摊开。
 *
 * 口径（页面上原文印）：
 *   席位某日净买入某股 → **次日开盘买入**（当天收盘后才知道席位，不能按当天价买）
 *   → 持有 5 个交易日收盘卖出。
 *   名字对不上代码的直接跳过，页面显示跳过了多少笔，不猜。
 *
 * 已知缺陷（不藏）：席位名是采集时压过的简称，会丢前缀（「北证券宁波江安路」
 * 实际是东北证券）。历史数据无法复原，所以按名字精确分组、不做合并、不猜全称。
 */

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { SectionTabs, YOUZI_TABS } from "@/components/section-tabs";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getSeats } from "@/lib/market/archive.functions";
import { PixelHeader } from "@/components/pixel-header";

export const Route = createFileRoute("/youzi/seats")({
  loader: async () => await getSeats(),
  component: SeatsPage,
});

const pct = (v: number | null, d = 2) => (v == null ? "—" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);
const yi = (wan: number) => (Math.abs(wan) >= 10000 ? `${(wan / 10000).toFixed(2)}亿` : `${wan.toFixed(0)}万`);

function SeatsPage() {
  const data = Route.useLoaderData();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);

  if (!data) {
    return (
      <Frame wide>
        <SectionTabs ariaLabel="游资与席位" tabs={YOUZI_TABS} />
        <PixelHeader label="HOTMONEY // SEATS" meta="席位历史 · 样本 ≥20 笔才给结论" />
        <Panel title="席位档案">
          <StateBlock kind="empty" title="还没建档案" hint="先跑 scripts/record-hotmoney.ts 采当天，再跑 scripts/seats-build.ts 聚合。" />
        </Panel>
      </Frame>
    );
  }

  const kw = q.trim();
  const seats = kw ? data.seats.filter((s) => s.name.includes(kw)) : data.seats;
  const active = data.seats.filter((s) => s.n5 >= 20);
  const ranked = [...active].sort((a, b) => (b.avg5 ?? -9) - (a.avg5 ?? -9));
  const today = data.latest;

  return (
    <Frame
      wide
      aside={
        <span className="num text-xs text-muted">
          {data.sourceFirst} → {data.sourceLast} · {data.sourceDays} 天 · {data.seats.length} 个席位
        </span>
      }
    >
      <SectionTabs ariaLabel="游资与席位" tabs={YOUZI_TABS} />
      <PixelHeader label="HOTMONEY // SEATS" meta="席位历史 · 样本 ≥20 笔才给结论" />
      <div className="flex flex-col gap-3">
        <Panel title="今日席位" note={today ? <span className="text-[12px]">{today.date} · {today.seats.length} 个席位上榜</span> : undefined}>
          {!today || today.seats.length === 0 ? (
            <StateBlock kind="empty" title="今天还没采到席位" hint="龙虎榜盘后才公布，采集挂在收盘流程里。没有就是没有，不补旧值。" />
          ) : (
            <div className="grid gap-px overflow-hidden border-t border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
              {today.seats
                .slice()
                .sort((a, b) => b.netWan - a.netWan)
                .map((s) => (
                  <div key={s.name} className="bg-surface px-3 py-2">
                    <div className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-sm font-medium">{s.name}</span>
                      <span className={"num shrink-0 text-sm " + (s.netWan >= 0 ? "text-up" : "text-down")}>
                        {yi(s.netWan)}
                      </span>
                    </div>
                    <div className="mt-0.5 truncate text-[12px] text-muted">
                      {s.stocks.slice(0, 4).map((x) => `${x.name} ${x.netWan >= 0 ? "+" : ""}${(x.netWan / 10000).toFixed(2)}亿`).join(" · ")}
                    </div>
                  </div>
                ))}
            </div>
          )}
        </Panel>

        <Panel
          title="跟买战绩"
          note={<span className="text-[12px]">≥20 笔可结算才进榜 · 按 {data.hold} 日平均收益排</span>}
        >
          <div className="overflow-x-auto px-3 py-2 scroll-slim">
            <table className="data-table w-full min-w-[640px] text-xs">
              <thead>
                <tr>
                  <th className="w-8 text-right">#</th>
                  <th className="text-left">席位</th>
                  <th className="text-right">笔数</th>
                  <th className="text-right">次日均</th>
                  <th className="text-right">{data.hold} 日均</th>
                  <th className="text-right">{data.hold} 日胜率</th>
                  <th className="text-right">累计净额</th>
                </tr>
              </thead>
              <tbody>
                {ranked.slice(0, 40).concat(ranked.slice(-10)).map((s, i) => (
                  <tr key={s.name}>
                    <td className="num text-right text-muted">{i < 40 ? i + 1 : "…"}</td>
                    <td className="max-w-[220px] truncate">{s.name}</td>
                    <td className="num text-right text-muted">{s.n5}</td>
                    <td className={"num text-right " + ((s.avg1 ?? 0) >= 0 ? "text-up" : "text-down")}>{pct(s.avg1)}</td>
                    <td className={"num text-right font-medium " + ((s.avg5 ?? 0) >= 0 ? "text-up" : "text-down")}>{pct(s.avg5)}</td>
                    <td className="num text-right text-muted">{s.win5 == null ? "—" : `${(s.win5 * 100).toFixed(0)}%`}</td>
                    <td className={"num text-right " + (s.netWan >= 0 ? "text-up" : "text-down")}>{yi(s.netWan)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
            榜尾那 10 个是同一批里最差的（表里用「…」隔开），不是另一份名单。
            「次日均」= 次日开盘买入、当日收盘卖出；「{data.hold} 日均」= 持有 {data.hold} 个交易日。
            两个都是**次日开盘价**成交，因为席位是收盘后才公布的。
          </div>
        </Panel>

        <Panel
          title="席位明细"
          note={
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜席位名（营业部简称）"
              className="w-52 rounded border border-line bg-surface px-2 py-1 text-[12px]"
            />
          }
        >
          {seats.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-muted">没有匹配的席位。</div>
          ) : (
            <div className="max-h-[600px] overflow-y-auto scroll-slim">
              {seats.slice(0, 60).map((s) => (
                <div key={s.name} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setOpen(open === s.name ? null : s.name)}
                    className="flex w-full items-baseline justify-between gap-2 px-3 py-1.5 text-left text-xs hover:bg-surface-2"
                  >
                    <span className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate">{s.name}</span>
                      <span className="num shrink-0 text-[12px] text-muted">{s.days} 天上榜 · 买 {s.buys} 笔</span>
                    </span>
                    <span className="flex shrink-0 items-baseline gap-3">
                      <span className="num text-[12px] text-muted">{data.hold}日 {pct(s.avg5)}</span>
                      <span className={"num text-[12px] " + (s.netWan >= 0 ? "text-up" : "text-down")}>{yi(s.netWan)}</span>
                    </span>
                  </button>
                  {open === s.name ? (
                    <div className="bg-surface-2 px-3 py-2">
                      {s.recs.length === 0 ? (
                        <div className="text-[12px] text-muted">这个席位的买入记录都没对上代码，明细为空。</div>
                      ) : (
                        <table className="w-full text-[12px]">
                          <thead>
                            <tr className="text-muted">
                              <th className="text-left font-normal">日期</th>
                              <th className="text-left font-normal">个股</th>
                              <th className="text-right font-normal">净买</th>
                              <th className="text-right font-normal">次日</th>
                              <th className="text-right font-normal">{data.hold} 日</th>
                            </tr>
                          </thead>
                          <tbody>
                            {s.recs.map((r) => (
                              <tr key={`${r.date}-${r.stock}-${r.netWan}`}>
                                <td className="num text-muted">{r.date}</td>
                                <td className="max-w-[120px] truncate">{r.stock}</td>
                                <td className="num text-right text-muted">{yi(r.netWan)}</td>
                                <td className={"num text-right " + ((r.r1 ?? 0) >= 0 ? "text-up" : "text-down")}>{pct(r.r1)}</td>
                                <td className={"num text-right " + ((r.r5 ?? 0) >= 0 ? "text-up" : "text-down")}>{pct(r.r5)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      )}
                    </div>
                  ) : null}
                </div>
              ))}
              {seats.length > 60 ? (
                <div className="px-3 py-2 text-[12px] text-muted">只显示前 60 个，用搜索缩小范围。</div>
              ) : null}
            </div>
          )}
        </Panel>

        <Panel title="这一页的缺陷（先说清楚）">
          <div className="flex flex-col gap-1.5 px-3 py-3 text-[12px] leading-relaxed text-muted">
            <div>
              <Tag tone="warn">缺陷</Tag>{" "}
              <b className="text-fg">席位名被截断过。</b>采集时压成简称，会丢前缀——「北证券宁波江安路」
              实际是东北证券宁波江安路。历史数据无法复原，所以这一页按名字精确分组，
              不合并、不猜全称。要看全称去 /hotmoney 的当天原始榜。
            </div>
            <div>
              <Tag tone="muted">缺口</Tag>{" "}
              有 <b className="num text-fg">{data.unresolved}</b> 笔买入的名字对不上代码（改名、退市、
              一个字的差异），这些笔**不计入战绩**，同时也不假装它们不存在。
            </div>
            <div>
              <Tag tone="muted">口径</Tag>{" "}
              「{data.hold} 日均」是跟买平均，不是胜率保证；{data.hold} 天里大盘本身涨跌会淹没席位的能力，
              所以这页只给相对高低，不当买入信号。
            </div>
          </div>
        </Panel>
      </div>
    </Frame>
  );
}
