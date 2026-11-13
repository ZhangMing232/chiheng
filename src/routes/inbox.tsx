/**
 * /inbox（消息与提醒）已下线（2026-11-13 用户要求删掉）。
 *
 * 为什么删：它是一个独立入口，但内容和侧栏「我的」组里的其它项重叠，
 * 且顶栏铃铛是它的第二个入口——违反「一个东西一个入口」。
 *
 * 提醒数据没有丢：data/signals/alerts.json 照常由 record-journal.ts 写入，
 * 需要看的时候直接读文件或调 getAlerts()。
 * 这个路由只做 307，别再把界面加回来。
 */
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/inbox")({
  beforeLoad: () => {
    throw redirect({ to: "/today" });
  },
});
