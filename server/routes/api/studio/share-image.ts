/**
 * 这个文件是干什么的：
 * 临时分享图的读取口——/api/studio/share-image?name=<file>.png。
 * 「推到手机」时图片要有一个公网 URL 才能嵌进微信消息，这里把落盘的 PNG 原样吐出。
 *
 * 安全口径：文件只在 data/studio-share/ 目录内按白名单文件名（时间戳-随机.png）取，
 * 不吃任意路径——分享图是 unlisted（知道链接就能看），但不是任意文件读取口。
 */

import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { defineEventHandler, getQuery, setHeader, setResponseStatus } from "h3";

const SHARE_DIR = join(process.cwd(), "data", "studio-share");

export default defineEventHandler(async (event) => {
  const name = String(getQuery(event).name ?? "");
  // 白名单：纯文件名（时间戳-随机.png），不带任何路径分隔符
  if (!/^\d+-[a-z0-9]+\.png$/.test(name)) {
    setResponseStatus(event, 400);
    return { ok: false as const, error: "非法文件名" };
  }
  const path = normalize(join(SHARE_DIR, name));
  if (!path.startsWith(SHARE_DIR)) {
    setResponseStatus(event, 400);
    return { ok: false as const, error: "非法路径" };
  }
  try {
    const buf = await readFile(path);
    setHeader(event, "content-type", "image/png");
    setHeader(event, "cache-control", "public, max-age=86400");
    return buf;
  } catch {
    setResponseStatus(event, 404);
    return { ok: false as const, error: "图不存在或已过期（7 天自动清理）" };
  }
});
