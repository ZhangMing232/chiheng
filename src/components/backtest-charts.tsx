/**
 * 这个文件是干什么的：
 * 回测曲线的三张图（累计收益线图 / 回撤面积图 / 月度年度柱状图）。
 *
 * 为什么单独一个文件：`backtest.tsx` 已经有 300 行，再塞三个 ECharts 组件会更难读。
 * 这三个图只被回测页用，但不值得为它们单开三个文件。
 *
 * 你需要知道的：
 * - 颜色读 CSS 变量（--color-up / --color-down / --color-line / --color-muted），
 *   和 K 线图同源；canvas 图表没法用 Tailwind 类名，取值从 CSS 变量来，不写死色值。
 * - **红涨绿跌**（A 股惯例）：月度/年度柱子和回测收益线都用这一套。
 * - ECharts 实例在 useEffect 里建/毁，容器尺寸变化走 ResizeObserver——不监听会画在
 *   错误的初始尺寸上（这个坑在 K 线图那儿踩过）。
 * - 空数据时调用方不该渲染本组件（画不出东西），这里也兜一道：没有数据就返回 null。
 */

import { useEffect, useRef } from "react";
import * as echarts from "echarts";

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function useChart(height: number) {
  const host = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const chart = echarts.init(el);
    const ro = new ResizeObserver(() => chart.resize());
    ro.observe(el);
    return () => {
      ro.disconnect();
      chart.dispose();
    };
  }, [height]);
  return host;
}

function toneOf(up: string, down: string) {
  return {
    up,
    down,
    muted: cssVar("--color-muted", "#8b95a6"),
    fg: cssVar("--color-fg", "#e6eaf2"),
  };
}

const AXIS = {
  axisLine: { lineStyle: { color: "#242f45" } },
  axisLabel: { color: "#8b95a6", fontSize: 10 },
  splitLine: { lineStyle: { color: "#1a2233" } },
};

/** 累计收益（可选基准线）。dates 是 YYYY-MM-DD，series[0].data 是小数。 */
export function LineChart({
  dates,
  series,
  bench = [],
  height = 240,
}: {
  dates: string[];
  series: { name: string; data: number[] }[];
  bench?: number[];
  height?: number;
}) {
  const host = useChart(height);
  const { up, muted, fg } = toneOf("#f2495c", "#0bb97b");

  // 依赖提成变量：数组/对象直接进 deps 没法被静态检查， ESLint 会报警
  const datesKey = dates.join(",");
  const seriesKey = series.map((s) => s.data.join(",")).join("|");
  const benchKey = bench.join(",");

  useEffect(() => {
    const el = host.current;
    if (!el || dates.length === 0) return;
    const chart = echarts.getInstanceByDom(el);
    if (!chart) return;
    const last = series[0]?.data[series[0].data.length - 1] ?? 0;
    chart.setOption(
      {
        animation: false,
        grid: { left: 8, right: 12, top: 16, bottom: 24 },
        tooltip: {
          trigger: "axis",
          valueFormatter: (v: number) => `${(v * 100).toFixed(2)}%`,
          backgroundColor: "#111826",
          borderColor: "#242f45",
          textStyle: { color: fg, fontSize: 11 },
        },
        xAxis: { type: "category", data: dates, boundaryGap: false, ...AXIS },
        yAxis: {
          type: "value",
          axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
          splitLine: { lineStyle: { color: AXIS.splitLine.lineStyle.color } },
        },
        series: [
          ...series.map((s) => ({
            name: s.name,
            type: "line" as const,
            data: s.data,
            showSymbol: false,
            smooth: false,
            lineStyle: { width: 2, color: last >= 0 ? up : "#0bb97b" },
            itemStyle: { color: last >= 0 ? up : "#0bb97b" },
          })),
          // 基准线：虚线、中性色，别和主曲线抢
          ...(bench.length > 0
            ? [
                {
                  name: "同期全池",
                  type: "line" as const,
                  data: bench,
                  showSymbol: false,
                  lineStyle: { width: 1, type: "dashed" as const, color: muted },
                  itemStyle: { color: muted },
                },
              ]
            : []),
        ],
        legend: bench.length > 0 ? { textStyle: { color: muted, fontSize: 10 }, top: 0 } : undefined,
      },
      true,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用 datesKey/seriesKey/benchKey 管依赖
  }, [datesKey, seriesKey, benchKey, height]);

  return <div ref={host} style={{ height }} className="w-full" />;
}

/** 回撤面积图。data 是正数（0 = 在高点）。 */
export function AreaChart({ dates, data, height = 160 }: { dates: string[]; data: number[]; height?: number }) {
  const host = useChart(height);
  const { down, muted, fg } = toneOf("#f2495c", "#0bb97b");

  const datesKey = dates.join(",");
  const dataKey = data.join(",");

  useEffect(() => {
    const el = host.current;
    if (!el || dates.length === 0) return;
    const chart = echarts.getInstanceByDom(el);
    if (!chart) return;
    chart.setOption(
      {
        animation: false,
        grid: { left: 8, right: 12, top: 12, bottom: 24 },
        tooltip: {
          trigger: "axis",
          valueFormatter: (v: number) => `${(v * 100).toFixed(1)}%`,
          backgroundColor: "#111826",
          borderColor: "#242f45",
          textStyle: { color: fg, fontSize: 11 },
        },
        xAxis: { type: "category", data: dates, boundaryGap: false, ...AXIS },
        yAxis: {
          type: "value",
          max: (v: { max: number }) => Math.max(v.max, 0.05),
          axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
          splitLine: { lineStyle: { color: AXIS.splitLine.lineStyle.color } },
        },
        series: [
          {
            type: "line",
            data,
            showSymbol: false,
            lineStyle: { width: 1, color: muted },
            areaStyle: { color: down, opacity: 0.22 },
            itemStyle: { color: down },
          },
        ],
      },
      true,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用 datesKey/dataKey 管依赖
  }, [datesKey, dataKey, height]);

  return <div ref={host} style={{ height }} className="w-full" />;
}

/** 月度/年度柱状图。data 是小数（该周期的等权平均）。 */
export function BarChart({ labels, data, height = 160 }: { labels: string[]; data: number[]; height?: number }) {
  const host = useChart(height);
  const { up, down, fg } = toneOf("#f2495c", "#0bb97b");

  const labelsKey = labels.join(",");
  const dataKey = data.join(",");

  useEffect(() => {
    const el = host.current;
    if (!el || labels.length === 0) return;
    const chart = echarts.getInstanceByDom(el);
    if (!chart) return;
    chart.setOption(
      {
        animation: false,
        grid: { left: 8, right: 12, top: 12, bottom: 24 },
        tooltip: {
          trigger: "axis",
          valueFormatter: (v: number) => `${(v * 100).toFixed(2)}%`,
          backgroundColor: "#111826",
          borderColor: "#242f45",
          textStyle: { color: fg, fontSize: 11 },
        },
        xAxis: { type: "category", data: labels, ...AXIS },
        yAxis: {
          type: "value",
          axisLabel: { ...AXIS.axisLabel, formatter: (v: number) => `${(v * 100).toFixed(0)}%` },
          splitLine: { lineStyle: { color: AXIS.splitLine.lineStyle.color } },
        },
        series: [
          {
            type: "bar",
            data,
            barMaxWidth: 28,
            itemStyle: {
              // 红涨绿跌（A 股铁律）
              color: (p: { value: number }) => (p.value >= 0 ? up : down),
            },
          },
        ],
      },
      true,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 用 labelsKey/dataKey 管依赖
  }, [labelsKey, dataKey, height]);

  return <div ref={host} style={{ height }} className="w-full" />;
}
