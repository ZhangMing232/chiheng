/**
 * 响应压缩中间件。
 *
 * 为什么有它：这个 Nitro 3 beta 没有内置 SSR 响应压缩，首页 HTML 里内嵌了
 * 全市场行情快照（约 1.2MB），裸传到手机端是「点击不动、很卡」的元凶之一
 * （2026-10-16 实测）。对 HTML / JSON 按 Accept-Encoding 做 gzip，
 * 1.2MB 压到约 250KB。
 *
 * 你需要知道的：
 * - 只压 GET、只压 text/html 和 application/json；小响应（<1KB）不压，免得得不偿失。
 * - 已是 content-encoding 的响应（静态资源若 Nitro 预压过）不碰。
 * - 压缩在内存里一次完成——本机服务每秒几个请求，1.2MB 缓冲没有压力；
 *   真成瓶颈再换流式压缩。
 */

import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);
const MIN_BYTES = 1024;

interface CompressEvent {
  req: { method: string; headers: Headers };
}

export default async function compressMiddleware(
  event: CompressEvent,
  next: () => unknown | Promise<unknown>,
): Promise<unknown> {
  if ((event.req.method ?? "GET").toUpperCase() !== "GET") return next();
  const accept = event.req.headers.get("accept-encoding") ?? "";
  if (!/\bgzip\b/.test(accept)) return next();

  const result = await next();
  if (!(result instanceof Response) || !result.body) return result;
  if (result.headers.has("content-encoding")) return result;
  const type = result.headers.get("content-type") ?? "";
  if (!type.includes("text/html") && !type.includes("application/json")) return result;

  const buf = Buffer.from(await result.arrayBuffer());
  if (buf.byteLength < MIN_BYTES) {
    // 原样返回：注意 body 已经被读掉了，要重新包一个 Response
    return new Response(new Uint8Array(buf), {
      status: result.status,
      statusText: result.statusText,
      headers: result.headers,
    });
  }
  const compressed = await gzipAsync(buf);
  const headers = new Headers(result.headers);
  headers.set("content-encoding", "gzip");
  headers.set("vary", "accept-encoding");
  headers.delete("content-length");
  return new Response(new Uint8Array(compressed), {
    status: result.status,
    statusText: result.statusText,
    headers,
  });
}
