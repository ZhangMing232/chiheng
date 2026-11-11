/**
 * /overview → /review/breadth 重定向。
 *
 * 2026-11-11 整合：用户要求把类似/重合的页面整合到一起。「涨跌分布」和「每日复盘」
 * 都是市场视图（指数/资金/快讯三块完全重复，只有 11 桶直方图是独有的），于是并进
 * 复盘区做「涨跌分布」子 tab，/review 成为完整的市场分析区。本地址保留重定向，
 * 书签和内链不断。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/overview")({
  beforeLoad: () => {
    throw redirect({ to: "/review/breadth", replace: true });
  },
});
