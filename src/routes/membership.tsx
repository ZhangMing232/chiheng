/**
 * 这个文件是干什么的：
 * 会员页（/membership）——定价和开通流程的落点（design/MEMBERSHIP.md §三/§四）。
 * 顶栏账号徽章点进来：已登录看当前档位 + 三档定价 + 怎么开通；未登录先看
 * 注册登录入口。收款渠道拍板前走人工授予（爱发电付款 → 发注册邮箱 → 脚本开通），
 * 页面如实说清，不装成已接入自动支付。
 *
 * 你需要知道的：
 * 1. 定价只从 @/lib/auth/pricing 读，这里不手写数字——改价改那一处。
 * 2. v1 没有硬权益闸：付费当下买到的是「支持项目 + 锁定价 + 硬权益上线后自动
 *    拥有」。这句诚实口径写在页面上，不许把还没做的额度闸包装成在售权益。
 * 3. 「当前档位」对已付费用户标出 tierOf(plan)，对 admin 显示管理员（不出价格）。
 */

import { Link, createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { isAdmin, isPaidPlan, planLabel } from "@/lib/auth/plan";
import { GRANT_FLOW_LINES, PAYMENT_CHANNEL_NOTE, TIERS, tierOf } from "@/lib/auth/pricing";
import { useCurrentUserState } from "@/lib/auth/use-current-user";

export const Route = createFileRoute("/membership")({
  component: MembershipPage,
});

function MembershipPage() {
  const { user, isPending } = useCurrentUserState();
  if (isPending) return null;

  const plan = user?.plan ?? "free";
  const currentTier = tierOf(plan);

  return (
    <Frame aside="会员">
      {/* 当前档位 */}
      <Panel title="当前档位" bodyClassName="px-3.5 py-3">
        {user ? (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <span>{user.primaryEmail ?? user.displayName ?? user.id}</span>
            <span className="rounded bg-brand-soft px-1.5 py-0.5 text-xs font-medium text-brand-text">
              {isAdmin(plan) ? "管理员" : planLabel(plan)}
            </span>
            {currentTier ? (
              <span className="text-xs text-muted">
                {currentTier.label} · ¥{currentTier.price} / {currentTier.period}
              </span>
            ) : (
              <span className="text-xs text-muted">
                {isPaidPlan(plan) ? "档位已在词表外（数据异常，找店主）" : "免费版——下方升级支持项目开发"}
              </span>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
            <span className="text-muted">还没登录。</span>
            <Link to="/login" className="text-brand hover:underline">
              注册 / 登录
            </Link>
            <span className="text-xs text-muted">注册即免费版，升级在下方选档。</span>
          </div>
        )}
      </Panel>

      {/* 定价：渠道拍板前，每档都是「人工授予」流程，不装成已接入支付 */}
      <Panel
        title="定价"
        note={<span>锁定价 · 渠道拍板后接自动支付</span>}
        bodyClassName="px-3.5 py-3"
      >
        <div className="grid gap-2 sm:grid-cols-3">
          {TIERS.map((tier) => {
            const isCurrent = currentTier?.plan === tier.plan;
            return (
              <div
                key={tier.plan}
                className={
                  "rounded border p-3 " +
                  (isCurrent ? "border-brand bg-brand-soft/40" : "border-line bg-surface")
                }
              >
                <div className="flex items-baseline justify-between gap-2">
                  <h3 className="text-sm font-medium">{tier.label}</h3>
                  {isCurrent ? <span className="text-[11px] text-brand-text">当前档位</span> : null}
                </div>
                <p className="mt-1.5 text-lg font-semibold tabular-nums">
                  ¥{tier.price}
                  <span className="ml-1 text-xs font-normal text-muted">/ {tier.period}</span>
                </p>
                <p className="mt-1.5 text-xs leading-relaxed text-muted">{tier.blurb}</p>
                <button
                  type="button"
                  disabled
                  title={PAYMENT_CHANNEL_NOTE}
                  className="mt-2.5 w-full cursor-not-allowed rounded border border-line px-2 py-1.5 text-xs text-muted"
                >
                  自动支付接入中 · 现走人工授予
                </button>
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] leading-relaxed text-muted">{PAYMENT_CHANNEL_NOTE}</p>
      </Panel>

      {/* 开通流程 */}
      <Panel title="怎么开通" note={<span>人工授予 · 通常当天生效</span>} bodyClassName="px-3.5 py-3">
        <ol className="list-decimal space-y-1 pl-5 text-sm leading-relaxed">
          {GRANT_FLOW_LINES.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
        {!user ? (
          <p className="mt-2 text-xs text-muted">
            第 2 步要的注册邮箱，来自{" "}
            <Link to="/login" className="text-brand hover:underline">
              注册 / 登录
            </Link>
            ——先注册再付款，别反过来。
          </p>
        ) : null}
        <p className="mt-2 border-t border-line pt-2 text-[11px] leading-relaxed text-muted">
          v1 没有硬权益闸：付费当下买到的是「支持项目持续开发 + 锁定当前价 + 硬权益（AI 额度闸等）上线后自动拥有」。权益清单和闸的实现进度见 design/MEMBERSHIP.md。
        </p>
      </Panel>
    </Frame>
  );
}
