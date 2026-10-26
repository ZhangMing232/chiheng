/**
 * 这个文件是干什么的：
 * /debate 旧地址的重定向。2026-10-26 多空辩论并入「研究」区（/research/debate），
 * 本文件只留跳转，旧书签、外链不断链；原带的 ?q= 参数原样传过去。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/debate")({
  beforeLoad: ({ search }) => {
    const q = typeof (search as Record<string, unknown>).q === "string"
      ? (search as Record<string, unknown>).q as string
      : "";
    throw redirect({ to: "/research/debate", search: { q } });
  },
});
