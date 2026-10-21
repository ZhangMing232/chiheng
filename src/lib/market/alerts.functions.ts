/**
 * 这个文件是干什么的：
 * 收件箱的服务端接口（页面 loader 用）。
 *
 * 你需要知道的：
 * - 收件箱是**主人策略信号**经 PushPlus 推送的产物——里面的预警对应的是
 *   站长的模拟盘，不是访问者自己的。开放注册后人人能读 = 免费用户白嫖付费内容
 *   （design/MULTI-USER-AUDIT.md R3），所以只对主人（plan === "admin"）可见。
 * - 未来做「每用户自己的预警」时再按用户拆收件箱，那时这个闸改成数据级过滤。
 */

import { createServerFn } from "@tanstack/react-start";
import { loadAlertInbox } from "./alert-store.ts";
import type { Alert } from "./alerts.ts";

/** 列收件箱，新的在前。非主人返回空——不报错，页面空态即可。 */
export const getAlerts = createServerFn({ method: "GET" }).handler(async (): Promise<Alert[]> => {
  const { requirePrincipal } = await import("@/lib/auth/verify.server");
  const { isOwner } = await requirePrincipal();
  if (!isOwner) return [];
  const inbox = await loadAlertInbox();
  return [...inbox].sort((a, b) => b.at.localeCompare(a.at));
});
