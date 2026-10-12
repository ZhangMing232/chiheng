/**
 * 这个文件是干什么的：
 * K 线蜡烛图组件（ECharts）。蜡烛 + 成交量副图 + MA5/MA10，红涨绿跌。
 *
 * 你需要知道的：
 * - ECharts 实例在 useEffect 里建/毁，容器尺寸变化（抽屉滑出、窗口缩放）走
 *   ResizeObserver 调 resize()——不监听会画在错误的初始尺寸上（抽屉里是 0 宽）。
 * - 颜色读 CSS 变量（--color-up / --color-down / --color-line / --color-muted），
 *   和全站语义 token 同源；canvas 图表没法用 Tailwind 类名，这是 UI-STANDARD
 *   第 1 节允许的裸值场合，取值仍从 CSS 变量来，不写死色值。
 * - 不学 Vibe 的 glass 视觉，只学它的信息结构（蜡烛+量+均线三件套）。
 */

import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import { buildCandles, maOf } from "@/lib/market/kline-series";

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** 蜡烛图。bars 不足两根时调用方不该渲染本组件（画不出东西）。 */
export function KlineChart({ bars, height = 280 }: { bars: { date: string; o: number; c: number; h: number; l: number; v: number }[]; height?: number }) {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const up = cssVar("--color-up", "#f2495c"); // 红涨（A 股铁律，fallback = styles.css 的 token 值）
    const down = cssVar("--color-down", "#0bb97b"); // 绿跌
    const line = cssVar("--color-line", "#242f45");
    const muted = cssVar("--color-muted", "#8b95a6");

    const candles = buildCandles(bars);
    const closes = candles.map((c) => c.value[1]);
    const ma5 = maOf(closes, 5);
    const ma10 = maOf(closes, 10);

    const chart = echarts.init(el);
    chart.setOption({
      animation: false,
      grid: [
        { left: 8, right: 8, top: 12, height: "58%" },
        { left: 8, right: 8, top: "72%", height: "18%" },
      ],
      axisPointer: { link: [{ xAxisIndex: "all" }] },
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "cross" },
        // 数值两位小数；量用万手口语（v 是股数，东财/腾讯都按股）
        valueFormatter: (v: unknown) => (typeof v === "number" ? v.toFixed(2) : "—"),
      },
      xAxis: [
        {
          type: "category",
          data: candles.map((c) => c.date.slice(5)),
          gridIndex: 0,
          axisLine: { lineStyle: { color: line } },
          axisLabel: { color: muted, fontSize: 10 },
          splitLine: { show: false },
        },
        { type: "category", data: candles.map((c) => c.date.slice(5)), gridIndex: 1, axisLabel: { show: false }, axisTick: { show: false } },
      ],
      yAxis: [
        {
          scale: true,
          gridIndex: 0,
          position: "right",
          axisLabel: { color: muted, fontSize: 10 },
          splitLine: { lineStyle: { color: line, opacity: 0.4 } },
        },
        { scale: true, gridIndex: 1, position: "right", axisLabel: { show: false }, splitLine: { show: false } },
      ],
      series: [
        {
          name: "日K",
          type: "candlestick",
          data: candles.map((c) => c.value),
          itemStyle: {
            // 逐根着色：阳用 up（红），阴用 down（绿）。color=阳线，color0=阴线
            color: up,
            color0: down,
            borderColor: up,
            borderColor0: down,
          },
        },
        {
          name: "MA5",
          type: "line",
          data: ma5,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1, color: muted },
        },
        {
          name: "MA10",
          type: "line",
          data: ma10,
          smooth: true,
          showSymbol: false,
          lineStyle: { width: 1, color: line, opacity: 0.9 },
        },
        {
          name: "量",
          type: "bar",
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: candles.map((c) => ({ value: c.volume, itemStyle: { color: c.up ? up : down, opacity: 0.55 } })),
        },
      ],
    });

    const observer = new ResizeObserver(() => chart.resize());
    observer.observe(el);
    return () => {
      observer.disconnect();
      chart.dispose();
    };
  }, [bars]);

  return <div ref={host} style={{ height }} className="w-full" />;
}
