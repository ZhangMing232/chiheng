/**
 * /today 买入矩阵的行分组（纯函数，2026-11-14）。
 *
 * 为什么单独成模块：矩阵分组是「哪些该占核心位置」的产品判断，
 * 需要能单测。React 路由文件是 .tsx，node --test 加载不了，
 * 所以把纯逻辑抽到 .ts 里（项目惯例：纯函数与源码 1:1 挨着且有测试）。
 *
 * 背景：实测 19 行矩阵里 8 行是短线腿观察行（528px，占 38% 高度），
 * 而短线腿所属策略已淘汰、这些票永远不会建仓。
 * 用户打开「今天买什么」却先看到一堆买不了的票——核心信息被稀释。
 */
/**
 * 把矩阵行分成「主矩阵（可操作）」和「观察名单（永不建仓）」两组（2026-11-14）。
 *
 * 为什么必须分开：实测 19 行矩阵里 8 行是短线腿的观察行（528px，占 38% 高度），
 * 而短线腿所属策略已淘汰（ACTIVE_STYLES 只剩 value），这些票**永远不会建仓**。
 * 用户打开「今天买什么」，却先看到一堆买不了的票——核心信息被稀释。
 *
 * 纪律：**分组不丢行**。两组加起来必须等于原行数，观察组折叠展示但一条不少。
 */
export function splitMatrixRows<T extends { observeOnly?: boolean }>(
  rows: T[],
): { actionable: T[]; observing: T[] } {
  return {
    actionable: rows.filter((r) => !r.observeOnly),
    observing: rows.filter((r) => r.observeOnly),
  };
}

