/**
 * 这个文件是干什么的：
 * 守住「快照多旧算旧」这句话的说法。
 *
 * 你需要知道的：
 * 这块 UI 是为了修一个真实的坑：主源降级那天页面只显示「没有符合的股票」，
 * 看着像没机会，实际是数据源缺字段。
 *
 * 这里只测纯函数，说人话的那部分在 `format.ts`。组件本身**测不了**：
 * 项目的测试跑在 `node --experimental-strip-types` 上，它不转译 JSX，
 * 而组件是 .tsx。所以组件的渲染结果只能靠 typecheck 加页面上肉眼确认。
 * 纯函数单独放出来就是为了让「多久前」这个算法能被自动守住。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { snapshotAge } from "@/lib/market/format";

test("快照多久了，说法要跟得上", () => {
  assert.equal(snapshotAge(2_000), "刚刚");
  assert.equal(snapshotAge(30_000), "30 秒前");
  assert.equal(snapshotAge(3 * 60_000), "3 分钟前");
  assert.equal(snapshotAge(2 * 3_600_000), "2 小时前");
});

test("系统时间往回跳时不能说出负数", () => {
  assert.equal(snapshotAge(-5_000), "刚刚");
});
