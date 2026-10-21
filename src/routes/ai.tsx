/**
 * 这个文件是干什么的：
 * 「AI 管理」区的布局路由。2026-10-21 AI 管理页从「本地状态的 PageTabs」改成
 * 真实子页面。本文件只是 URL 层级（/ai 进化控制台、/ai/config 接口配置、
 * /ai/usage Token 用量、/ai/rules 闸门与判据），各子页面各自保留自己的 loader
 * 和 Frame；tab 条是 components/ai-panels.tsx 里的 AISectionTabs。
 *
 * 你需要知道的：
 * - 壳本身不渲染任何东西，原样透出 Outlet；侧栏 pinned 一个「AI 管理」入口。
 * - 两个层级的红线一样：AI 只许提议（表达式 / 参数旋钮），判决永远由预先
 *   登记的函数说了算——具体纪律见 factor-queue.ts 和 strategy-ai.ts 的文件头。
 */

import { createFileRoute, Outlet } from "@tanstack/react-router";

export const Route = createFileRoute("/ai")({
  component: function AILayout() {
    return <Outlet />;
  },
});
