/**
 * 「现役策略」条只列在跑的——2026-11-05 用户点名的规矩，钉住别被改回去。
 *
 * 真实例子：2026-11-05 的 strategy-gates.json 里 breakout 是 disabled
 * （全池回测信噪比=-2.35，无 alpha），但 ACTIVE_STYLES 仍写着它，
 * 页面就把一张「已停用」黄卡摆在选股页开头。这块该只剩 value。
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { runningStyles, type GateLike } from "@/lib/ui/running-styles";

const ACTIVE = ["breakout", "value"] as const;

const stopped: GateLike = {
  state: "disabled",
  since: "2026-10-29",
  reason: "全池回测信噪比=-2.35，策略无 alpha",
};
const paroled: GateLike = {
  state: "paroled",
  since: "2026-10-23",
  reason: "冷却期结束，攒样本中",
};

test("没有闸门记录：现役的几套都留着", () => {
  assert.deepEqual(runningStyles(ACTIVE, {}), ["breakout", "value"]);
});

test("被停用的不上来：2026-11-05 的真实情形，只该剩低估值", () => {
  assert.deepEqual(runningStyles(ACTIVE, { breakout: stopped }), ["value"]);
});

test("假释中仍在建仓，算在跑，保留", () => {
  assert.deepEqual(runningStyles(ACTIVE, { breakout: paroled }), ["breakout", "value"]);
});

test("已下线策略的闸门记录不影响这块（它本来就不在 active 里）", () => {
  assert.deepEqual(runningStyles(ACTIVE, { rebound: stopped }), ["breakout", "value"]);
});

test("全被停用：返回空数组，调用方必须给空态而不是空白", () => {
  assert.deepEqual(runningStyles(ACTIVE, { breakout: stopped, value: stopped }), []);
});

test("守门：不许把 disabled 悄悄放回列表（反向验证改这里会炸）", () => {
  const got = runningStyles(ACTIVE, { breakout: stopped, value: paroled });
  assert.ok(!got.includes("breakout"), "disabled 的策略不该出现在现役策略条");
  assert.ok(got.includes("value"), "假释中的策略还在跑，不该被一起隐藏");
});
