/**
 * 这个文件是干什么的：
 * 收件箱的服务端接口（页面 loader 用）。
 */

import { createServerFn } from "@tanstack/react-start";
import { loadAlertInbox } from "./alert-store.ts";
import type { Alert } from "./alerts.ts";

/** 列收件箱，新的在前。 */
export const getAlerts = createServerFn({ method: "GET" }).handler(async (): Promise<Alert[]> => {
  const inbox = await loadAlertInbox();
  return [...inbox].sort((a, b) => b.at.localeCompare(a.at));
});
