/**
 * 个股弹层（共享组件）——点任意页面里的股票名，弹 K线/涨停史/题材/监管异动。
 *
 * 数据：getStockDetail（K线缓存 + 涨停原因 + 监管异动雷达，全本地）。
 * 用在：/ladder、/rotation 成分股、/hotmoney、/intel。
 */

import { useEffect, useState } from "react";
import { Tag } from "@/components/terminal";
import { getStockDetail, type StockDetailPayload } from "@/lib/market/quotes.functions";

const fmt = (n: number) => `${(n / 10000).toFixed(0)}万`;

function Spark({ data }: { data: { date: string; c: number }[] }) {
  if (data.length < 2) return <div className="text-xs text-muted">K线不足</div>;
  const min = Math.min(...data.map((d) => d.c));
  const max = Math.max(...data.map((d) => d.c));
  const span = max - min || 1;
  const pts = data.map((d, i) => `${(i / (data.length - 1)) * 200},${60 - ((d.c - min) / span) * 56}`).join(" ");
  const up = data[data.length - 1].c >= data[0].c;
  return (
    <div>
      <svg viewBox="0 0 200 60" className="h-14 w-full" preserveAspectRatio="none">
        <polyline points={pts} fill="none" stroke={up ? "var(--color-up)" : "var(--color-down)"} strokeWidth="1.5" />
      </svg>
      <div className="flex justify-between text-[12px] text-muted">
        <span>{data[0].date.slice(5)}</span>
        <span className="num">{data[0].c.toFixed(2)} → {data[data.length - 1].c.toFixed(2)}</span>
        <span>{data[data.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}

/** 弹层内容（拿到 detail 后渲染）。 */
export function StockDetailBody({ detail, onClose }: { detail: StockDetailPayload; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-lg border border-line bg-surface p-4 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-2 flex items-baseline justify-between">
          <div className="flex items-baseline gap-2">
            <span className="text-base font-medium">{detail.name || detail.id}</span>
            <span className="num text-xs text-muted">{detail.id}</span>
          </div>
          <button type="button" onClick={onClose} className="text-sm text-muted hover:text-fg">✕</button>
        </div>
        {detail.concept ? <div className="mb-2"><Tag tone="brand">{detail.concept}</Tag></div> : null}
        <div className="mb-3">
          <div className="mb-1 text-[12px] text-muted">近 60 日收盘</div>
          <Spark data={detail.kline} />
        </div>
        {detail.limitUps.length > 0 ? (
          <div className="mb-3">
            <div className="mb-1 text-[12px] text-muted">近 10 次涨停</div>
            <div className="flex flex-wrap gap-1">
              {detail.limitUps.map((d) => <span key={d} className="num rounded bg-up-soft px-1 text-[12px] text-up">{d.slice(5)}</span>)}
            </div>
          </div>
        ) : null}
        {detail.regulatory ? (
          <div className="mb-2 rounded border border-line px-2 py-1.5 text-xs">
            <Tag tone={detail.regulatory.level === "已达" ? "warn" : "muted"}>
              {detail.regulatory.level === "已达" ? "已达异动线" : "临近异动线"}
            </Tag>
            <span className="num ml-2">3日偏离 {(detail.regulatory.dev * 100).toFixed(1)}% / {detail.regulatory.threshold.toFixed(0)}%</span>
          </div>
        ) : null}
        {detail.reason ? (
          <div className="border-t border-line pt-2 text-[12px] leading-relaxed text-muted">{detail.reason.slice(0, 200)}</div>
        ) : null}
        <div className="mt-2 text-[12px] text-muted">封板/开板明细见连板天梯；数据仅供研究，不构成投资建议。</div>
      </div>
    </div>
  );
}

/** 点股名用的钩子：返回 openDetail + 当前弹层（null 不渲染）。 */
export function useStockDetail() {
  const [detail, setDetail] = useState<StockDetailPayload | null>(null);
  const [loading, setLoading] = useState<string | null>(null);

  // 点外部空白/ESC 关闭由 StockDetailBody 的 onClick 处理
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setDetail(null);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const openDetail = async (id: string, name?: string) => {
    setLoading(id || name || "");
    try {
      setDetail(await getStockDetail({ data: { id, name: name ?? "" } }));
    } finally {
      setLoading(null);
    }
  };

  const modal = detail ? <StockDetailBody detail={detail} onClose={() => setDetail(null)} /> : null;
  return { openDetail, loading, modal };
}

export { fmt };
