/**
 * 这个文件是干什么的：
 * 钉住 wyckoff-spring.ts 的行为。这个文件存在的核心理由是**两条无前视测试**——
 * Spring 检测要在滚动窗口里回看 60 天，一个不小心用到了 i 之后的数据，
 * 统计上的表现只是「因子偶尔不触发」，人眼看不出来、统计也归因不到。
 *
 * 另外两条「正例」测试同时也是**防静默失效**的护栏：
 *   - 区间低点窗口若误写成含 j（`[j-59, j]`），depth 恒 ≤ 0，正例会直接不触发而失败；
 *   - 均量窗口若误写成含 j，放量日的量比恒等于 1，「放量」断言会失败。
 * 这两类 bug 都不会报错，只是让因子安静地失效，所以必须用测试钉死。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { detectWyckoffSpring, isSpringAt, DEPTH_MAX, VOL_WIN, type SpringBar } from "@/lib/market/wyckoff-spring";

/**
 * 造一段可控 K 线：在 100 附近小幅波动（l 最低到 99.7）。
 * 波动是必要的——如果每天的 l 都一样，区间低点就等于当天的 l，测不出跌破。
 */
function makeBars(n: number): SpringBar[] {
  const out: SpringBar[] = [];
  for (let i = 0; i < n; i += 1) {
    const c = 100 + (i % 3) * 0.2;
    out.push({ o: c, c, h: c + 0.3, l: c - 0.3, v: 1000 });
  }
  return out;
}

/** 一个教科书式的 Spring：跌破区间下沿后放量拉回，留长下影。 */
const SPRING: SpringBar = { o: 100.5, c: 100.2, h: 100.6, l: 98.0, v: 4000 };

function withSpringAt(j: number): SpringBar[] {
  const bars = makeBars(200);
  bars[j] = { ...SPRING };
  return bars;
}

test("正例：跌破区间下沿后放量拉回，判定为 Spring", () => {
  const j = 150;
  const hit = isSpringAt(withSpringAt(j), j, 10);
  assert.ok(hit, "构造的数据应该触发 Spring");
  // 区间低点 = 99.7，当日最低 98.0 → 跌破约 1.7%
  assert.ok(hit.depth > 0.015 && hit.depth < 0.018, `跌破深度应约 1.7%，实际 ${hit.depth}`);
  assert.ok(hit.wick > 0.8, `下影线占比应 >0.8，实际 ${hit.wick}`);
});

test("放量日的量比必须 >1.5（若均量窗口误含今日，这里会等于 1 而失败）", () => {
  const j = 150;
  const bars = makeBars(200);
  // 确认构造数据本身拉开了均量和今日量，否则这条测试没有意义
  const avgBefore = bars.slice(j - VOL_WIN, j).reduce((s, b) => s + b.v, 0) / VOL_WIN;
  assert.equal(avgBefore, 1000, "前 20 日均量应为 1000");
  assert.notEqual(SPRING.v, avgBefore, "今日量和均量必须不同，否则测不出窗口问题");

  const hit = isSpringAt(withSpringAt(j), j, 10);
  assert.ok(hit);
  // 4000 / 1000 = 4.0，被 VOL_RATIO_CAP 封到 2.0。含今日的话这里会正好等于 1.0。
  assert.equal(hit.volRatio, 2, "量比应被封顶到 VOL_RATIO_CAP=2");
});

test("🔴 无前视①：把 K 线截断到 i 重算，结果必须完全相等", () => {
  const full = withSpringAt(150);
  for (const i of [150, 151, 155, 160]) {
    assert.deepEqual(
      detectWyckoffSpring(full, i, 10),
      detectWyckoffSpring(full.slice(0, i + 1), i, 10),
      `i=${i} 截断后结果变了 → 检测用到了 i 之后的数据`,
    );
  }
});

test("🔴 无前视②：把 i 之后的数据全换成垃圾值，i 的结果不能变", () => {
  const base = withSpringAt(150);
  const polluted = base.map((b, k) => (k <= 155 ? b : { o: 1, c: 999, h: 1000, l: 0.01, v: 1e9 }));
  assert.deepEqual(detectWyckoffSpring(base, 155, 10), detectWyckoffSpring(polluted, 155, 10));
});

test("数据质量闸：跌破超过 8% 的脏 bar 必须被挡掉", () => {
  // 已知真实脏 bar：sh601091 2026-09-18 的 o=15 c=57.77（单日 +177%），反向也可能有
  const bars = makeBars(200);
  bars[150] = { o: 15, c: 57.77, h: 82.59, l: 14.68, v: 1881071 };
  assert.equal(isSpringAt(bars, 150, 10), null, "depth 超过上限的脏 bar 必须是 null");
  assert.ok(DEPTH_MAX < 0.5, "上限应当是数据质量闸而不是经济逻辑闸");
});

test("跌停封死穿下沿要排除——威科夫里那是 SC 破坏，语义与 Spring 相反", () => {
  const j = 150;
  const bars = makeBars(200);
  // 把区间压平到 110，再让第 j 天封死跌停到 99（跌破前 60 日的 109.7）
  for (let k = j - 60; k < j; k += 1) bars[k] = { o: 110, c: 110, h: 111, l: 109, v: 1000 };
  const dn = Math.round(110 * 0.9 * 100) / 100;
  bars[j] = { o: 110, c: dn, h: dn, l: dn - 0.5, v: 4000 };
  assert.equal(isSpringAt(bars, j, 10), null, "封死跌停穿下沿应被排除");
});

test("时效衰减：同一个 Spring，越往后取值强度越低，且 age 记录正确", () => {
  const bars = withSpringAt(150);
  const fresh = detectWyckoffSpring(bars, 150, 10);
  const later = detectWyckoffSpring(bars, 155, 10);
  assert.ok(fresh && later, "两个时点都应该能检出这个 Spring");
  assert.equal(fresh.age, 0);
  assert.equal(later.age, 5, "第 155 天看，Spring 发生在 5 天前");
  assert.ok(later.strength < fresh.strength, "age=5 的强度应被衰减");
});

test("边界：数据不足或没有 Spring 时返回 null，不是 0", () => {
  // null 和 0 必须分清：0 会被读成「强度为零」，而真相是「没 Spring」
  assert.equal(detectWyckoffSpring(makeBars(30), 10, 10), null, "数据不足");
  assert.equal(detectWyckoffSpring(makeBars(200), 10, 10), null, "没有任何 Spring");
  assert.equal(detectWyckoffSpring(makeBars(200), 199, 10), null, "最后一天不该凭空有 Spring");
});