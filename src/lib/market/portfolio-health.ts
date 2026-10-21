/**
 * 这个文件是干什么的：
 * 持仓体检——学 Vibe-Research 的 portfolio health check：不开新功能、不预测，
 * 只对「现在拿着的这一摞票」做几条规则体检，把组合级的风险（集中度、行业暴露、
 * 连亏、数据缺口）摆到面上。
 *
 * 你需要知道的：
 * 1. **口径和 positions.ts 完全一致**：这套模拟盘不记仓位大小，每笔按一手
 *    （100 股）折算名义金额。下面的「占比」全是名义金额占比，不是投入的真钱比例——
 *    页面上也这么写，不许让人以为算出了真实仓位。
 * 2. 全是规则，不依赖 AI：每只票现价 × 100 股算出名义金额，然后数数、加总、
 *    比阈值。AI 可以读结果去解释，但体检本身必须是确定性的——不然和算命没区别。
 * 3. 纯函数零 I/O：行情、行业、估值分位都由调用方（持仓页 loader）查好传进来，
 *    这里只算。查不到的就是 null，对应检查项如实降级（报价缺失本身是体检内容）。
 * 4. 每条检查是独立的 HealthCheck：level（ok/info/warn）+ 标题 + 细节。
 *    全绿也要返回一条「体检通过」——面板不能因为没问题就消失，「检查过、没问题」
 *    和「没检查」在界面上必须长得不一样。
 */

import { SHARES_PER_LOT, type PositionRow } from "@/lib/market/positions";

export type HealthCheck = { level: "ok" | "info" | "warn"; title: string; detail: string };

export type HealthInput = {
  /** 账本摊平的持仓行（buildRows 的输出），只用到 id/name/exit。 */
  rows: Pick<PositionRow, "id" | "name" | "exit">[];
  /** 现价：拿不到（停牌/快照缺口）返回 null。 */
  priceOf: (id: string) => number | null;
  /** 行业名（最细层）：没分类返回 null。可选——不传就跳过行业检查。 */
  industryNameOf?: (id: string) => string | null;
  /** PE 历史分位 0-100：没有历史返回 null。可选——不传就跳过估值检查。 */
  peRankOf?: (id: string) => number | null;
  /**
   * 按天净收益（已实现+浮动），最新一天在末尾。用来查连亏。
   * 持仓页传的是「按开仓日分组的合计盈亏」——不是日历日，连亏指的是
   * 「连续几个开仓日整体亏钱」，口径在页面上写清。
   */
  dayNet?: number[] | null;
};

const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;

/** 组合体检。返回按严重程度排序的检查列表（warn > info > ok）。 */
export function healthChecks(input: HealthInput): HealthCheck[] {
  const checks: HealthCheck[] = [];
  const open = input.rows.filter((row) => row.exit == null);

  if (open.length === 0) {
    // 空仓时其余检查都没意义，但「检查过」这件事要留痕。
    return [{ level: "info", title: "无持仓", detail: "当前没有未平仓的票，组合级风险无从谈起。" }];
  }

  // 名义金额：现价 × 一手。拿不到现价的单只计 0，并单独记数据缺口。
  const notionals = new Map<string, number>();
  let missing = 0;
  for (const row of open) {
    const price = input.priceOf(row.id);
    if (price == null || !(price > 0)) {
      missing += 1;
      notionals.set(row.id, 0);
    } else {
      notionals.set(row.id, price * SHARES_PER_LOT);
    }
  }
  const totalNotional = [...notionals.values()].reduce((sum, value) => sum + value, 0);

  // ① 持仓只数：超过盯盘上限。一手一笔的模拟盘，拿得越多越没人看得过来。
  if (open.length >= 10) {
    checks.push({ level: "warn", title: "持仓只数偏多", detail: `未平仓 ${open.length} 只，超出盯盘上限（10 只）。到价要动的票一多，漏处理的概率比赚钱的概率先涨。` });
  } else if (open.length >= 6) {
    checks.push({ level: "info", title: "持仓只数接近上限", detail: `未平仓 ${open.length} 只（上限 10）。还开新仓前先想清楚哪只先出。` });
  } else {
    checks.push({ level: "ok", title: "持仓只数", detail: `未平仓 ${open.length} 只，在盯盘上限内。` });
  }

  // ② 集中度：名义金额口径。单票和前三合计各给一个阈值。
  if (totalNotional > 0) {
    const sorted = [...notionals.entries()].sort((a, b) => b[1] - a[1]);
    const top1 = sorted[0];
    const top1Pct = top1[1] / totalNotional;
    const top3Pct = sorted.slice(0, 3).reduce((sum, [, value]) => sum + value, 0) / totalNotional;
    if (top1Pct > 0.4) {
      checks.push({ level: "warn", title: "单票集中度过高", detail: `${nameOf(input, top1[0])} 占名义金额 ${pct(top1Pct)}，超过 40%。这只票动一下，组合跟着大动。` });
    } else if (top1Pct > 0.25) {
      checks.push({ level: "info", title: "单票集中度偏高", detail: `${nameOf(input, top1[0])} 占名义金额 ${pct(top1Pct)}，超过 25%。不算危险，但别再加。` });
    } else {
      checks.push({ level: "ok", title: "单票集中度", detail: `最大单票占名义金额 ${pct(top1Pct)}。` });
    }
    if (top3Pct > 0.7) {
      checks.push({ level: "warn", title: "前三票集中度过高", detail: `名义金额前三合计占 ${pct(top3Pct)}，超过 70%。组合实质上押在三只票上。` });
    }
  }

  // ③ 行业暴露：同一行业名义占比超半。模拟盘同涨同跌多半是同行业带来的。
  if (input.industryNameOf) {
    const byIndustry = new Map<string, number>();
    let unclassified = 0;
    for (const row of open) {
      const name = input.industryNameOf(row.id);
      if (name == null) {
        unclassified += notionals.get(row.id) ?? 0;
        continue;
      }
      byIndustry.set(name, (byIndustry.get(name) ?? 0) + (notionals.get(row.id) ?? 0));
    }
    let worst: [string, number] | null = null;
    for (const entry of byIndustry) {
      if (!worst || entry[1] > worst[1]) worst = entry;
    }
    if (worst && totalNotional > 0 && worst[1] / totalNotional > 0.5) {
      checks.push({
        level: "warn",
        title: "行业暴露集中",
        detail: `${worst[0]} 占名义金额 ${pct(worst[1] / totalNotional)}，超过 50%。板块一回调，组合没有别的地方对冲。`,
      });
    } else if (worst && totalNotional > 0) {
      checks.push({ level: "ok", title: "行业暴露", detail: `最大行业（${worst[0]}）占名义金额 ${pct(worst[1] / totalNotional)}，未超 50%。` });
    }
    if (unclassified > 0 && totalNotional > 0 && unclassified / totalNotional > 0.3) {
      checks.push({ level: "info", title: "部分持仓无行业分类", detail: `${pct(unclassified / totalNotional)} 的名义金额没查到行业归属，上面的行业分布偏乐观。` });
    }
  }

  // ④ 报价缺失：持仓拿不到现价。浮动盈亏和止损监控都建立在现价上，缺口要看见。
  if (missing > 0) {
    checks.push({
      level: "warn",
      title: "行情数据缺口",
      detail: `${missing}/${open.length} 只持仓拿不到现价（停牌或快照没拉到）。这些票的浮动和止损监控是失明的，上面的占比也把这些票当成了 0。`,
    });
  } else {
    checks.push({ level: "ok", title: "行情完整", detail: `${open.length} 只持仓全部有现价。` });
  }

  // ⑤ 高估值分位：分位高 ≠ 贵错了，只是赔率窄——措辞必须中性，不替人下买卖结论。
  if (input.peRankOf) {
    const high = open.filter((row) => {
      const rank = input.peRankOf?.(row.id);
      return rank != null && rank >= 80;
    });
    if (high.length >= 3) {
      checks.push({
        level: "warn",
        title: "高估值分位的票偏多",
        detail: `${high.length} 只持仓 PE 分位 ≥ 80（历史 5 年里的高位）：${high.map((row) => row.name).join("、")}。分位高不等于该卖，只是向上空间窄、回撤容错小。`,
      });
    } else if (high.length > 0) {
      checks.push({ level: "info", title: "个别票估值分位偏高", detail: `${high.map((row) => row.name).join("、")} 的 PE 分位 ≥ 80，留意赔率。` });
    } else {
      checks.push({ level: "ok", title: "估值分位", detail: "没有持仓站在 PE 历史高分位（≥80）。" });
    }
  }

  // ⑥ 连亏：dayNet 尾部连续为负的天数。空仓日不进序列（调用方传的就是有交易的天）。
  if (input.dayNet && input.dayNet.length > 0) {
    let streak = 0;
    for (let i = input.dayNet.length - 1; i >= 0; i -= 1) {
      if (input.dayNet[i] < 0) streak += 1;
      else break;
    }
    if (streak >= 3) {
      checks.push({ level: "warn", title: "连亏", detail: `最近 ${streak} 个开仓日整体为负。先别急着改参数——对照指数看是系统性回撤还是这套打法失灵，两者的对策完全不同。` });
    } else if (streak > 0) {
      checks.push({ level: "info", title: "最近一日亏损", detail: `最近 ${streak} 个开仓日为负，还在正常波动范围。` });
    } else {
      checks.push({ level: "ok", title: "近期盈亏", detail: "最近一个开仓日整体不为负。" });
    }
  }

  // 全绿时留一条「通过」，「查过没问题」和「没查」要长得不一样。
  if (checks.every((check) => check.level === "ok")) {
    checks.push({ level: "ok", title: "体检通过", detail: "以上各维度都在阈值内。阈值是规则不是真理，觉得紧/松可以调。" });
  }

  const order = { warn: 0, info: 1, ok: 2 };
  return checks.sort((a, b) => order[a.level] - order[b.level]);
}

function nameOf(input: HealthInput, id: string): string {
  return input.rows.find((row) => row.id === id)?.name ?? id;
}
