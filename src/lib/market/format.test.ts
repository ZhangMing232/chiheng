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
import { fmtMoney, snapshotAge } from "@/lib/market/format";

test("快照多久了，说法要跟得上", () => {
  assert.equal(snapshotAge(2_000), "刚刚");
  assert.equal(snapshotAge(30_000), "30 秒前");
  assert.equal(snapshotAge(3 * 60_000), "3 分钟前");
  assert.equal(snapshotAge(2 * 3_600_000), "2 小时前");
});

test("系统时间往回跳时不能说出负数", () => {
  assert.equal(snapshotAge(-5_000), "刚刚");
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
