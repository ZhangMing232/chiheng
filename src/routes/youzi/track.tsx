/**
 * 这个文件是干什么的：
 * 「游资追踪」页——把当日龙虎榜席位按游资名号聚合，看游资在买什么、卖什么。
 * （对标连板网 /youzi.html，但砍掉 SVIP 检索，只保留核心聚合视图）
 *
 * 数据源：东财龙虎榜（RPT_BILLBOARD_DAILYDETAILSBUY/SELL），getHotMoney 服务函数
 * 现拉并缓存，labelOf 把营业部席位映射到公认游资名号（章盟主/赵老哥/方新侠/炒股养家…）。
 *
 * 纪律：
 * 1. 席位≠游资本人（营业部是席位，名号是市场惯称）；历史行为不预示未来。
 * 2. 净买入/卖出是事实，不是买卖建议。
 *
 * 2026-11-12 合并：原 /flow/hot「游资」子页读的是同一个 getHotMoney()、同一批席位，
 * 只是画成一行一个席位的列表——用户指出「和游资与席位又重复了」，已删。
 * 那一页独有的两样并到这里，功能不丢：
 *   - 每只成分股的**净买/净卖金额**（原来这边只有股票名）；
 *   - 生成汇总图的 PosterButton（drawHotPoster 原来只在那一页挂着）。
 * 机构和拉萨排最后、席位别名映射都在 hotmoney.ts 里，两页本来就共用，不用搬。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { SectionTabs, YOUZI_TABS } from "@/components/section-tabs";
import { Panel, Tag } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getHotMoney } from "@/lib/market/quotes.functions";
import { PosterButton } from "@/components/screener/poster-button";
import { drawHotPoster } from "@/lib/market/extra-posters";
import { fmtWan, toneClass } from "@/lib/market/format";
import { useStockDetail } from "@/components/stock-detail-modal";

export const Route = createFileRoute("/youzi/track")({
  loader: () => getHotMoney().catch(() => ({ date: "", seats: [] })),
  component: HotMoneyPage,
});

const TOP_TIER = new Set(["章盟主", "赵老哥", "方新侠", "炒股养家", "孙哥"]);
const FIRST_TIER = new Set(["宁波桑田路", "华泰荣超", "温州帮", "华泰总部", "拉萨天团", "机构"]);

function tierOf(name: string): { label: string; tone: "warn" | "up" | "muted" } {
  if (TOP_TIER.has(name)) return { label: "顶级", tone: "warn" };
  if (FIRST_TIER.has(name)) return { label: "一线", tone: "up" };
  return { label: "知名", tone: "muted" };
}

function HotMoneyPage() {
  const { date, seats } = Route.useLoaderData();
  const { openDetail, modal } = useStockDetail();
  const buyers = seats.filter((s) => s.netWan > 0).slice(0, 12);
  const sellers = seats.filter((s) => s.netWan < 0).slice(0, 6);

  return (
    <>
    <Frame wide>
      <SectionTabs ariaLabel="游资与席位" tabs={YOUZI_TABS} />
      <PosterButton draw={() => drawHotPoster({ date, seats })} />
      <div className="flex flex-col gap-3">
        <Panel title="席位净买卖" note={date ? `${date} 龙虎榜 · 席位按游资名号聚合` : "龙虎榜还没出"}>
          {seats.length === 0 ? (
            <StateBlock kind="empty" title="今天还没龙虎榜" hint="东财龙虎榜收盘后 ~17:00 才更新，盘中/早盘是空的。" />
          ) : (
            <div className="grid gap-3 lg:grid-cols-2">
              <div>
                <div className="px-3 pt-2 text-xs text-muted">净买入（游资在买什么）</div>
                <div className="flex flex-col gap-1 p-2">
                  {buyers.map((s) => {
                    const t = tierOf(s.name);
                    return (
                      <div key={s.name} className="rounded border border-line bg-surface px-2.5 py-1.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="flex items-baseline gap-1.5 text-sm">
                            <span className="truncate font-medium">{s.name}</span>
                            <Tag tone={t.tone}>{t.label}</Tag>
                          </span>
                          <span className="num shrink-0 text-xs text-up">+{(s.netWan / 10000).toFixed(2)}亿</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {s.stocks.slice(0, 6).map((st) => (
                            <button key={st.name} type="button" onClick={() => void openDetail("", st.name)} className={`num rounded bg-surface2 px-1 py-px text-[11px] hover:underline ${toneClass(st.netWan)}`}>
                              {st.name} {st.netWan > 0 ? "净买" : "净卖"}{fmtWan(Math.abs(st.netWan))}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div>
                <div className="px-3 pt-2 text-xs text-muted">净卖出（游资在抛什么）</div>
                <div className="flex flex-col gap-1 p-2">
                  {sellers.map((s) => {
                    const t = tierOf(s.name);
                    return (
                      <div key={s.name} className="rounded border border-line bg-surface px-2.5 py-1.5">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="flex items-baseline gap-1.5 text-sm">
                            <span className="truncate font-medium">{s.name}</span>
                            <Tag tone={t.tone}>{t.label}</Tag>
                          </span>
                          <span className="num shrink-0 text-xs text-down">{(s.netWan / 10000).toFixed(2)}亿</span>
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {s.stocks.slice(0, 6).map((st) => (
                            <button key={st.name} type="button" onClick={() => void openDetail("", st.name)} className={`num rounded bg-surface2 px-1 py-px text-[11px] hover:underline ${toneClass(st.netWan)}`}>
                              {st.name} {st.netWan > 0 ? "净买" : "净卖"}{fmtWan(Math.abs(st.netWan))}
                            </button>
                          ))}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
          <div className="border-t border-line px-3 py-2 text-[11px] leading-relaxed text-muted">
            席位≠游资本人：营业部是席位、名号是市场惯称，同一席位可能有多个资金方。净买入/卖出是事实，不构成买卖建议。分级：顶级（章盟主/赵老哥/方新侠/炒股养家/孙哥）＞一线（桑田路/荣超/拉萨天团/机构）＞知名（其余）。
          </div>
        </Panel>
      </div>
    </Frame>
    {modal}
    </>
  );
}
