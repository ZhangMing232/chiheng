/**
 * 这个文件是干什么的：
 * 每日复盘邮件配置的网页入口（/settings 页卡片）。以前要手改 data/mail-config.json，
 * 现在表单 POST 到服务端、由服务端落盘——用户不碰配置文件夹，值也不经过任何 AI 会话。
 *
 * 纪律（照 getPushStatus / saveAIProfile 的现成模式）：
 * - 只有主人（requirePrincipal().isOwner）能读状态、保存、发测试邮件。
 * - **授权码只进不出**：getMailStatus 只回「是否配置 + 尾四位」，完整值永不回传浏览器。
 * - 写入走 mail-config-store.ts（600 权限 + tmp/rename 原子写）；授权码留空 = 保留旧值。
 * - record-journal.ts 每分钟新起进程直读同一个文件，保存后立即生效，不用重启服务。
 */

import { createServerFn } from "@tanstack/react-start";
import {
  mergeInput,
  readRaw,
  statusOf,
  validateInput,
  writeRaw,
  type MailConfigInput,
} from "./mail-config-store.ts";

/** 当前配置状态。非主人只回 allowed:false，连配置字段都不给。 */
export const getMailStatus = createServerFn({ method: "GET" }).handler(async () => {
  const { requirePrincipal } = await import("@/lib/auth/verify.server");
  const { isOwner } = await requirePrincipal();
  if (!isOwner) return { allowed: false as const };
  // 只回「微信通道在不在」，token 本身绝不回传浏览器。
  const { readPushToken } = await import("./push.ts");
  const pushConfigured = Boolean(await readPushToken());
  // 上次收盘日报发没发出去。时间在服务端格式化成字符串，前端不解析 ISO（#418）。
  const { readDigestStatus, describeDelivery } = await import("./digest-status.ts");
  const lastDelivery = describeDelivery(await readDigestStatus());
  return { allowed: true as const, pushConfigured, lastDelivery, ...statusOf(await readRaw()) };
});

/** 保存配置。pass 留空沿用旧授权码；disable=true 清空授权码与收件人（停用）。 */
export const saveMailConfig = createServerFn({ method: "POST" })
  .validator((data: unknown): MailConfigInput => {
    const d = (data ?? {}) as Record<string, unknown>;
    return {
      host: typeof d.host === "string" ? d.host : "",
      port: typeof d.port === "number" ? d.port : Number.NaN,
      secure: typeof d.secure === "boolean" ? d.secure : true,
      user: typeof d.user === "string" ? d.user : "",
      pass: typeof d.pass === "string" ? d.pass : "",
      to: Array.isArray(d.to)
        ? d.to.filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        : [],
      from: typeof d.from === "string" ? d.from : "",
      timeoutMs: typeof d.timeoutMs === "number" ? d.timeoutMs : null,
      disable: d.disable === true,
    };
  })
  .handler(async ({ data }) => {
    const { requirePrincipal } = await import("@/lib/auth/verify.server");
    const { isOwner } = await requirePrincipal();
    if (!isOwner) throw new Error("只有主人账号能改邮件配置");

    const raw = await readRaw();
    const rawAuth = (raw.auth ?? {}) as Record<string, unknown>;
    const hasOldPass = typeof rawAuth.pass === "string" && rawAuth.pass.trim().length > 0;
    const why = validateInput(data, hasOldPass);
    if (why) throw new Error(why);

    await writeRaw(mergeInput(raw, data));
    return statusOf(await readRaw());
  });

/** 手动发一份测试日报，验证当前生效的通道真通——不用等下个交易日收盘。 */
export const sendTestMail = createServerFn({ method: "POST" }).handler(async () => {
  const { requirePrincipal } = await import("@/lib/auth/verify.server");
  const { isOwner } = await requirePrincipal();
  if (!isOwner) throw new Error("只有主人账号能发测试日报");
  const { sendDailyDigest } = await import("./daily-digest.ts");
  const date = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const result = await sendDailyDigest({ date, days: [] });
  return {
    sent: result.sent,
    channels: result.channels,
    status: result.status,
    reason: result.reason ?? (result.reasons.length > 0 ? result.reasons.join("；") : undefined),
  };
});
