/**
 * 这个文件是干什么的：
 * 在选股页顶上显示「这份行情是哪来的、多久前的」。一个点加一句话。
 *
 * 你需要知道的：
 * 加上它是因为踩过坑：主源腾讯降级到新浪那天，新浪那份名单没有近 5/20/60 日
 * 涨幅、量比也是 0，于是放量突破和中期反转**一只都进不来**，而页面只显示
 * 「这套策略现在没有符合的股票」——看着像今天没机会，实际是数据源坏了。
 * 那天靠翻日志才定位到，白花了几个小时。
 *
 * 所以这里把话说出来：哪个源、多久前、是不是过期、降级时少了什么字段。
 * 涨跌配色用不上（这里讲的是数据新旧，不是行情涨跌），只用中性色。
 */
import { snapshotAge, toneClass } from "@/lib/market/format";
import type { Universe } from "@/lib/market/types";

const SOURCE_LABEL: Record<string, string> = {
  tencent: "腾讯",
  sina: "新浪财经",
  eastmoney: "东方财富",
};

export function DataFreshness({
  universe,
  now,
}: {
  universe: Universe | null | undefined;
  now: number;
}) {
  if (!universe || universe.quotes.length === 0) {
    return <span className="text-muted">行情还没拉下来</span>;
  }
  // source 是可选字段（老账本、磁盘缓存里都可能没有），所以先兜住再查表
  const key = universe.source ?? "";
  const source = SOURCE_LABEL[key] ?? (key || "未知来源");
  // 降级到新浪时那几套策略硬性要的字段是空的，这里说清楚，别让人以为是没票
  const degraded = universe.source === "sina";
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-1.5">
      <span
        className={`size-1.5 shrink-0 rounded-full ${universe.stale ? toneClass(-1) : degraded ? "bg-muted" : toneClass(1)}`}
        aria-hidden
      />
      <span className="tabular-nums text-muted">
        {source} · {snapshotAge(now - universe.asOf)}
      </span>
      {universe.stale ? <span className="text-down">· 拉不到新的，用的是旧数据</span> : null}
      {degraded ? (
        <span className="text-down">· 这个源没有 5/20/60 日涨幅和量比，突破和中期反转今天不出票</span>
      ) : null}
    </span>
  );
}
