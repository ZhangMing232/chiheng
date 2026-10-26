/**
 * 市场情绪温度计——全站签名组件（《赤轨 UI 升级方案 2026-10》首页 Zone A 主视觉）。
 *
 * 形态：竖直温度计管（冷色在底、朱砂在顶的连续渐变，液柱高度=综合分）
 * + 管侧五档刻度（冰点/偏冷/温和/过热/沸点）+ 超大综合分 + 档位状态词
 * + 一句话市场事实 + ⓘ 计算说明弹层。
 * 首页第一眼必须是它：容器与普通 Panel 差异化（无面板头、衬线巨号、朱砂描边）。
 *
 * 纪律：
 * - 纯展示：计算在 lib/market/sentiment.ts，这里只渲染，计算逻辑不动。
 * - 数据全缺时渲染 Empty 态，绝不编造读数。
 * - 档位色是唯一彩色来源，色带冷→热与温度计语义一致。
 */

import { useState } from "react";
import {
  BAND_COLOR,
  BAND_ORDER,
  type SentimentReading,
} from "@/lib/market/sentiment";

/** 温度计管从底到顶的连续渐变：冰点蓝 → 沸点朱砂。 */
const TUBE_GRADIENT =
  "linear-gradient(to top, #5B8DB8 0%, #4FA3A0 22%, #B9A05A 45%, #E8894A 68%, #E64B33 100%)";

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
  const level = reading.score; // 0–100，液柱高度百分比

  return (
    <div className="relative flex gap-4 rounded border border-line bg-surface px-5 py-4">
      {/* 朱砂描边签——全卡唯一彩色边框，视觉重心 */}
      <span className="absolute top-3 bottom-3 left-0 w-[3px] rounded-full" style={{ background: BAND_COLOR[reading.band] }} aria-hidden />

      {/* 温度计管 + 五档刻度（固定高度，不被邻卡撑变形） */}
      <div className="flex shrink-0 items-center gap-2 self-center">
        <div className="relative h-36 w-4 overflow-hidden rounded-full bg-surface-2">
          <div
            className="absolute inset-x-0 bottom-0"
            style={{ height: `${level}%`, background: TUBE_GRADIENT }}
          />
          {/* 当前液面刻度线 */}
          <div
            className="absolute inset-x-[-3px] h-[2px] bg-fg"
            style={{ bottom: `calc(${level}% - 1px)` }}
            aria-hidden
          />
        </div>
        <div className="relative h-36 w-9 text-[10px] whitespace-nowrap text-muted">
          {BAND_ORDER.map((band, i) => {
            // 刻度位置：沸点在顶（100）、冰点在底（0）
            const top = 100 - (i * 100) / (BAND_ORDER.length - 1);
            const active = i === activeIdx;
            return (
              <span
                key={band}
                className="absolute left-0 flex items-center gap-1"
                style={{ top: `${top}%`, transform: "translateY(-50%)" }}
              >
                <span
                  className="inline-block size-1 shrink-0 rounded-full"
                  style={{ background: active ? BAND_COLOR[band] : "var(--color-line)" }}
                  aria-hidden
                />
                <span style={{ color: active ? BAND_COLOR[band] : undefined, fontWeight: active ? 600 : 400 }}>
                  {band}
                </span>
              </span>
            );
          })}
        </div>
      </div>

      {/* 读数区 */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="text-xs font-medium tracking-wide text-muted">市场情绪温度计</h3>
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

        <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="num font-display leading-none" style={{ fontSize: 56, fontWeight: 300, color: BAND_COLOR[reading.band] }}>
            {reading.score}
          </span>
          <span className="text-base font-medium" style={{ color: BAND_COLOR[reading.band] }}>
            {reading.band}
          </span>
        </div>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">{reading.line}</p>
      </div>

      {/* 计算说明弹层：分量、权重、真实数字、缺失说明。 */}
      {open ? (
        <div className="absolute top-10 right-3 left-3 z-20 rounded border border-line bg-surface-2 p-3 shadow-lg sm:left-auto sm:w-72">
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
                <span className="num shrink-0">{c.score == null ? "—" : Math.round(c.score)}</span>
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
