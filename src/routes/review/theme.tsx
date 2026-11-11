/**
 * 这个文件是干什么的：
 * 「题材」页——今天什么概念/板块在烧，一张榜说清，附「明日观察」延续性标注。
 *
 * 数据：theme-heat.ts 每天 15:10 生成 data/theme-heat.json（东财概念板 × 当日行情，
 * 每题材的涨停家数/均涨幅/龙头）。本页只渲染，不自己算。
 *
 * 你需要知道的（纪律，全写在这里）：
 * 1. **这一页既看懂今天，也给前瞻观察**。「下一个可能热门」是情景判断，每条都要
 *    标证据等级（已验证 / 待验证 / 噪声级），不冒充确定结论，也不给买卖动作建议。
 *    涨停梯队健康 + 均涨幅不过热 → 有延续支撑；均涨幅过热 → 追高风险。
 *    项目数据已证伪「追高连板」（板越高次日越亏，t=-10.2）。
 * 2. 龙头 = 板内涨幅最高的**非涨停**股（涨停的是花，龙头看谁在领跑梯队）。
 * 3. 均涨幅是题材内所有票的等权平均，大题材（机器人 700+ 只）会被摊薄，看涨停数更可靠。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { SectionTabs, REVIEW_TABS } from "@/components/section-tabs";
import { Panel, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getThemeHeat, type ThemeHeatItem } from "@/lib/market/quotes.functions";
import { continuationOf } from "@/lib/market/theme-continuation";
import { toneClass } from "@/lib/market/format";

export const Route = createFileRoute("/review/theme")({
  loader: () => getThemeHeat().catch(() => ({ date: "", hot: [] as ThemeHeatItem[] })),
  component: ThemePage,
});

/* 前瞻观察口径抽到 lib/market/theme-continuation.ts，首页与这里共用，
   避免两处各写一套判据、证据等级漂移。 */

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
                  <th className={thClass()}>前瞻观察 · 证据等级</th>
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
                        <div className="flex flex-col gap-1">
                          <span className="flex items-center gap-1.5">
                            <Tag tone={c.tone === "up" ? "up" : c.tone === "warn" ? "warn" : "muted"}>
                              {c.label}
                            </Tag>
                            <Tag tone={c.evidence === "已验证" ? "up" : c.evidence === "噪声级" ? "warn" : "muted"}>
                              {c.evidence}
                            </Tag>
                          </span>
                          <span className="text-[11px] leading-snug text-muted">{c.basis}</span>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="px-1 pt-3 text-[11px] leading-relaxed text-muted">
          这里是前瞻情景判断，不是确定结论：涨停梯队健康、均涨幅不过热才谈得上延续；
          情绪过热（均涨幅 ≥7%）是追高风险——连板越高次日越亏（t=-10.2，已验证）。
          题材补涨候选回测 +0.06% / t+0.63，属噪声级、待样本验证，不当作买入信号。
          每条结论按证据等级标注；完整口径见 data/theme-heat.json。
        </p>
      </Panel>
    </Frame>
  );
}
