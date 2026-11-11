/**
 * 这个文件是干什么的：
 * 题材「下一个可能热门」的**前瞻观察口径**，纯函数、零 IO，首页与 /review/theme 共用。
 *
 * 2026-11-11 用户拍板废除「不预测」定位后，前瞻判断必须逐条标证据等级，
 * 不能只给一个「可观察延续」就完事。三条判据的统计地位来自 design/DECISIONS.md：
 * - 情绪过热（均涨幅 ≥7%）：追高连板已证伪，三连板+ −3.71%/t−10.19 → **已验证（反向）**；
 * - 梯队健康（涨停 ≥10 且均 ≥3）：只是结构描述，没有样本外验证 → **待验证**；
 * - 题材补涨候选：+0.06%/t+0.63（6855 笔）→ **噪声级**，不当买入信号。
 *
 * 纪律：这是情景判断，不是确定结论，也不是买卖动作建议（red-line.ts 红线不变）。
 */

/** 结构类型，避免把 .functions.ts（server-only）拖进客户端模块图。 */
export type ThemeShape = { avg: number; limitUp: number };
export type EvidenceLevel = "已验证" | "待验证" | "噪声级";
export type ContinuationReading = {
  label: string;
  tone: "up" | "down" | "warn" | "muted";
  evidence: EvidenceLevel;
  /** 一句话把证据说清，页面必须显示，不许只显示 label */
  basis: string;
};

export function continuationOf(r: ThemeShape): ContinuationReading {
  if (r.avg >= 7) {
    return {
      label: "情绪过热 · 追高风险",
      tone: "warn",
      evidence: "已验证",
      basis: "板越高次日越亏：三连板+ 每笔 −3.71%，t=−10.19，六切片 6/6 全负",
    };
  }
  if (r.limitUp >= 10 && r.avg >= 3) {
    return {
      label: "梯队健康 · 可观察延续",
      tone: "up",
      evidence: "待验证",
      basis: "结构描述，缺题材热度历史样本，尚未做样本外验证",
    };
  }
  if (r.limitUp < 3) {
    return {
      label: "梯队分散",
      tone: "muted",
      evidence: "待验证",
      basis: "零星涨停不成势；无历史样本可判延续性",
    };
  }
  return {
    label: "中性",
    tone: "muted",
    evidence: "待验证",
    basis: "既不过热也不成势，缺历史样本",
  };
}

/** 题材补涨候选的证据等级：判死过，只能当观察名单。 */
export const LAGGARD_EVIDENCE = {
  level: "噪声级" as EvidenceLevel,
  basis: "题材补涨全池 +0.06% / t+0.63（6855 笔），两半段互相抵消，无优势",
};
