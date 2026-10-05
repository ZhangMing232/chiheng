/**
 * 这个文件是干什么的：
 * 守住「行情出问题时必须把三句话说全」这条规矩。
 *
 * 你需要知道的：
 * 2026-10-05 下午主源降级，页面只显示「这套策略现在没有符合的股票」，
 * 看着像当天没机会，实际是数据源缺字段。那三小时是靠翻日志定位的。
 * 修法不是加一句话，是把「为什么 / 影响 / 什么时候恢复」做成硬结构——
 * 少写一条，这块 UI 就退回到"说了等于没说"的状态，而 typecheck 不会报。
 * 所以在这里把三条都钉住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { accountNotice, noticeOf, sourceLabel } from "@/lib/market/data-status";
import type { Universe } from "@/lib/market/types";

const base: Universe = {
  quotes: [{ id: "sh600519" } as never],
  asOf: Date.now(),
  total: 1,
  partial: false,
  stale: false,
  source: "tencent",
};

test("数据正常时不啰嗦，什么都不提示", () => {
  assert.equal(noticeOf(base), null);
  assert.equal(noticeOf(null), null);
  assert.equal(noticeOf({ ...base, quotes: [] }), null);
});

test("换到新浪要说全三句", () => {
  const n = noticeOf({ ...base, source: "sina" });
  assert.ok(n);
  assert.equal(n.label, "降级");
  // 三问缺一条就不算说完——这是这块 UI 存在的全部理由
  for (const field of [n.why, n.impact, n.recovery] as const) {
    assert.ok(field.length > 10, `「${field}」太短，等于没说`);
  }
  // 换源影响哪几套策略必须点出来，否则用户不知道今天该不该看盘
  assert.match(n.impact, /放量突破/);
  assert.match(n.impact, /中期反转/);
  // 也要说清不用做什么
  assert.match(n.recovery, /自动/);
});

test("用了旧数据要说清旧多久、影响什么", () => {
  const n = noticeOf({ ...base, stale: true, asOf: Date.now() - 8 * 60_000 });
  assert.ok(n);
  assert.equal(n.label, "过期");
  assert.match(n.why, /旧数据/);
  assert.match(n.recovery, /重新拉一次/);
});

test("只拉到一部分要说清排名会偏", () => {
  const n = noticeOf({ ...base, partial: true });
  assert.ok(n);
  assert.equal(n.label, "残缺");
  assert.match(n.impact, /排名/);
});

test("数据源的名字要说人话", () => {
  assert.equal(sourceLabel("tencent"), "腾讯");
  assert.equal(sourceLabel("sina"), "新浪财经");
  assert.equal(sourceLabel(undefined), "未知来源");
});

test("服务端账本没读到时，要说清「不是真的一笔没有」", () => {
  const n = accountNotice(false, "没登录或登录状态过期");
  assert.ok(n);
  assert.equal(n.label, "空账本");
  assert.match(n.why, /没读到/);
  // 这条最要紧：页面摆出一个全零账本，不说清的话会被当成「数据丢了」或者「今天没开仓」
  assert.match(n.impact, /不是「真的一笔没有」/);
  assert.match(n.recovery, /别照着 0 做判断/);
  // 读到的时候不该有任何提示
  assert.equal(accountNotice(true, null), null);
});
