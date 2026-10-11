/** factor-test-runner 的测试：参数边界是防「界面上填出一只妖怪回测」的唯一闸。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PARAM_BOUNDS, sanitizeParams } from "./factor-test-runner.ts";

test("合法参数原样通过", () => {
  assert.deepEqual(sanitizeParams({ n: 20, buckets: 5, sample: 300, offset: 1 }), {
    n: 20,
    buckets: 5,
    sample: 300,
    offset: 1,
  });
});

test("范围外的直接拒：NaN/缺项/超界都不夹带私货改值", () => {
  assert.throws(() => sanitizeParams({ n: 0, buckets: 5, sample: 300, offset: 0 }), /n 必须在/);
  assert.throws(() => sanitizeParams({ n: 61, buckets: 5, sample: 300, offset: 0 }), /n 必须在/);
  assert.throws(() => sanitizeParams({ n: 3, buckets: 5, sample: 49, offset: 0 }), /sample/);
  assert.throws(() => sanitizeParams({ n: 3, buckets: 5, offset: 0 }), /sample/);
  assert.throws(() => sanitizeParams(null), /必须在/);
});

test("选项表本身必须在硬边界内（控件选项和边界不能脱节）", () => {
  for (const key of Object.keys(PARAM_BOUNDS) as (keyof typeof PARAM_BOUNDS)[]) {
    const b = PARAM_BOUNDS[key];
    for (const opt of b.options) {
      assert.ok(opt >= b.min && opt <= b.max, `${key} 的快捷档 ${opt} 超出 ${b.min}~${b.max}`);
    }
  }
});
