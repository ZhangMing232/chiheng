/**
 * 这个文件是干什么的：
 * AI 工作台的布局路由。2026-11-14 重整后是六个真实子页面：
 * /ai 概览、/ai/chat 对话、/ai/agent 岗位、/ai/config 大脑、/ai/usage 账目、
 * /ai/rules 法条。各子页面各自保留自己的 loader 和 Frame；tab 条是
 * components/ai-panels.tsx 里的 AISectionTabs。
 *
 * 你需要知道的：
 * - 壳本身不渲染任何东西，原样透出 Outlet；侧栏只 pinned 一个「AI 工作台」入口。
 * - 两个层级的红线一样：AI 只许提议（表达式 / 参数旋钮），判决永远由预先
 *   登记的函数说了算——具体纪律见 factor-queue.ts 和 strategy-ai.ts 的文件头。
 */

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/ai")({
  component: function AILayout() {
    return <Outlet />;
  },
});
