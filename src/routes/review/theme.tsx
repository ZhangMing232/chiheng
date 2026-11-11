/**
 * 这个文件是干什么的：
 * 「题材」页——今天什么概念/板块在烧，一张榜说清，附「明日观察」延续性标注。
 *
 * 数据：theme-heat.ts 每天 15:10 生成 data/theme-heat.json（东财概念板 × 当日行情，
 * 每题材的涨停家数/均涨幅/龙头）。本页只渲染，不自己算。
 *
 * 你需要知道的（纪律，全写在这里）：
 * 1. **这一页是「看懂今天」，不是「预测明天」的承诺**。明日观察是诚实的延续性
 *    标注：涨停梯队健康 + 均涨幅不过热 → 有延续支撑；均涨幅过热 → 追高风险。
 *    项目数据已证伪「追高连板」（板越高次日越亏，t=-10.2），所以观察不是信号。
 * 2. 龙头 = 板内涨幅最高的**非涨停**股（涨停的是花，龙头看谁在领跑梯队）。
 * 3. 均涨幅是题材内所有票的等权平均，大题材（机器人 700+ 只）会被摊薄，看涨停数更可靠。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { SectionTabs, REVIEW_TABS } from "@/components/section-tabs";
import { Panel, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getThemeHeat, type ThemeHeatItem } from "@/lib/market/quotes.functions";
import { toneClass } from "@/lib/market/format";

export const Route = createFileRoute("/review/theme")({
  loader: () => getThemeHeat().catch(() => ({ date: "", hot: [] as ThemeHeatItem[] })),
  component: ThemePage,
});

/**
 * 明日观察（诚实标注，非预测）：
 * - 梯队健康：涨停 ≥ 10 且均涨幅 3%~6%——参与面广、没过热，有延续支撑。
 * - 情绪过热：均涨幅 ≥ 7%——情绪打满，追高风险。
 * - 梯队分散：涨停 < 3——只有零星涨停，不成势。
 * - 中性：其余。
 */
function continuationOf(r: ThemeHeatItem): { label: string; tone: "up" | "down" | "warn" | "muted" } {
  if (r.avg >= 7) return { label: "情绪过热 · 追高风险", tone: "warn" };
  if (r.limitUp >= 10 && r.avg >= 3) return { label: "梯队健康 · 可观察延续", tone: "up" };
  if (r.limitUp < 3) return { label: "梯队分散", tone: "muted" };
  return { label: "中性", tone: "muted" };
}

function ThemePage() {
  const { date, hot } = Route.useLoaderData();
  const tabs = <SectionTabs ariaLabel="复盘" tabs={REVIEW_TABS} />;

  return (
    <Frame wide aside="题材">
      {tabs}
      <Panel
        title="题材热度榜"
        note={
          <span>
            {date ? `${date} 收盘后 · ` : ""}东财概念板 × 当日行情 · 只报事实，观察不是买入信号
          </span>
        }
      >
        {hot.length === 0 ? (
          <StateBlock kind="empty" title="今天还没生成" hint="theme-heat.ts 每天 15:10 跑，收盘后才有。盘中看不到是正常的。" />
        ) : (
          <div className="overflow-hidden rounded border border-line">
            <table className="w-full text-xs">
              <thead className="bg-surface2 text-left text-muted">
                <tr>
                  <th className={thClass()}>题材</th>
                  <th className={thClass("text-right")}>涨停</th>
                  <th className={thClass("text-right")}>均涨幅</th>
                  <th className={thClass("text-right")}>涨/跌</th>
                  <th className={thClass()}>龙头</th>
                  <th className={thClass()}>明日观察</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {hot.map((r) => {
                  const c = continuationOf(r);
                  return (
                    <tr key={r.name} className="hover:bg-surface2/50">
                      <td className={tdClass("font-medium")}>{r.name}</td>
                      <td className={tdClass("text-right tabular-nums")}>
                        <span className={r.limitUp >= 10 ? "font-medium text-up" : ""}>{r.limitUp}</span>
                      </td>
                      <td className={`${tdClass("text-right tabular-nums font-medium")} ${toneClass(r.avg)}`}>
                        {r.avg > 0 ? "+" : ""}{r.avg.toFixed(1)}%
                      </td>
                      <td className={tdClass("text-right tabular-nums text-muted")}>
                        {r.up}<span className="text-line">/</span>{r.down}
                      </td>
                      <td className={tdClass()}>
                        {r.leader ? (
                          <span>
                            {r.leader.name}
                            <span className={`ml-1 tabular-nums ${toneClass(r.leader.chg)}`}>
                              {r.leader.chg > 0 ? "+" : ""}{r.leader.chg.toFixed(1)}%
                            </span>
                          </span>
                        ) : "—"}
                      </td>
                      <td className={tdClass()}>
                        <Tag
                          tone={
                            c.tone === "up" ? "up" : c.tone === "warn" ? "warn" : "muted"
                          }
                        >
                          {c.label}
                        </Tag>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="px-1 pt-3 text-[11px] leading-relaxed text-muted">
          明日观察是诚实的延续性标注，不是预测：涨停梯队健康、均涨幅不过热才谈得上延续；
          情绪过热（均涨幅 ≥7%）是追高不是机会——连板越高次日越亏（t=-10.2），这是项目用数据验过的。
          完整口径见 data/theme-heat.json。
        </p>
      </Panel>
    </Frame>
  );
}
