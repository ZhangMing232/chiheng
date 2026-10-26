/**
 * 这个文件是干什么的：
 * /reports 旧地址的重定向。2026-10-26 研报库并入「研究」区（/research/reports），
 * 本文件只留跳转，旧书签、外链不断链。
 */

import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/reports")({
  beforeLoad: () => {
    throw redirect({ to: "/research/reports" });
  },
});
