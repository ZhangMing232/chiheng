/**
 * 这个文件是干什么的：
 * 「推到手机」——把 /studio 生成的图文经 PushPlus 推到主人微信。
 * POST { title?, text?, imageDataUrl? } → 图存 data/studio-share/（拿一个公网可访问的
 * 链接）→ PushPlus markdown 消息（文案全文 + 内嵌图片）→ 微信里直接看图发文。
 *
 * 你需要知道的：
 * 1. owner-only（同 ai-poster 口径）：推送用的是主人自己配的 PushPlus token，
 *    只能推给主人自己，给别人推没意义。
 * 2. 图片要能嵌进微信消息，必须有一个公网 URL——所以先落盘到本地，再用
 *    data/push-config.json 里的 baseUrl（如 https://meanwhy.top）拼访问链接。
 *    没配 baseUrl 就退化为只推文案 + 链接说明。
 * 3. share 目录定期自清（只留 7 天）——这些图是临时载体，不是归档。
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineEventHandler, getRequestHost, getRequestProtocol, readBody, setResponseStatus } from "h3";
import { readPushConfig } from "../../../../src/lib/market/push";

const SHARE_DIR = join(process.cwd(), "data", "studio-share");
const KEEP_MS = 7 * 24 * 3600 * 1000;

type Body = { title?: unknown; text?: unknown; imageDataUrl?: unknown };

/** 落盘 PNG，返回文件名；顺带清掉 7 天前的旧图。 */
async function saveShareImage(dataUrl: string): Promise<string> {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new Error("图片格式不对（要 PNG dataURL）");
  await mkdir(SHARE_DIR, { recursive: true });
  const name = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
  await writeFile(join(SHARE_DIR, name), Buffer.from(m[1]!, "base64"));
  // 7 天前的是临时载体的垃圾，顺手清
  const now = Date.now();
  for (const f of await readdir(SHARE_DIR).catch(() => [] as string[])) {
    const ts = Number(/^(\d+)-/.exec(f)?.[1]);
    if (ts && now - ts > KEEP_MS) await rm(join(SHARE_DIR, f)).catch(() => undefined);
  }
  return name;
}

export default defineEventHandler(async (event) => {
  const { requirePrincipal } = await import("../../../../src/lib/auth/verify.server");
  const principal = await requirePrincipal().catch(() => null);
  if (!principal?.isOwner) {
    setResponseStatus(event, 403);
    return { ok: false as const, error: "推送只有主人账号能用（推送到的是你绑定的微信）" };
  }

  const body = (await readBody<Body>(event).catch(() => ({}))) as Body;
  const text = typeof body?.text === "string" ? body.text.trim().slice(0, 4000) : "";
  const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, 60) : "赤轨图文";
  if (!text && typeof body?.imageDataUrl !== "string") {
    setResponseStatus(event, 400);
    return { ok: false as const, error: "没有可推送的内容（文案和图片至少给一个）" };
  }

  const cfg = await readPushConfig();
  if (!cfg.token) {
    setResponseStatus(event, 400);
    return { ok: false as const, error: "还没配 PushPlus token（data/push-config.json 的 token 字段）" };
  }

  // 公网基址：优先配置文件 baseUrl；没有就用请求来源（局域网/本机打开时链接只在本机有效）
  const base = cfg.baseUrl ?? `${getRequestProtocol(event)}://${getRequestHost(event)}`;

  let imageName = "";
  if (typeof body?.imageDataUrl === "string" && body.imageDataUrl) {
    try {
      imageName = await saveShareImage(body.imageDataUrl);
    } catch (e) {
      setResponseStatus(event, 500);
      return { ok: false as const, error: `图片保存失败：${e instanceof Error ? e.message : String(e)}` };
    }
  }

  const imageUrl = imageName && base ? `${base}/api/studio/share-image?name=${encodeURIComponent(imageName)}` : "";
  const content = [
    text,
    imageUrl ? `![配图](${imageUrl})` : "",
    imageUrl ? `[图片打不开？点此查看](${imageUrl})` : "",
    !imageUrl && imageName ? "（图片已生成，但当前访问地址不是公网域名，微信里可能打不开；在赤轨 /studio 页可直接下载）" : "",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    const res = await fetch("http://www.pushplus.plus/send", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: cfg.token, title, content, template: "markdown" }),
      signal: AbortSignal.timeout(8_000),
    });
    const data = (await res.json().catch(() => null)) as { code?: number; msg?: string } | null;
    if (!res.ok || (data && data.code !== 200)) {
      setResponseStatus(event, 502);
      return { ok: false as const, error: `PushPlus 拒绝：${data?.msg ?? `HTTP ${res.status}`}` };
    }
    return { ok: true as const };
  } catch (e) {
    setResponseStatus(event, 502);
    return { ok: false as const, error: `推送没发出去：${e instanceof Error ? e.message : String(e)}` };
  }
});
