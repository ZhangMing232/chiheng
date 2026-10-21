/**
 * 这个文件是干什么的：
 * 钉住会员定价（pricing.ts）的口径——档位齐全、free/admin 无档位、
 * 人工授予文案在位。价格是「锁定价」的诚实口径：v1 没有硬权益闸，
 * blurb 不许把还没做的额度闸写成在售权益。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GRANT_FLOW_LINES, PAYMENT_CHANNEL_NOTE, tierOf, TIERS } from "@/lib/auth/pricing";

test("三档齐全：月 29 / 年 299 / 终身 999", () => {
  assert.deepEqual(
    TIERS.map((tier) => [tier.plan, tier.price]),
    [["pro-monthly", 29], ["pro-yearly", 299], ["lifetime", 999]],
  );
});

test("tierOf：在售 plan 找得到档位，free/admin/未知返回 null", () => {
  assert.equal(tierOf("pro-monthly")?.price, 29);
  assert.equal(tierOf("lifetime")?.period, "一次买断");
  assert.equal(tierOf("free"), null);
  assert.equal(tierOf("admin"), null);
  assert.equal(tierOf("不存在的档"), null);
  assert.equal(tierOf(null), null);
});

test("档位 plan 值都在 Better Auth 的 plan 词表里（授予脚本按它写）", async () => {
  const { PLANS } = await import("@/lib/auth/plan");
  for (const tier of TIERS) {
    assert.ok((PLANS as readonly string[]).includes(tier.plan), `${tier.plan} 不在 plan 词表`);
  }
});

test("人工授予流程三步都在，占位文案明说渠道未定（不装成已接入支付）", () => {
  assert.equal(GRANT_FLOW_LINES.length, 3);
  assert.match(GRANT_FLOW_LINES[0], /爱发电/);
  assert.match(GRANT_FLOW_LINES[1], /注册邮箱/);
  assert.match(GRANT_FLOW_LINES[2], /脚本/);
  assert.match(PAYMENT_CHANNEL_NOTE, /渠道待定/);
});

test("blurb 诚实口径：没把「额度闸」写成已在售的权益", () => {
  for (const tier of TIERS) {
    assert.doesNotMatch(tier.blurb, /已包含.*额度|立即解锁/);
  }
});
