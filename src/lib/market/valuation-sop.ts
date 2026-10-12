/**
 * 这个文件是干什么的：
 * 估值口径的可执行部分。手册是 `docs/VALUATION.md`，这里是它的代码形态。
 *
 * 为什么判读要由代码定、不让 AI 判：AI 会把「8 分位」说成「很便宜」，
 * 也可能把「PB 高 PE 低」这种周期底部特征读反。**规则能钉死的就别交给模型**——
 * 模型只负责把判读结果讲成人话。这也是赤轨和 Vibe-Research 的一个分工差异：
 * 它那边判读主要写在 SKILL.md 里靠提示词约束，赤轨把它变成可测的纯函数。
 *
 * 你需要知道的（纪律）：
 * 1. 判读只到「相对自身历史的位置 + 反证条件」，**不给贵贱的投资结论**
 *    （AI-BOUNDARY.md §0-3：只给数据、分析框架、情景概率、裁决点）。
 * 2. `null` = 样本不够或口径不全，此时调用方要写缺口，不许给一个中庸判读。
 */

/** 分位区间阈值。手册 §4 的判读表。 */
export const RANK_LOW = 20;
export const RANK_HIGH = 80;

export type ValuationJudgement = {
  /** 一句话判读（代码给的，不含动作） */
  verdict: string;
  /** 必须叠加的反证条件。空串 = 这一档没有额外警告 */
  caution: string;
};

/**
 * 按 PE/PB 分位给判读。
 *
 * 两边都 null → 返回 null（样本不够，调用方写缺口）。
 * 只有一边有 → 只按有的那一边判，并在 verdict 里说明另一个口径缺失。
 */
export function valuationJudgement(peRank: number | null, pbRank: number | null): ValuationJudgement | null {
  if (peRank == null && pbRank == null) return null;

  // 只有一边有数据：不拿相近口径顶替，明说缺哪个
  if (peRank == null || pbRank == null) {
    const have = peRank ?? pbRank;
    const which = peRank == null ? "PB" : "PE"; // 有值的是哪一个
    if (have! >= RANK_HIGH) {
      return {
        verdict: `只有 ${which} 分位可用（${have!.toFixed(0)} 分位），另一个口径没数据，判读不完整`,
        caution: "单一口径的极值可能是数据缺失造成的假信号，先补另一个口径再看",
      };
    }
    return { verdict: `只有 ${which} 分位可用（${have!.toFixed(0)} 分位），另一个口径没数据`, caution: "" };
  }

  const bothLow = peRank < RANK_LOW && pbRank < RANK_LOW;
  const bothHigh = peRank >= RANK_HIGH && pbRank >= RANK_HIGH;

  if (bothLow) {
    return {
      verdict: `PE 与 PB 都处在自身历史的低分位（${peRank.toFixed(0)} / ${pbRank.toFixed(0)} 分位）`,
      caution: "低分位不等于便宜：周期见顶前 E 在峰值，PE 会先变低。要确认这不是周期顶部特征",
    };
  }
  if (bothHigh) {
    return {
      verdict: `PE 与 PB 都处在自身历史的高分位（${peRank.toFixed(0)} / ${pbRank.toFixed(0)} 分位）`,
      caution: "高分位不等于贵：周期见底时 E 被压，PE 会先变高。要确认这不是周期底部特征",
    };
  }
  // PE 低但 PB 高：利润被压缩、资产没跌——典型周期底部，最容易被读反的一种
  if (peRank < RANK_LOW && pbRank >= RANK_HIGH) {
    return {
      verdict: `PE 分位低（${peRank.toFixed(0)}）但 PB 分位高（${pbRank.toFixed(0)}）`,
      caution: "这是利润被压缩、资产价格没跌的组合，典型周期底部特征。单独读成「便宜」会读反",
    };
  }
  if (peRank >= RANK_HIGH && pbRank < RANK_LOW) {
    return {
      verdict: `PE 分位高（${peRank.toFixed(0)}）但 PB 分位低（${pbRank.toFixed(0)}）`,
      caution: "利润端好但资产端被压低，要分清是盈利改善还是资产被重估，两者结论相反",
    };
  }
  return {
    verdict: `PE ${peRank.toFixed(0)} 分位、PB ${pbRank.toFixed(0)} 分位，处在自身历史的中段`,
    caution: "",
  };
}

/**
 * 注入 AI prompt 的估值口径段。
 *
 * 只写赤轨**真有的**判据；没有的（前瞻 PE / PEG / 一致预期）明确写成「不要提」，
 * 否则 AI 会拿训练记忆里的行业 PE 中枢来填空——那是编。
 */
export const VALUATION_SOP = [
  "## 估值口径（照 docs/VALUATION.md）",
  "1. 只报证据里有的口径：TTM PE（带历史分位）、PB、PS、PCF。分位样本不足 60 个交易日就是「算不出」，不许给中庸值。",
  "2. **低分位不等于便宜**：A 股周期股密度高，周期见顶前 PE 最低（E 在峰值）。任何「便宜」的说法必须附反证条件。",
  "3. **不许输出价格锚**：目标价、合理价、买入价、止损价一律不提。",
  "4. **赤轨没有的数据不许编**：扣非单季利润、一致预期 EPS、机构数、前瞻 CAGR、行业 PE 中枢——",
  "   这些赤轨都拿不到。AI 不许用记忆里的行业均值填空；需要就写「未获取」。",
  "5. 判读结论只到「相对自身历史的位置 + 该盯什么」，不给买卖建议。",
].join("\n");
