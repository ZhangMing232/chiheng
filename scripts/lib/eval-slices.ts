/**
 * 统一策略评价器的六个切片定义（纯函数，无副作用）。
 *
 * 为什么要抽出来：`scripts/eval-robust.test.mjs` 原来靠「源码里必须出现
 * `BT_SAMPLE: "2646"` 这种字符串」来守门。2026-11-08 加了 BT_SAMPLE 环境变量
 * 覆盖（`S()` 辅助函数）之后，那条字符串断言就红了——**源码没坏，是断言太脆**。
 *
 * 抽成模块后，守门测试可以直接 import 它、真的把切片算出来看，
 * 而不是猜源码长什么样。这跟该项目 2026-11-08 全量体检的结论一致：
 * 纯源码字符串守门一重构就失效，要验证「真实接线 + 公共模块行为」。
 */

export type Slice = { name: string; env: Record<string, string> };

/**
 * 六个切片：
 *   全池·全区间 / 全池·前半段 / 全池·后半段 + 三批互不重叠的抽样。
 *
 * BT_SAMPLE 可整体覆盖（大样本先验证链路时用），默认全池 2646。
 */
export function buildSlices(env: Record<string, string | undefined> = process.env): Slice[] {
  const S = (n: string) => env.BT_SAMPLE ?? n;
  return [
    { name: "全池·全区间", env: { BT_SAMPLE: S("2646") } },
    { name: "全池·前半段", env: { BT_SAMPLE: S("2646"), BT_HALF: "first" } },
    { name: "全池·后半段", env: { BT_SAMPLE: S("2646"), BT_HALF: "second" } },
    { name: "抽样·批次0", env: { BT_SAMPLE: S("800"), BT_OFFSET: "0" } },
    { name: "抽样·批次1", env: { BT_SAMPLE: S("800"), BT_OFFSET: "1" } },
    { name: "抽样·批次2", env: { BT_SAMPLE: S("800"), BT_OFFSET: "2" } },
  ];
}
