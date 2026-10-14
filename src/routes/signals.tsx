/**
 * 这个文件是干什么的：
 * 「信号」页——涨停/炸板/跌停三个池 + 连板梯队 + 炸板率。
 * （对标 Vibe-Research 的 Signals 页，缺口表里原来标着"整页缺失"）
 *
 * 你需要知道的（纪律）：
 * 1. **这一页不给买卖建议**。涨停池是"今天发生了什么"的事实陈述，
 *    不是"明天买什么"的推荐。板学那套（打板战法）赤轨不碰。
 * 2. **盘中数据未定**：涨停池要收盘后才定，盘中拉到的是半截。
 *    页面按 15:00 判"已定/未定"，标出来。
 * 3. **炸板池的涨跌幅是负的**（涨停后开板回落），页面显示回落多少，
 *    不显示成"涨停"——那是误读。
 * 4. 题材归因（同花顺涨停揭秘）**没接**：那是市场叙事不是核验过的因果，
 *    接了要标清性质，这一步先不做。
 * 5. 非交易日东财返回空 → 页面说"这天不是交易日"，不显示全 0。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel, Stat, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { GapList } from "@/components/source-line";
import { getSignals } from "@/lib/market/limit-up.functions";
import { type LimitUpRow } from "@/lib/market/limit-up";
import { toneClass } from "@/lib/market/format";

export const Route = createFileRoute("/signals")({
  validateSearch: (search: Record<string, unknown>) => ({
    date: typeof search.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(search.date) ? search.date : "",
  }),
  loaderDeps: ({ search }) => ({ date: search.date }),
  loader: ({ deps }) =>
    getSignals({ data: { date: deps.date || undefined } }).catch(() => null),
  component: SignalsPage,
});

function SignalsPage() {
  const data = Route.useLoaderData();

  if (!data) {
    return (
      <Frame aside="信号">
        <Panel title="涨停 / 炸板 / 跌停" note="没拉到">
          <StateBlock kind="empty" title="东财没返回" hint="三个池都是空的。稍后再试，或者换个交易日。" />
        </Panel>
      </Frame>
    );
  }

  const { summary } = data;

  return (
    <Frame aside="信号">
      <Panel title="今日信号" note={`${data.date}${data.sealed ? " · 已收盘，数据已定" : " · 盘中，数据未定"}`}>
        {!data.sealed ? (
          <p className="border-b border-line px-3.5 py-2 text-[11px] text-muted">
            现在是盘中：涨停池要收盘后才定，现在看到的是半截。别拿它当结论。
          </p>
        ) : null}

        {!summary ? (
          <StateBlock
            kind="empty"
            title="这天没有信号数据"
            hint={data.why ?? "东财对非交易日返回空。这是正常的，不是接口坏了。"}
          />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 px-3.5 py-3 sm:grid-cols-4">
              <Stat label="涨停" value={summary.limitUp} hint="只" />
              <Stat label="炸板" value={summary.broken} hint="只（涨停后开板）" />
              <Stat label="跌停" value={summary.limitDown} hint="只" />
              <Stat
                label="炸板率"
                value={summary.breakRate == null ? "—" : `${(summary.breakRate * 100).toFixed(1)}%`}
                hint={summary.breakRate == null ? "没数据" : "炸板 ÷ 曾经涨停的全部"}
              />
            </div>

            {summary.ladder.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2">
                <span className="text-xs text-muted">连板梯队：</span>
                {summary.ladder.map((rung) => (
                  <Tag key={rung.streak} tone={rung.streak >= 3 ? "warn" : "muted"}>
                    {rung.streak} 连板 {rung.count} 只
                  </Tag>
                ))}
              </div>
            ) : null}

            {summary.topIndustries.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-line px-3.5 py-2">
                <span className="text-xs text-muted">涨停集中的行业：</span>
                {summary.topIndustries.map((row) => (
                  <Tag key={row.industry} tone="muted">
                    {row.industry} {row.count}
                  </Tag>
                ))}
              </div>
            ) : null}

            <p className="border-t border-line px-3.5 py-2 text-[11px] text-muted">
              这一页只说"今天发生了什么"，不说"明天买什么"。板学那套赤轨不碰。
            </p>
          </>
        )}

        {data.bad > 0 ? <GapList items={[`${data.bad} 行解析不出来，已跳过`]} /> : null}
      </Panel>

      <PoolPanel title="涨停池" rows={data.limitUp} note="按首次封板时间排，连板数=lb c" />
      <PoolPanel title="炸板池" rows={data.broken} note="涨跌幅通常是负的——涨停后开板回落" />
      <PoolPanel title="跌停池" rows={data.limitDown} note="封板资金是跌停价上的挂单" />
    </Frame>
  );
}

function PoolPanel({ title, rows, note }: { title: string; rows: LimitUpRow[]; note: string }) {
  if (rows.length === 0) return null;
  return (
    <Panel title={`${title}（${rows.length} 只）`} note={note}>
      <table className="data-table w-full">
        <caption className="sr-only">{title}：代码、名称、现价、涨跌幅、连板、炸板次数、封板资金、行业</caption>
        <thead>
          <tr className="border-b border-line">
            <th className={thClass("text-left")}>代码</th>
            <th className={thClass("text-left")}>名称</th>
            <th className={thClass()}>现价</th>
            <th className={thClass()}>涨跌幅</th>
            <th className={thClass()}>连板</th>
            <th className={thClass()}>炸板次数</th>
            <th className={thClass()}>封板资金</th>
            <th className={thClass("text-left")}>行业</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-line/60">
              <td className={tdClass("text-left text-muted")}>{row.code}</td>
              <td className={tdClass("text-left")}>
                <span className="text-fg">{row.name}</span>
              </td>
              <td className={tdClass("text-right text-muted")}>{row.price}</td>
              <td className={tdClass("text-right " + toneClass(row.pct))}>
                {row.pct >= 0 ? "+" : ""}
                {row.pct.toFixed(2)}%
              </td>
              <td className={tdClass("text-right text-muted")}>{row.streak == null ? "—" : `${row.streak} 板`}</td>
              <td className={tdClass("text-right text-muted")}>{row.breaks == null ? "—" : row.breaks}</td>
              <td className={tdClass("text-right text-muted")}>
                {row.sealFund == null ? "—" : row.sealFund >= 1e8 ? `${(row.sealFund / 1e8).toFixed(2)} 亿` : `${(row.sealFund / 1e4).toFixed(0)} 万`}
              </td>
              <td className={tdClass("text-left text-muted")}>{row.industry ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Panel>
  );
}
