/**
 * 这个文件是干什么的：
 * PushPlus 微信推送。记账进程发现新预警（到止损/到卖出/到期该卖）时给主人推一条。
 *
 * 你需要知道的：
 * token 放在 data/push-config.json（{"token": "你的token"}），不进代码库、不进 git。
 * 没配 token 就静默跳过——推送是锦上添花，绝不能因为它失败把记账进程带崩。
 * 发送是 best-effort：超时 8 秒，失败只写一行日志。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type PushConfig = { token: string | null; baseUrl: string | null };

/** 读 PushPlus 配置；token/baseUrl 没配返回 null。导出给调用方用——它们想区分「推了」和「没 token 静默跳过」。 */
export async function readPushConfig(): Promise<PushConfig> {
  try {
    const parsed = JSON.parse(await readFile(join(process.cwd(), "data", "push-config.json"), "utf8"));
    const token = typeof parsed.token === "string" && parsed.token.trim() ? parsed.token.trim() : null;
    const baseUrl = typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim().replace(/\/$/, "") : null;
    return { token, baseUrl };
  } catch {
    return { token: null, baseUrl: null };
  }
}

/** 读 PushPlus token；没配返回 null。 */
export async function readPushToken(): Promise<string | null> {
  return (await readPushConfig()).token;
}

/**
 * 发一条 PushPlus 消息。title 是微信里看到的标题，content 支持换行；template=markdown 可嵌图片。
 *
 * 返回 true = 真的被 PushPlus 收了；false = 没 token / 被拒 / 超时。
 * **调用方必须用这个返回值决定打什么日志**——2026-10-28 之前它返回 void，
 * 几个脚本在外面无条件打「PushPlus 推送已发送」，于是日志里「发送失败」和「已发送」
 * 紧挨着出现，排查时被误导了一整轮。推没推出去是事实，不许猜。
 */
export async function sendPushPlus(
  title: string,
  content: string,
  template: "txt" | "markdown" = "txt",
): Promise<boolean> {
  const token = await readPushToken();
  if (!token) return false;
  try {
    const res = await fetch("http://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, title, content, template }),
      signal: AbortSignal.timeout(8_000),
    });
    const data = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null;
    if (!res.ok || (data && data.code !== 200)) {
      console.log(`pushplus 发送失败：${data?.msg ?? `HTTP ${res.status}`}`);
      return false;
    }
    return true;
  } catch (err) {
    console.log(`pushplus 发送失败：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
