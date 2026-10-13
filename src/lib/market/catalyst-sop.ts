/**
 * 这个文件是干什么的：
 * 催化剂与风险的口径可执行部分。手册是 `docs/CATALYST-RISK.md`。
 *
 * 学 Vibe-Research 的 `catalyst-risk` SKILL.md（141 行），但把最值钱的那条
 * **代码化**了：它要求「裁决点 = 什么数据出来会改变判断，至少三个，每个带
 * 观察对象 / 阈值 / 来源与时点 / 触发后怎么变」。它靠提示词约束 AI 遵守，
 * 赤轨这边由 `decisionPointsFrom()` 从七阶段证据**直接推导**——
 * 每个研判报告一定有不低于 3 个裁决点，不靠模型记性。
 *
 * 你需要知道的（纪律）：
 * 1. **强结论必须先找反证**（它宪法 §1 第 5 问）。赤轨的落地方式是：判读结论
 *    标 `有依据的推断` 时必须带 caution，没有 caution 的推断不允许出现。
 * 2. 裁决点只写「看到什么就该重看一遍」，**不写该做什么**。
 * 3. 催化剂/风险都带来源和时点；写不出来源的不算催化剂，只算叙事（它 §0 第 2 条）。
 */

import type { StageResult, StageId } from "./research.ts";

/** 一个裁决点。四要素照它的 §3。 */
export type DecisionPoint = {
  /** 观察对象：具体指标或事件 */
  object: string;
  /** 阈值或方向 */
  threshold: string;
  /** 数据来源（接口/端点） */
  source: string;
  /** 下一次公开时点 */
  nextAt: string;
  /** 触发后判断怎么变 */
  effect: string;
  /** 由哪个阶段推导出来的，便于反查 */
  from: StageId;
};

/** 每个交易日收盘后更新——行情类裁决点的默认时点。 */
const TRADING_DAY = "每个交易日收盘后";

/**
 * 从七阶段推导裁决点。
 *
 * 只从**实际有证据**的阶段推导：某阶段没有证据就不出对应的裁决点，
 * 转而出一条「补数据」的裁决点——缺口本身也是要盯的东西。
 */
export function decisionPointsFrom(stages: readonly StageResult[]): DecisionPoint[] {
  const has = (id: StageId) => stages.find((s) => s.id === id);
  const out: DecisionPoint[] = [];

  const price = has("price");
  if (price && price.evidence.length > 0) {
    out.push({
      object: "近 20 日涨幅方向",
      threshold: "由负转正或由正转负（穿越 0）",
      source: "行情快照 d20（quotes.functions.ts:loadUniverse）",
      nextAt: TRADING_DAY,
      effect: "价格位置那一段的描述失效，需重跑研判",
      from: "price",
    });
  }

  const capital = has("capital");
  if (capital && capital.evidence.length > 0) {
    out.push({
      object: "主力净流入",
      threshold: "连续 3 个交易日同向（由流入转流出或反向）",
      source: "行情快照 inflow（当日主力净额）",
      nextAt: TRADING_DAY,
      effect: "资金那一段的结论失效；注意赤轨只有当日净额，缺历史序列",
      from: "capital",
    });
  }

  const catalyst = has("catalyst");
  if (catalyst && catalyst.evidence.length > 0) {
    out.push({
      object: "否决性公告",
      threshold: "出现退市、立案、业绩预告下修类措辞",
      source: "巨潮公告（cninfo.ts，法定披露平台）",
      nextAt: "公告发布当日（巨潮不定期披露）",
      effect: "催化剂那一段整体降级为「有重大未决事项」",
      from: "catalyst",
    });
  }

  const valuation = has("valuation");
  if (valuation && valuation.derived.length > 0) {
    out.push({
      object: "PE/PB 历史分位",
      threshold: "从当前档位穿越到相邻档位（低分位 ↔ 中段 ↔ 高分位）",
      source: "baostock 序列 + pe-history.ts:percentileRank",
      nextAt: "财报披露日或重跑 scripts/fetch-pe-history.py 之后",
      effect: "估值判读切换档位；注意分位低不等于便宜（周期顶 E 在峰值）",
      from: "valuation",
    });
  }

  // 缺口也是要盯的：补上数据本身就是一次「数据时点」
  for (const stage of stages) {
    if (stage.gaps.length > 0) {
      out.push({
        object: `${stage.title}的数据缺口`,
        threshold: `补上 ${stage.gaps.length} 项缺失中的任意一项`,
        source: stage.gaps[0]!.slice(0, 60),
        nextAt: "补齐后重跑研判",
        effect: `该阶段从「缺数据」变为可判，结论可能整体改变`,
        from: stage.id,
      });
      break; // 一条就够，列多了像免责声明
    }
  }

  return out;
}

/** 给 AI prompt 的反证与裁决点口径段。 */
export const CATALYST_SOP = [
  "## 催化剂与风险（照 docs/CATALYST-RISK.md）——注意这是**裁剪版**：预期型催化剂需要的",
  "一致预期修正方向和研报覆盖数、风险分类需要的融资融券/股东户数/解禁表，赤轨都没有。缺的那块是能力缺口。",
  "1. **强结论必须先找反证**：任何「充足 / 不是问题 / 确定」的说法，必须同时给出什么数据会推翻它。",
  "2. 催化剂必须带「类型 + 观察数据 + 下一次公开时点」；写不出来时点的不算催化剂，只算叙事，不要写。",
  "3. 风险按可观察的写：治理合规（公告）、周期顶（估值分位）、数据源冲突、数据缺口。",
  "4. **赤轨没有的数据不许编**：一致预期、研报覆盖数、融资余额、股东户数、解禁表——一律不写。",
  "5. 裁决点只写「看到什么就该重看一遍」，不写该做什么；「风险高」不等于卖，「催化剂多」不等于买。",
].join("\n");
