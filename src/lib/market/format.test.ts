/**
 * 这个文件是干什么的：
 * 守住「快照多旧算旧」这句话的说法。
 *
 * 你需要知道的：
 * 这块 UI 是为了修一个真实的坑：主源降级那天页面只显示「没有符合的股票」，
 * 看着像没机会，实际是数据源缺字段。
 *
 * 只测这个纯函数，组件本身测不了：测试跑在 `node --experimental-strip-types` 上，
 * 它不转译 JSX，而组件是 .tsx。所以「多久前」这个算法必须单独放在 .ts 里，
 * 否则就只能靠肉眼。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { fmtMoney, snapshotAge, snapshotAgeSince } from "@/lib/market/format";

test("快照多久了，说法要跟得上", () => {
  assert.equal(snapshotAge(2_000), "刚刚");
  assert.equal(snapshotAge(30_000), "30 秒前");
  assert.equal(snapshotAge(3 * 60_000), "3 分钟前");
  assert.equal(snapshotAge(2 * 3_600_000), "2 小时前");
});

test("系统时间往回跳时不能说出负数", () => {
  assert.equal(snapshotAge(-5_000), "刚刚");
});

test("🔴 时间戳要自己减：/settings 曾把时间戳当差值，显示「498351 小时前」", () => {
  const now = Date.parse("2026-11-07T23:03:21+08:00");
  const at = Date.parse("2026-11-07T23:03:10+08:00");
  assert.equal(snapshotAgeSince(at, now), "11 秒前");
  assert.equal(snapshotAgeSince(now - 2_000, now), "刚刚");
  assert.equal(snapshotAgeSince(now - 5 * 60_000, now), "5 分钟前");
  assert.equal(snapshotAgeSince(null, now), null);
  assert.equal(snapshotAgeSince(Number.NaN, now), null);
  // 反证：直接把绝对时间戳塞给 snapshotAge(ms) 会得到荒谬的大数——旧 bug 的样子
  assert.match(snapshotAge(at), /\d{5,} 小时前/);
});

test("金额要能一眼看出量级", () => {
  assert.equal(fmtMoney(null), "—");
  assert.equal(fmtMoney(Number.NaN), "—");
  // 一万以下带千分位
  assert.equal(fmtMoney(3050), "3,050");
  // 一万以上缩写成「万」
  assert.equal(fmtMoney(30500), "3.05 万");
  // 亿
  assert.equal(fmtMoney(2.5e8), "2.50 亿");
  // 负数照常
  assert.equal(fmtMoney(-30500), "-3.05 万");
});
