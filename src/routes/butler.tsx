/**
 * 这个文件是干什么的：
 * /butler 旧地址的重定向。2026-11-14 AI 板块重整：大管家整体搬进 AI 板块成为
 * 小机的「对话」档（/ai/chat），侧栏入口并入「AI 工作台」组——AI 只有一个家。
 *
 * 你需要知道的：
 * - 历史按用户存档（conversation-store），/ai/chat 读的是同一份，书签跳过去不丢对话。
 * - 这个文件只做重定向，别在这里加内容。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/butler")({
  beforeLoad: () => {
    throw redirect({ to: "/ai/chat" });
  },
});
