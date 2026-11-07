/**
 * 这个文件是干什么的：
 * 每日复盘日报的**分发层**。同一份内容（今日诊断 / 挑战者战况 / 明日验证）可以走
 * 邮件，也可以走 PushPlus 微信推送；配了哪个走哪个，都没配就静默跳过。
 *
 * 为什么加这一层（2026-11-07）：用户没有邮箱 SMTP 授权码，但早就配好了微信推送。
 * 授权码不是产品该强加的门槛——日报本身是可选钩子，不该逼人去邮箱后台开服务。
 *
 * 纪律：
 * - **推没推出去是事实，不许猜**（push.ts 那条血的教训）：只有通道真的返回成功
 *   才记进 channels；失败记 reasons，绝不因为"没报错"就当成功。
 * - token / 授权码只在本模块的服务端代码里用，不进返回值、不进日志、不进浏览器。
 * - best-effort：任何一个通道失败都不影响另一个，也不许把记账进程带崩。
 * - 只在服务端用（record-journal.ts 动态 import、mail.functions.ts handler 内动态
 *   import）；**别从前端组件静态 import**，否则会把 node:fs 带进客户端 graph 守门。
 */

import {
  collectDailyMail,
  readMailConfig,
  renderDailyMail,
  type MailBookDay,
  type MailConfig,
} from "./daily-mail.ts";
import { sendMail, type MailMessage } from "./smtp.ts";
import { readPushToken, sendPushPlus } from "./push.ts";

export type DigestChannel = "mail" | "wechat";
export type DigestStatus = "sent" | "none" | "failed";

export type DigestResult = {
  sent: boolean;
  /** 真的成功的通道；空数组 = 一条都没发出去 */
  channels: DigestChannel[];
  /** 每个失败通道的原因，供日志显眼报错 */
  reasons: string[];
  /** sent=有成功；none=一个通道都没配（调用方静默）；failed=配了但全失败（该重试） */
  status: DigestStatus;
  reason?: string;
};

export type RenderedDigest = { subject: string; text: string; html: string };

/** 可注入的发送依赖：把纯分发逻辑和真实网络分开，测试才钉得住「成功/失败」口径。 */
export type DigestDeps = {
  mailCfg: MailConfig | null;
  pushToken: string | null;
  sendMail: (cfg: MailConfig, msg: MailMessage) => Promise<void>;
  sendPush: (title: string, content: string) => Promise<boolean>;
};

function msgOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 纯分发：两个通道各自 best-effort，结果逐项记账。 */
export async function deliverDigest(rendered: RenderedDigest, deps: DigestDeps): Promise<DigestResult> {
  const channels: DigestChannel[] = [];
  const reasons: string[] = [];
  const jobs: Promise<void>[] = [];

  if (deps.mailCfg) {
    jobs.push(
      (async () => {
        try {
          await deps.sendMail(deps.mailCfg!, {
            from: deps.mailCfg!.from ?? deps.mailCfg!.auth.user,
            to: deps.mailCfg!.to,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
          });
          channels.push("mail");
        } catch (error) {
          reasons.push(`邮件：${msgOf(error)}`);
        }
      })(),
    );
  }

  if (deps.pushToken) {
    jobs.push(
      (async () => {
        const ok = await deps.sendPush(rendered.subject, rendered.text);
        if (ok) channels.push("wechat");
        else reasons.push("微信：PushPlus 没收（看 pushplus 日志）");
      })(),
    );
  }

  await Promise.all(jobs);

  if (jobs.length === 0) {
    return { sent: false, channels, reasons, status: "none", reason: "没配日报通道（邮件/PushPlus 微信都没配）" };
  }
  if (channels.length === 0) {
    return { sent: false, channels, reasons, status: "failed", reason: reasons.join("；") };
  }
  return {
    sent: true,
    channels,
    reasons,
    status: "sent",
    reason: reasons.length > 0 ? reasons.join("；") : undefined,
  };
}

/** 收集 + 渲染 + 按当前配置分发。收盘封印和网页「发测试日报」都走这里。 */
export async function sendDailyDigest(input: { date: string; days: MailBookDay[] }): Promise<DigestResult> {
  const [mailCfg, pushToken] = await Promise.all([readMailConfig(), readPushToken()]);
  const report = await collectDailyMail(input);
  const rendered = renderDailyMail(report);
  return deliverDigest(rendered, {
    mailCfg,
    pushToken,
    sendMail: (cfg, msg) => sendMail(cfg, msg),
    sendPush: (title, content) => sendPushPlus(title, content),
  });
}
