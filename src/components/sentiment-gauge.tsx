/**
 * 市场情绪温度计——全站签名组件（《赤轨 UI 升级方案 2026-10》首页 Zone A）。
 *
 * 形态：横向五档量柱（冰点→沸点，冷色→朱砂渐变）+ 超大综合分 + 档位状态词
 * + 一句话市场事实 + ⓘ 计算说明弹层（四个分量、各自权重、真实数字、缺失降权说明）。
 *
 * 纪律：
 * - 纯展示：计算在 lib/market/sentiment.ts，这里只渲染。
 * - 数据全缺时渲染 Empty 态，绝不编造读数。
 * - 涨热冷凉：分高偏红系、分低偏蓝系，档位色是唯一彩色来源。
 */

import { useState } from "react";
import {
  BAND_COLOR,
  BAND_ORDER,
  type SentimentBand,
  type SentimentReading,
} from "@/lib/market/sentiment";

export function SentimentGauge({
  reading,
  updatedAt,
}: {
  /** null = 情绪数据整体不可用，渲染 Empty 态 */
  reading: SentimentReading | null;
  /** 数据时间戳（毫秒），用于「更新于」脚注；null 显示未知 */
  updatedAt?: number | null;
}) {
  const [open, setOpen] = useState(false);

  if (reading == null || reading.score == null || reading.band == null) {
    return (
      <div className="rounded border border-line bg-surface px-4 py-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-sm font-medium">市场情绪温度计</h3>
        </div>
        <div className="py-6 text-center text-sm text-muted">
          行情快照暂不可用，情绪读数待数据恢复后自动出现
        </div>
      </div>
    );
  }

  const activeIdx = BAND_ORDER.indexOf(reading.band);

  return (
    <div className="relative rounded border border-line bg-surface px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-muted">市场情绪温度计</h3>
        <div className="flex items-center gap-2 text-[11px] text-muted">
          {updatedAt != null ? (
            <span className="tabular-nums">更新于 {new Date(updatedAt).toTimeString().slice(0, 5)}</span>
          ) : (
            <span>时间未知</span>
          )}
          <button
            type="button"
            aria-label="计算说明"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="rounded border border-line px-1.5 text-muted transition hover:bg-surface-2 hover:text-fg"
          >
            ⓘ
          </button>
        </div>
      </div>

      <div className="mt-2 flex items-end justify-between gap-4">
        <div className="flex items-baseline gap-2">
          <span
            className="num font-display text-[40px] font-light leading-none"
            style={{ color: BAND_COLOR[reading.band] }}
          >
            {reading.score}
          </span>
          <span className="text-sm font-medium" style={{ color: BAND_COLOR[reading.band] }}>
            {reading.band}
          </span>
        </div>
        <p className="max-w-[55%] text-right text-xs leading-relaxed text-muted">{reading.line}</p>
      </div>

      {/* 五档量柱：激活档之前的柱子带透明度，之后的几乎不可见——读数一眼定位 */}
      <div className="mt-3 flex gap-1" role="img" aria-label={`情绪档位：${reading.band}（${reading.score} 分）`}>
        {BAND_ORDER.map((band, i) => (
          <div key={band} className="flex-1">
            <div
              className="h-1.5 rounded-full transition"
              style={{
                background: BAND_COLOR[band],
                opacity: i <= activeIdx ? (i === activeIdx ? 1 : 0.45) : 0.12,
              }}
            />
            <div
              className="mt-1 text-center text-[10px]"
              style={{ color: i === activeIdx ? BAND_COLOR[band] : "var(--color-muted)" }}
            >
              {band}
            </div>
          </div>
        ))}
      </div>

      {/* 计算说明弹层：分量、权重、真实数字、缺失说明。悬在内不消失。 */}
      {open ? (
        <div className="absolute right-3 top-9 z-20 w-72 rounded border border-line bg-surface-2 p-3 shadow-lg">
          <div className="text-xs font-medium">综合分怎么算</div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted">
            四个分量按固定权重加权（{reading.weightUsed < 1 ? "部分数据缺失，权重已按比例归一" : "数据齐全"}）：
          </p>
          <ul className="mt-1.5 space-y-1">
            {reading.components.map((c) => (
              <li key={c.key} className="flex items-baseline justify-between gap-2 text-[11px]">
                <span className="shrink-0 text-muted">
                  {c.label}
                  <span className="ml-1 text-muted/60">×{c.weight}</span>
                </span>
                <span className="num shrink-0">
                  {c.score == null ? "—" : Math.round(c.score)}
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-2 border-t border-line pt-1.5 text-[11px] leading-relaxed text-muted">
            {reading.components.map((c) => (
              <div key={c.key}>· {c.fact}</div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-2 w-full rounded border border-line px-2 py-1 text-[11px] text-muted transition hover:bg-surface hover:text-fg"
          >
            收起
          </button>
        </div>
      ) : null}
    </div>
  );
}

export type { SentimentBand };
