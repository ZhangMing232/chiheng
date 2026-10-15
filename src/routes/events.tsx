/**
 * 这个文件是干什么的：
 * 「事件」页——公司层面的事件型数据清单。先做业绩预告（预期差的核心原料，
 * 也是「催化剂 SOP 兑现验证」能用的那一份）。
 *
 * 你需要知道的（纪律都写在页面上）：
 * 1. **「略增/首亏」是公司自己在公告里用的措辞**，不是我们的判断，原样显示。
 *    我们只给一个很克制的倾向（预增/扭亏/续盈 偏正，首亏/续亏/略减 偏负），
 *    **「略增」明确不表态**——见 events.ts:forecastTone。
 * 2. **同比和环比是两个口径**。实测那条「略增」的公司：同比 +31.9%，
 *    环比 -25% ~ -50%。只显示一个就会把「略增」读成「大幅下滑」，所以两个都显示。
 * 3. **全市场 0 行 = 接口坏了**，不是「今天没预告」——那种情况页面要说明白，
 *    不能显示成空页（那会被读成"今天没消息"，其实是我们没拉到）。
 */

import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Frame } from "@/components/screener/nav";
import { Panel, Stat, Tag, tdClass, thClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { GapList } from "@/components/source-line";
import { StockName } from "@/components/screener/stock-name";
import { getForecasts } from "@/lib/market/events.functions";
import { forecastTone } from "@/lib/market/events";

export const Route = createFileRoute("/events")({
  loader: () => getForecasts({ data: { limit: 80 } }).catch(() => null),
  component: EventsPage,
});

/**
 * 倾向 → 标签颜色。**null（不表态）走 muted**——不给颜色也是一种表态，
 * 涂成红色就变成我们在替公司下判断了。
 */
function kindToneOf(tone: "positive" | "negative" | null): "up" | "down" | "muted" {
  if (tone === "positive") return "up";
  if (tone === "negative") return "down";
  return "muted";
}
function EventsPage() {
  const data = Route.useLoaderData();
  const [onlyTone, setOnlyTone] = useState<"all" | "positive" | "negative">("all");

  if (!data) {
    return (
      <Frame>
        <Panel title="事件" note="没拉到">
          <StateBlock kind="empty" title="东财没返回" hint="接口没响应，刷新重试。" />
        </Panel>
      </Frame>
    );
  }
  if (data.why) {
    return (
      <Frame>
        <Panel title="业绩预告" note="拉取失败">
          <StateBlock kind="empty" title="没拉到业绩预告" hint={data.why} />
        </Panel>
      </Frame>
    );
  }

  const companies = onlyTone === "all" ? data.companies : data.companies.filter((c) => {
    const tone = forecastTone(c.items[0]?.kind ?? "不确定");
    return onlyTone === "positive" ? tone === "positive" : tone === "negative";
  });
  const posCount = data.companies.filter((c) => forecastTone(c.items[0]?.kind ?? "不确定") === "positive").length;
  const negCount = data.companies.filter((c) => forecastTone(c.items[0]?.kind ?? "不确定") === "negative").length;

  return (
    <Frame>
      <Panel
        title="业绩预告（东财）"
        note={`截至 ${data.asOf ?? "?"} · ${data.companies.length} 只票 / ${data.rows.length} 行`}
      >
        <div className="grid grid-cols-2 gap-3 px-3.5 py-3 sm:grid-cols-4">
          <Stat label="预告家数" value={data.companies.length} hint="按票去重" />
          <Stat label="偏正" value={posCount} hint="预增/扭亏/续盈" tone="text-up" />
          <Stat label="偏负" value={negCount} hint="首亏/续亏/略减" tone="text-down" />
          <Stat label="不表态" value={data.companies.length - posCount - negCount} hint="略增/持平/措辞未见过" />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2">
          {(["all", "positive", "negative"] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setOnlyTone(t)}
              className={
                "rounded border px-2 py-1 text-xs transition " +
                (onlyTone === t ? "border-brand text-fg" : "border-line text-muted hover:text-fg")
              }
            >
              {t === "all" ? "全部" : t === "positive" ? "只看偏正" : "只看偏负"}
            </button>
          ))}
        </div>

        <p className="border-t border-line px-3.5 py-2 text-[11px] text-muted">
          <strong>「预增/略增/首亏」是公司在公告里用的措辞，原样显示，不是我们的判断。</strong>
          我们只给一个克制的倾向：预增/扭亏/续盈 偏正，首亏/续亏/略减 偏负，
          <strong>「略增」明确不表态</strong>。<br />
          <strong>同比和环比是两个口径</strong>：同比 = 预测对去年同期（下面第一个数，我们按预测值和去年同期算的）；
          环比 = 对上一报告期（东财直接给的区间）。实测有公司「略增」但环比 -25%~-50%——
          只看一个会读反，所以两个都列。
        </p>

        {companies.length === 0 ? (
          <p className="px-3.5 py-6 text-sm text-muted">这个筛选下没有公司。</p>
        ) : (
          <table className="w-full">
            <caption className="sr-only">业绩预告：名称、报告期、公司措辞、同比、环比、预告值、变动原因</caption>
            <thead>
              <tr className="border-b border-line text-xs text-muted">
                <th className={thClass("text-left")}>名称</th>
                <th className={thClass("text-left")}>报告期</th>
                <th className={thClass("text-left")}>公司措辞</th>
                <th className={thClass()}>同比</th>
                <th className={thClass()}>环比</th>
                <th className={thClass()}>预告值</th>
                <th className={thClass("text-left")}>变动原因</th>
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => {
                const item = company.items[0]!;
                const tone = forecastTone(item.kind);
                return (
                  <tr key={company.code} className="border-t border-line/60 align-top">
                    <td className={tdClass("text-left")}>
                      <StockName id={item.id} name={item.name} source="flow" />
                      <div className="text-[10px] text-muted">
                        {item.code} · {company.items.length > 1 ? `${company.items.length} 个指标` : item.item}
                      </div>
                    </td>
                    <td className={tdClass("text-left text-muted")}>{company.reportDate}</td>
                    <td className={tdClass("text-left")}>
                      <Tag tone={kindToneOf(tone)}>{item.kind}</Tag>
                    </td>
                    <td className={tdClass("text-right tabular-nums " + (item.yoyPct == null ? "text-muted" : item.yoyPct >= 0 ? "text-up" : "text-down"))}>
                      {item.yoyPct == null ? "不可算" : `${item.yoyPct >= 0 ? "+" : ""}${item.yoyPct.toFixed(1)}%`}
                    </td>
                    <td className={tdClass("text-right tabular-nums text-muted")}>
                      {item.qoqLow == null && item.qoqHigh == null ? "—" : `${item.qoqLow?.toFixed(0) ?? "?"}% ~ ${item.qoqHigh?.toFixed(0) ?? "?"}%`}
                    </td>
                    <td className={tdClass("text-right tabular-nums text-muted")}>
                      {item.forecast == null ? "—" : item.forecast}
                      {item.forecastLow != null && item.forecastHigh != null && item.forecastLow !== item.forecastHigh ? (
                        <span className="text-[10px]">（{item.forecastLow}~{item.forecastHigh}）</span>
                      ) : null}
                    </td>
                    <td className={tdClass("text-left text-xs text-muted")}>
                      <span className="line-clamp-3">{item.reason ?? "—"}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}

        {data.bad > 0 ? <GapList items={[`${data.bad} 行解析不出来，已跳过`]} /> : null}
      </Panel>
    </Frame>
  );
}
