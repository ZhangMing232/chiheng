/**
 * 趋势中军（/rs）——看谁**在多个时间尺度上都比全市场强**，不是看谁今天涨得多。
 *
 * 为什么要有这一页：涨停榜只有今天，天梯只有连板，两者都看不见「这只票这半年一直在赢」。
 * 趋势中军的用处是反过来的——先从强度榜里挑出还在走强的票，再去想它为什么强。
 *
 * 口径（页面上原文印，别在这儿偷改）：
 *   原始强度 = 0.4×20日 + 0.3×60日 + 0.2×120日 + 0.1×250日 涨幅
 *   RS = 全市场截面的中位秩（严格小于 + 0.5×相等）→ 0~100
 *   距 250 日高点 = 最新收盘 ÷ 近 250 日最高价 − 1
 * 门槛：成交额 ≥ 2 亿。太小的票 RS 再高也接不住钱，一笔单子就能拉出涨幅。
 */

import { createFileRoute } from "@tanstack/react-router";
import { Link } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getRs } from "@/lib/market/archive.functions";

export const Route = createFileRoute("/rs")({
  loader: async () => await getRs(),
  component: RsPage,
});

// 负零要吃掉：距高点 -0.11% 在 d=0 下会 toFixed 成 "-0"，屏幕上出现「-0%」这种
// 既难看又误导的东西（看着像跌，其实是贴着高点）。阈值按位数缩放，d=0 时吞 0.5 以内。
const pct = (v: number, d = 0) => {
  const x = v * 100;
  const vv = Math.abs(x) < 0.5 * 10 ** -d ? 0 : x;
  return `${vv > 0 ? "+" : ""}${vv.toFixed(d)}%`;
};
const yi = (wan: number) => (wan >= 10000 ? `${(wan / 10000).toFixed(1)}亿` : `${wan.toFixed(0)}万`);

function RsPage() {
  const rs = Route.useLoaderData();
  if (!rs) {
    return (
      <Frame wide>
        <Panel title="趋势中军">
          <StateBlock kind="empty" title="还没算" hint="跑 scripts/rs-build.ts（读本地 K 线，不联网）。" />
        </Panel>
      </Frame>
    );
  }

  const rows = rs.rows;
  const strong = rows.filter((r) => r.fromHigh > -0.05).length;

  return (
    <Frame wide aside={<span className="num text-xs text-muted">{rs.date} · 参与排名 {rs.universe} 只 · 上榜 {rows.length} 只</span>}>
      <div className="flex flex-col gap-3">
        <Panel title="趋势中军" note={<span className="text-[12px]">强度是多周期加权，不是今天的涨幅</span>}>
          <div className="grid grid-cols-2 gap-px overflow-hidden border-b border-line bg-line sm:grid-cols-4">
            <div className="bg-surface px-3 py-2">
              <div className="text-[12px] text-muted">中位强度</div>
              <div className={"num text-lg font-medium " + (rs.medianRaw >= 0 ? "text-up" : "text-down")}>{pct(rs.medianRaw, 1)}</div>
              <div className="num text-[10px] text-muted">全市场一半的票在这条线以下</div>
            </div>
            <div className="bg-surface px-3 py-2">
              <div className="text-[12px] text-muted">贴近 250 日高</div>
              <div className="num text-lg font-medium">{strong}</div>
              <div className="num text-[10px] text-muted">距高点 5% 以内的上榜票</div>
            </div>
            <div className="bg-surface px-3 py-2">
              <div className="text-[12px] text-muted">剔除停牌</div>
              <div className="num text-lg font-medium">{rs.stale}</div>
              <div className="num text-[10px] text-muted">最后一根不是最新交易日的</div>
            </div>
            <div className="bg-surface px-3 py-2">
              <div className="text-[12px] text-muted">成交额门槛</div>
              <div className="num text-lg font-medium">{yi(rs.minAmountWan)}</div>
              <div className="num text-[10px] text-muted">低于这条不上榜</div>
            </div>
          </div>

          <div className="overflow-x-auto px-3 py-3 scroll-slim">
            <table className="data-table w-full min-w-[880px] text-xs">
              <thead>
                <tr>
                  <th className="w-8 text-right">#</th>
                  <th className="text-left">名称</th>
                  <th className="text-left">行业</th>
                  <th className="text-right">RS</th>
                  <th className="text-right">20日</th>
                  <th className="text-right">60日</th>
                  <th className="text-right">120日</th>
                  <th className="text-right">250日</th>
                  <th className="text-right">距高点</th>
                  <th className="text-right">成交额</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.id}>
                    <td className="num text-right text-muted">{i + 1}</td>
                    <td>
                      <Link to="/symbol" search={{ q: r.id }} className="hover:underline">
                        {r.name}
                      </Link>
                      <span className="num ml-1.5 text-[10px] text-muted">{r.id}</span>
                    </td>
                    <td className="max-w-[130px] truncate text-[12px] text-muted">{r.industry || "—"}</td>
                    <td className="num text-right font-medium">{r.rs.toFixed(1)}</td>
                    <td className={"num text-right " + (r.r20 >= 0 ? "text-up" : "text-down")}>{pct(r.r20)}</td>
                    <td className={"num text-right " + (r.r60 >= 0 ? "text-up" : "text-down")}>{pct(r.r60)}</td>
                    <td className={"num text-right " + (r.r120 >= 0 ? "text-up" : "text-down")}>{pct(r.r120)}</td>
                    <td className={"num text-right " + (r.r250 >= 0 ? "text-up" : "text-down")}>{pct(r.r250)}</td>
                    <td className={"num text-right " + (r.fromHigh >= -0.02 ? "text-up" : "text-muted")}>{pct(r.fromHigh, 1)}</td>
                    <td className="num text-right text-muted">{yi(r.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-line px-3 py-2 text-[12px] leading-relaxed text-muted">
            原始强度 = 0.4×20日 + 0.3×60日 + 0.2×120日 + 0.1×250日 涨幅；RS 是全市场截面中位秩。
            距高点是负值，0% 表示正贴着 250 日最高价。
          </div>
        </Panel>

        <Panel title="这一榜不能干什么">
          <div className="flex flex-col gap-1.5 px-3 py-3 text-[12px] leading-relaxed text-muted">
            <div>· 它不预测。强度高只说明过去这段它在赢，不说明明天还赢——回测里「追强势」是最容易过拟合的一类。</div>
            <div>· 它不含资金和龙虎榜。要那两样去 /hotmoney 和 /seats。</div>
            <div>· 全市场一半的票强度为负是常态（今天 {pct(rs.medianRaw, 1)}），榜单前 200 名都是正强度并不稀奇，看的是相对位置。</div>
            <div>· 想拿它选股，仍要走 /decision 的闸门，别把榜当成买入信号。</div>
          </div>
        </Panel>
      </div>
    </Frame>
  );
}
