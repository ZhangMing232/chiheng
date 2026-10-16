/**
 * 这个文件是干什么的：
 * 「公司事件」面板 —— 公司层面的事件型数据清单。四类（2026-10-16 起了三类）：
 * 业绩预告（预期差的核心原料，催化剂 SOP 的兑现验证）、股东增减持、机构调研、
 * 股票回购。后三类是「谁在用真金白银投票」的信号。
 *
 * 2026-10-16 整合导航：/events 不再是独立页面，本文件只导出 EventsPanel 组件，
 * 由 /calendar 页以「页内 tab（三级导航）」的方式挂进去；/events 路由保留但重定向到
 * /calendar?tab=events（旧链接、手机书签不断）。
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

import { createFileRoute, redirect } from "@tanstack/react-router";
import { useState } from "react";
import { Panel, Stat, Tag, tdClass, thClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { GapList } from "@/components/source-line";
import { StockName } from "@/components/screener/stock-name";
import { getBuybacks, getForecasts, getHolderTrades, getSurveys } from "@/lib/market/events.functions";
import { buybackTone, forecastTone, holderTone } from "@/lib/market/events";

export const Route = createFileRoute("/events")({
  // 旧链接兼容：/events 已并入日历页（页内 tab），进来直接送过去。
  beforeLoad: () => {
    throw redirect({ to: "/calendar", search: { tab: "events" } });
  },
});

export type ForecastsPayload = Awaited<ReturnType<typeof getForecasts>>;
export type HolderTradesPayload = Awaited<ReturnType<typeof getHolderTrades>>;
export type SurveysPayload = Awaited<ReturnType<typeof getSurveys>>;
export type BuybacksPayload = Awaited<ReturnType<typeof getBuybacks>>;

/**
 * 倾向 → 标签颜色。**null（不表态）走 muted**——不给颜色也是一种表态，
 * 涂成红色就变成我们在替公司下判断了。
 */
function kindToneOf(tone: "positive" | "negative" | null): "up" | "down" | "muted" {
  if (tone === "positive") return "up";
  if (tone === "negative") return "down";
  return "muted";
}

/** 事件面板的二级分类（业绩预告 + 2026-10-16 新增三类）。 */
type EventTab = "forecast" | "holder" | "survey" | "buyback";

const EVENT_TABS: { key: EventTab; label: string }[] = [
  { key: "forecast", label: "业绩预告" },
  { key: "holder", label: "股东增减持" },
  { key: "survey", label: "机构调研" },
  { key: "buyback", label: "股票回购" },
];

/**
 * 公司事件面板本体。日历页以 tab 方式挂它；各 payload 为 null = 没拉到。
 *
 * 二级 tab 而不是四个面板竖排：一次只拉当前要看的，页面不会一打开就四条长表
 * （每类 60~80 行）。数据是 loader 里并发拉齐的，切换不重新请求。
 */
export function EventsPanel({
  data,
  holders,
  surveys,
  buybacks,
}: {
  data: ForecastsPayload | null;
  holders?: HolderTradesPayload | null;
  surveys?: SurveysPayload | null;
  buybacks?: BuybacksPayload | null;
}) {
  const [tab, setTab] = useState<EventTab>("forecast");
  const [onlyTone, setOnlyTone] = useState<"all" | "positive" | "negative">("all");

  const tabBar = (
    <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
      {EVENT_TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => setTab(t.key)}
          className={
            "rounded border px-2 py-1 text-xs transition " +
            (tab === t.key ? "border-brand text-fg" : "border-line text-muted hover:text-fg")
          }
        >
          {t.label}
        </button>
      ))}
    </div>
  );

  if (tab === "holder") return <HolderTradesPanel data={holders ?? null} />;
  if (tab === "survey") return <SurveysPanel data={surveys ?? null} />;
  if (tab === "buyback") return <BuybacksPanel data={buybacks ?? null} />;

  if (!data) {
    return (
      <Panel title="业绩预告" note="没拉到">
        <StateBlock kind="empty" title="东财没返回" hint="接口没响应，刷新重试。" />
      </Panel>
    );
  }
  if (data.why) {
    return (
      <Panel title="业绩预告" note="拉取失败">
        <StateBlock kind="empty" title="没拉到业绩预告" hint={data.why} />
      </Panel>
    );
  }

  const companies = onlyTone === "all" ? data.companies : data.companies.filter((c) => {
    const tone = forecastTone(c.items[0]?.kind ?? "不确定");
    return onlyTone === "positive" ? tone === "positive" : tone === "negative";
  });
  const posCount = data.companies.filter((c) => forecastTone(c.items[0]?.kind ?? "不确定") === "positive").length;
  const negCount = data.companies.filter((c) => forecastTone(c.items[0]?.kind ?? "不确定") === "negative").length;

  return (
    <Panel
      title="业绩预告（东财）"
      note={`截至 ${data.asOf ?? "?"} · ${data.companies.length} 只票 / ${data.rows.length} 行`}
    >
      {tabBar}
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
  );
}

/**
 * 股东增减持面板。
 *
 * 口径三条（页面上也写着）：
 * 1. **只认公告披露的**：DIRECTION（增持/减持）、股数、变动后持股、成交均价、方式。
 *    东财还有个 CHANGE_RATE 字段，实测和 DIRECTION 方向对不上（增持却给 -5.94），
 *    **口径不明就不显示**——摆上去就是误导。
 * 2. 股数单位万股，均价很多公告不披露（null 显示「未披露」）。
 * 3. 倾向只按「增持/减持」两个字判，别的措辞不表态。
 */
function HolderTradesPanel({ data }: { data: HolderTradesPayload | null }) {
  if (!data || data.why) {
    return (
      <Panel title="股东增减持" note={data?.why ? "拉取失败" : "没拉到"}>
        <StateBlock
          kind="empty"
          title="没拉到股东增减持"
          hint={data?.why ?? "接口没响应，刷新重试。"}
        />
      </Panel>
    );
  }
  const rows = data.rows;
  const upCount = rows.filter((r) => holderTone(r.direction) === "positive").length;
  const downCount = rows.filter((r) => holderTone(r.direction) === "negative").length;
  const withPrice = rows.filter((r) => r.avgPrice != null).length;
  return (
    <Panel title="股东增减持（东财）" note={`${rows.length} 条公告`}>
      <div className="grid grid-cols-2 gap-3 px-3.5 py-3 sm:grid-cols-4">
        <Stat label="公告条数" value={rows.length} hint="重要股东变动" />
        <Stat label="增持" value={upCount} hint="按公告措辞" tone="text-up" />
        <Stat label="减持" value={downCount} hint="按公告措辞" tone="text-down" />
        <Stat label="披露了均价" value={withPrice} hint={`${rows.length} 条里`} />
      </div>

      <p className="border-t border-line px-3.5 py-2 text-[11px] text-muted">
        <strong>只认公告披露的字段</strong>：方向、股数、变动后持股、成交均价、变动方式。
        东财另有一个变动比例字段，实测和「增持/减持」的方向对不上（有公告写着增持、
        那个字段却是负的），<strong>口径不明就不显示</strong>。均价很多公告不披露，
        显示「未披露」不是漏抓。
      </p>

      {rows.length === 0 ? (
        <p className="px-3.5 py-6 text-sm text-muted">今天没有变动公告。</p>
      ) : (
        <table className="w-full">
          <caption className="sr-only">股东增减持：名称、方向、股东、股数、均价、变动后持股、方式</caption>
          <thead>
            <tr className="border-t border-line text-xs text-muted">
              <th className={thClass("text-left")}>名称</th>
              <th className={thClass("text-left")}>方向</th>
              <th className={thClass("text-left")}>股东</th>
              <th className={thClass()}>股数（万股）</th>
              <th className={thClass()}>均价（元）</th>
              <th className={thClass()}>变动后持股</th>
              <th className={thClass("text-left")}>方式</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const tone = holderTone(row.direction);
              return (
                <tr key={`${row.id}-${row.holder}-${row.startDate}`} className="border-t border-line/60">
                  <td className={tdClass("text-left")}>
                    <StockName id={row.id} name={row.name} source="flow" />
                    <div className="text-[10px] text-muted">{row.code}</div>
                  </td>
                  <td className={tdClass("text-left")}>
                    <Tag tone={kindToneOf(tone)}>{row.direction}</Tag>
                  </td>
                  <td className={tdClass("text-left text-xs text-muted")}>{row.holder}</td>
                  <td className={tdClass("text-right tabular-nums")}>{row.shares ?? "—"}</td>
                  <td className={tdClass("text-right tabular-nums text-muted")}>
                    {row.avgPrice == null ? "未披露" : row.avgPrice}
                  </td>
                  <td className={tdClass("text-right tabular-nums text-muted")}>
                    {row.holdRatio == null ? "—" : `${row.holdRatio}%`}
                  </td>
                  <td className={tdClass("text-left text-xs text-muted")}>{row.channel ?? "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      {data.bad > 0 ? <GapList items={[`${data.bad} 行解析不出来，已跳过`]} /> : null}
    </Panel>
  );
}

/**
 * 机构调研面板。
 *
 * 口径两条：
 * 1. **汇总模式**：一次调研一行，SUM 是参与机构家数。一家机构一行的明细模式没接——
 *    那一层很多记录表不写机构类型和人名，接了也是半截数据。
 * 2. 接待日通常早于公告日几天，两个日期都显示（只显示一个会以为机构当天才去）。
 */
function SurveysPanel({ data }: { data: SurveysPayload | null }) {
  if (!data || data.why) {
    return (
      <Panel title="机构调研" note={data?.why ? "拉取失败" : "没拉到"}>
        <StateBlock kind="empty" title="没拉到机构调研" hint={data?.why ?? "接口没响应，刷新重试。"} />
      </Panel>
    );
  }
  const rows = data.rows;
  const totalOrgs = rows.reduce((sum, r) => sum + (r.orgCount ?? 0), 0);
  return (
    <Panel title="机构调研（东财）" note={`${rows.length} 次调研`}>
      <div className="grid grid-cols-2 gap-3 px-3.5 py-3 sm:grid-cols-4">
        <Stat label="调研次数" value={rows.length} hint="按公告汇总" />
        <Stat label="涉及机构家次" value={totalOrgs} hint="各次参与机构合计" />
        <Stat
          label="有接待对象的"
          value={rows.filter((r) => r.object != null).length}
          hint="很多记录表不写具体对象"
        />
        <Stat label="披露了地点" value={rows.filter((r) => r.place != null).length} hint="现场调研才有" />
      </div>

      <p className="border-t border-line px-3.5 py-2 text-[11px] text-muted">
        <strong>汇总模式</strong>：一次调研一行，家数是参与机构合计。一家机构一行的明细没接——
        那一层很多记录表不写机构类型和人名，接了也是半截数据。<br />
        <strong>接待日通常早于公告日几天</strong>（公司先接待、后发公告），两个日期都列着。
      </p>

      {rows.length === 0 ? (
        <p className="px-3.5 py-6 text-sm text-muted">今天没有调研公告。</p>
      ) : (
        <table className="w-full">
          <caption className="sr-only">机构调研：名称、接待日、公告日、机构家数、方式、接待对象、地点</caption>
          <thead>
            <tr className="border-t border-line text-xs text-muted">
              <th className={thClass("text-left")}>名称</th>
              <th className={thClass("text-left")}>接待日</th>
              <th className={thClass("text-left")}>公告日</th>
              <th className={thClass()}>机构家数</th>
              <th className={thClass("text-left")}>方式</th>
              <th className={thClass("text-left")}>接待对象</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.id}-${row.receiveDate}`} className="border-t border-line/60">
                <td className={tdClass("text-left")}>
                  <StockName id={row.id} name={row.name} source="flow" />
                  <div className="text-[10px] text-muted">{row.code}</div>
                </td>
                <td className={tdClass("text-left text-muted")}>{row.receiveDate || "—"}</td>
                <td className={tdClass("text-left text-muted")}>{row.noticeDate || "—"}</td>
                <td className={tdClass("text-right tabular-nums")}>{row.orgCount ?? "—"}</td>
                <td className={tdClass("text-left text-xs text-muted")}>{row.way ?? "—"}</td>
                <td className={tdClass("text-left text-xs text-muted")}>{row.object ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.bad > 0 ? <GapList items={[`${data.bad} 行解析不出来，已跳过`]} /> : null}
    </Panel>
  );
}

/**
 * 股票回购面板。
 *
 * 口径三条：
 * 1. **进度码只映射实测确认的三个**（001 董事会预案 / 002 股东大会通过 / 004 实施中），
 *    其余显示原码 +「码位未识别」——东财还有 007/008 两个它自己页面都不显示名称的码。
 * 2. **未开始实施的已回购字段是「—」不是 0**——0 股会被读成「回购了 0 股」。
 * 3. 倾向：实施中/完成是公司在买（偏正），停止实施/否决是黄了（偏负）；
 *    预案/通过只是流程节点，**不表态**。
 */
function BuybacksPanel({ data }: { data: BuybacksPayload | null }) {
  if (!data || data.why) {
    return (
      <Panel title="股票回购" note={data?.why ? "拉取失败" : "没拉到"}>
        <StateBlock kind="empty" title="没拉到股票回购" hint={data?.why ?? "接口没响应，刷新重试。"} />
      </Panel>
    );
  }
  const rows = data.rows;
  const running = rows.filter((r) => r.progressCode === "004").length;
  const fmtWan = (v: number | null): string =>
    v == null ? "—" : v >= 1e8 ? `${(v / 1e8).toFixed(2)} 亿` : `${(v / 1e4).toFixed(0)} 万`;
  return (
    <Panel title="股票回购（东财）" note={`${rows.length} 个方案`}>
      <div className="grid grid-cols-2 gap-3 px-3.5 py-3 sm:grid-cols-4">
        <Stat label="方案数" value={rows.length} hint="一个方案一行" />
        <Stat label="实施中" value={running} hint="进度码 004" tone="text-up" />
        <Stat
          label="计划金额合计"
          value={fmtWan(rows.reduce((s, r) => s + (r.amountLower ?? 0), 0))}
          hint="各方案下限之和"
        />
        <Stat
          label="已回购合计"
          value={fmtWan(rows.reduce((s, r) => s + (r.doneAmount ?? 0), 0))}
          hint="已实施部分"
        />
      </div>

      <p className="border-t border-line px-3.5 py-2 text-[11px] text-muted">
        <strong>进度码只映射实测确认的三个</strong>（董事会预案/股东大会通过/实施中），
        其余显示原码——东财还有连它自己页面都不显示名称的码位，不猜。<br />
        <strong>已回购字段「—」表示没开始实施，不是 0</strong>。倾向只对实施中/完成
        （公司在买）和停止实施/否决（黄了）表态，预案和通过只是流程节点。
      </p>

      {rows.length === 0 ? (
        <p className="px-3.5 py-6 text-sm text-muted">当前没有回购方案。</p>
      ) : (
        <table className="w-full">
          <caption className="sr-only">股票回购：名称、进度、计划金额、已回购、价格上限、最新公告</caption>
          <thead>
            <tr className="border-t border-line text-xs text-muted">
              <th className={thClass("text-left")}>名称</th>
              <th className={thClass("text-left")}>进度</th>
              <th className={thClass()}>计划金额</th>
              <th className={thClass()}>已回购</th>
              <th className={thClass()}>价格上限</th>
              <th className={thClass("text-left")}>最新公告</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={`${row.id}-${row.progressCode}-${row.planStart}`} className="border-t border-line/60">
                <td className={tdClass("text-left")}>
                  <StockName id={row.id} name={row.name} source="flow" />
                  <div className="text-[10px] text-muted">{row.code}</div>
                </td>
                <td className={tdClass("text-left")}>
                  <Tag tone={kindToneOf(buybackTone(row.progressCode))}>
                    {row.progress ?? `码 ${row.progressCode}（未识别）`}
                  </Tag>
                </td>
                <td className={tdClass("text-right tabular-nums text-muted")}>
                  {row.amountLower == null && row.amountUpper == null
                    ? "—"
                    : `${fmtWan(row.amountLower)}~${fmtWan(row.amountUpper)}`}
                </td>
                <td className={tdClass("text-right tabular-nums text-muted")}>
                  {row.doneAmount == null ? "—" : fmtWan(row.doneAmount)}
                </td>
                <td className={tdClass("text-right tabular-nums text-muted")}>
                  {row.priceCap == null ? "—" : `${row.priceCap} 元`}
                </td>
                <td className={tdClass("text-left text-xs text-muted")}>{row.latestNotice || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {data.bad > 0 ? <GapList items={[`${data.bad} 行解析不出来，已跳过`]} /> : null}
    </Panel>
  );
}
