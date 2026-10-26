/**
 * 市场情绪温度计——综合分计算（纯函数，可测试）。
 *
 * 定位：首页「总览」的签名组件。五档：冰点 / 偏冷 / 温和 / 过热 / 沸点。
 * 纪律：
 * - 每个分量都必须有真实出处（涨跌家数来自全市场快照、指数来自指数行情、
 *   主力资金来自资金流向账本），分量缺失就降权重，不编数。
 * - 红涨绿跌是事实方向：分高=偏热（偏红系），分低=偏冷（偏蓝绿系）。
 *
 * 权重（写死，不事后调参）：
 * - 涨跌广度 0.4（最大权重，反映全市场赚钱效应）
 * - 涨跌停对比 0.2（情绪极值）
 * - 指数表现 0.3（大盘方向）
 * - 主力资金方向 0.1（辅助，单日快照噪声大所以权重最低）
 */

import type { Breadth } from "./slim-universe.ts";

export type SentimentBand = "冰点" | "偏冷" | "温和" | "过热" | "沸点";

export type SentimentComponent = {
  key: string;
  label: string;
  /** 0–100，null = 数据缺失 */
  score: number | null;
  weight: number;
  /** 一句话事实，给 ⓘ 弹层用，必须含真实数字 */
  fact: string;
};

export type SentimentReading = {
  /** 0–100 综合分；全部分量缺失时为 null */
  score: number | null;
  band: SentimentBand | null;
  /** 状态词：档位 + 市场事实的一句话 */
  line: string;
  components: SentimentComponent[];
  /** 综合分实际用到的权重合计（数据不全时 < 1，弹层里要说明） */
  weightUsed: number;
};

export const BAND_ORDER: SentimentBand[] = ["冰点", "偏冷", "温和", "过热", "沸点"];

export function bandOf(score: number): SentimentBand {
  if (score < 20) return "冰点";
  if (score < 40) return "偏冷";
  if (score < 60) return "温和";
  if (score < 80) return "过热";
  return "沸点";
}

/** 档位颜色（与 styles.css 的 accent/brand 同源，视觉规范的冷→热渐变）。 */
export const BAND_COLOR: Record<SentimentBand, string> = {
  冰点: "#5B8DB8",
  偏冷: "#4FA3A0",
  温和: "#B9A05A",
  过热: "#E8894A",
  沸点: "#E64B33",
};

/**
 * 计算市场情绪综合分。
 *
 * @param breadth   全市场涨跌家数（必须在宇宙快照瘦身前算）
 * @param indexPcts 各指数今日涨跌幅（%），至少一只才有意义
 * @param mainInflow 全市场主力净流入（万元），null = 资金流向不可用
 */
export function computeSentiment(
  breadth: Breadth,
  indexPcts: number[],
  mainInflow: number | null,
): SentimentReading {
  const traded = breadth.up + breadth.down;

  // 分量 1：涨跌广度。涨占比直接映射 0–100（50 = 涨跌各半）。
  const breadthScore = traded > 0 ? (breadth.up / traded) * 100 : null;

  // 分量 2：涨跌停对比。两极都没有按中性 50 算（不偏向任何一边）；
  // 但连一只交易的股票都没有（快照全空）说明数据没来，按缺失处理。
  const anyQuotes = traded + breadth.flat > 0;
  const limitScore = !anyQuotes
    ? null
    : breadth.limitUp + breadth.limitDown > 0
      ? (breadth.limitUp / (breadth.limitUp + breadth.limitDown)) * 100
      : 50;

  // 分量 3：指数平均涨跌幅，±2% 拉满 0–100（A 股指数单日 ±2% 已是强波动）。
  const avgPct = indexPcts.length
    ? indexPcts.reduce((a, b) => a + b, 0) / indexPcts.length
    : null;
  const indexScore = avgPct == null ? null : Math.min(100, Math.max(0, (avgPct / 2) * 50 + 50));

  // 分量 4：主力资金方向。只有单日快照，方向性权重：净流入偏热、净流出偏冷。
  const flowScore = mainInflow == null ? null : mainInflow > 0 ? 65 : mainInflow < 0 ? 35 : 50;

  const components: SentimentComponent[] = [
    {
      key: "breadth",
      label: "涨跌广度",
      score: breadthScore,
      weight: 0.4,
      fact:
        breadthScore == null
          ? "涨跌家数不可用"
          : `上涨 ${breadth.up} / 下跌 ${breadth.down} / 平盘 ${breadth.flat}`,
    },
    {
      key: "limit",
      label: "涨跌停",
      score: limitScore,
      weight: 0.2,
      fact:
        limitScore == null
          ? "涨跌停数据不可用"
          : breadth.limitUp + breadth.limitDown === 0
            ? "今日无涨跌停（按中性计）"
            : `涨停 ${breadth.limitUp} / 跌停 ${breadth.limitDown}`,
    },
    {
      key: "index",
      label: "指数表现",
      score: indexScore,
      weight: 0.3,
      fact:
        avgPct == null
          ? "指数行情不可用"
          : `主要指数平均 ${avgPct > 0 ? "+" : ""}${avgPct.toFixed(2)}%`,
    },
    {
      key: "flow",
      label: "主力资金",
      score: flowScore,
      weight: 0.1,
      fact:
        mainInflow == null
          ? "资金流向不可用"
          : `全市场主力净流入 ${(mainInflow / 10_000).toFixed(1)} 亿`,
    },
  ];

  const usable = components.filter((c) => c.score != null);
  const weightUsed = usable.reduce((sum, c) => sum + c.weight, 0);
  const score =
    weightUsed > 0
      ? usable.reduce((sum, c) => sum + c.score! * c.weight, 0) / weightUsed
      : null;
  const band = score == null ? null : bandOf(score);

  return {
    score: score == null ? null : Math.round(score),
    band,
    line: statusLine(band, breadth, avgPct),
    components,
    weightUsed,
  };
}

/** 状态一句话：档位 + 当天最硬的事实。 */
function statusLine(
  band: SentimentBand | null,
  breadth: Breadth,
  avgPct: number | null,
): string {
  if (band == null) return "情绪数据暂不可用";
  const traded = breadth.up + breadth.down;
  const winRate = traded > 0 ? Math.round((breadth.up / traded) * 100) : null;
  const facts: string[] = [];
  if (winRate != null) facts.push(`上涨家数占比 ${winRate}%`);
  if (breadth.limitUp + breadth.limitDown > 0) {
    facts.push(`涨停 ${breadth.limitUp} 跌停 ${breadth.limitDown}`);
  }
  if (avgPct != null) facts.push(`指数平均 ${avgPct > 0 ? "+" : ""}${avgPct.toFixed(2)}%`);
  return facts.length ? `${band}：${facts.join("，")}` : band;
}
