/**
 * 这个文件是干什么的：
 * 会员定价的单一事实来源（design/MEMBERSHIP.md §三）。会员页、未来的支付回调、
 * 授予脚本都从这儿读档位，别在各处手写 ¥29/¥299/¥999——改价只改这一处。
 *
 * 你需要知道的：
 * 1. **渠道留空**：收款渠道还没拍板（等老板），所以这里只有「档位 + 价格 +
 *    人工授予流程说明」。支付回调接上后，给 tier 加 channel 字段即可，页面渲染
 *    已经按「有链接出按钮、没链接出说明」写了。
 * 2. 价格是「锁定价」的诚实口径：v1 没有硬权益闸（MEMBERSHIP.md §四），付费
 *    当下买到的是「支持项目 + 锁定当前价 + 硬权益上线后自动拥有」。blurb 里
 *    必须这么说，不许把还没做的额度闸写成在售权益。
 * 3. 纯函数零 I/O，能自动测。
 */

import type { Plan } from "@/lib/auth/plan";

export type Tier = {
  /** 对应 user.plan 的值（授予脚本按这个写）。 */
  plan: Exclude<Plan, "free" | "admin">;
  /** 展示名。 */
  label: string;
  /** 价格（元，整数）。 */
  price: number;
  /** 周期说明。 */
  period: string;
  /** 一句话卖点（诚实口径，见文件头 2）。 */
  blurb: string;
};

export const TIERS: Tier[] = [
  {
    plan: "pro-monthly",
    label: "专业版 · 月付",
    price: 29,
    period: "每月",
    blurb: "支持项目持续开发；硬权益（AI 额度闸等）上线后自动拥有，随时可停。",
  },
  {
    plan: "pro-yearly",
    label: "专业版 · 年付",
    price: 299,
    period: "每年",
    blurb: "≈ 2.5 个月免费；同一权益，按年锁价。",
  },
  {
    plan: "lifetime",
    label: "终身版",
    price: 999,
    period: "一次买断",
    blurb: "所有未来上线的会员权益终身可用；早期支持者锁定价。",
  },
];

/** 按 plan 找档位；free/admin 没有档位（null）。 */
export function tierOf(plan: string | null | undefined): Tier | null {
  return TIERS.find((tier) => tier.plan === plan) ?? null;
}

/**
 * 人工授予流程说明（v1 收款方式，MEMBERSHIP.md §三）：
 * 渠道拍板前，用户按这个流程开通——付款 → 发注册邮箱 → 老板跑 grant-plan 脚本。
 * 文案集中在这里，页面只渲染，别在 JSX 里再写一遍。
 */
export const GRANT_FLOW_LINES: string[] = [
  "在下方档位里选一个，去爱发电完成付款（渠道链接拍板后替换这里）。",
  "付款后把你的注册邮箱发给店主（爱发电私信即可）。",
  "店主核验后跑开通脚本，plan 立即生效——刷新页面徽章就变。",
];

/** 渠道没拍板前的占位文案：页面照常说清流程，不装成已接入支付。 */
export const PAYMENT_CHANNEL_NOTE =
  "自动支付还没接入（收款渠道待定）：现在走人工授予——通常当天开通。";
