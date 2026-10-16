/**
 * 访问口令闸门（对标 Vibe-Research 的「带口令链接」远程访问）。
 *
 * 为什么有它：2026-10-17 起赤轨要通过域名（meanwhy.top + Cloudflare Tunnel）
 * 公网开放。数据是私人的（策略、模拟盘、笔记），公网裸奔不可接受。
 * 参考 Vibe 的形态：一道共享口令，输对一次管 30 天，不引入整套邮箱账号体系。
 *
 * 你需要知道的：
 * - 用环境变量 CHIHENG_GATE_PASS 启用：**不设 = 完全不启用**（本机现状不变）。
 *   设置后所有非回环（127.0.0.1 / ::1）请求都要先过闸门。
 * - 回环请求豁免：本机脚本、冒烟测试（scripts/smoke-test.mjs）不受影响。
 *   注意 Cloudflare Tunnel 的回环连接会带 cf-connecting-ip，按真实访客 IP 判，不豁免。
 * - Cookie 值 = 签发时间戳 + HMAC-SHA256，HMAC 密钥派生自口令本身；
 *   不保存口令明文，改口令即刻全部门禁失效。恒时比较防时序探测。
 * - 登录页完全自包含（内联样式、零外链资源），静态资源也一道闸门挡着，
 *   没口令的人连 JS 文件都拿不到。
 */

import { createHmac, timingSafeEqual } from "node:crypto";

const COOKIE_NAME = "chiheng_gate";
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const GATE_PATH = "/__gate";

interface GateEvent {
  url: URL;
  req: { method: string; headers: Headers };
  node?: { req?: { socket?: { remoteAddress?: string } } };
}

function gatePass(): string {
  return (process.env.CHIHENG_GATE_PASS ?? "").trim();
}

function hmacOf(ts: string, pass: string): string {
  return createHmac("sha256", createHmac("sha256", "chiheng-gate-key").update(pass).digest())
    .update(ts)
    .digest("hex");
}

function cookieValue(pass: string): string {
  const ts = String(Date.now());
  return `${ts}.${hmacOf(ts, pass)}`;
}

function cookieValid(value: string | undefined, pass: string): boolean {
  if (!value) return false;
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;
  const ts = value.slice(0, dot);
  const mac = value.slice(dot + 1);
  // 过期检查
  const ageMs = Date.now() - Number(ts);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > COOKIE_MAX_AGE_S * 1000) return false;
  // 恒时比较
  const expect = hmacOf(ts, pass);
  const a = Buffer.from(mac.padEnd(64, "0").slice(0, 64));
  const b = Buffer.from(expect);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLoopback(event: GateEvent): boolean {
  // Cloudflare Tunnel 场景：cloudflared 从本机回环转发请求，socket 上的 remoteAddress
  // 是 127.0.0.1，但会原样带上 cf-connecting-ip（真实访客 IP）。此时必须按 cf-connecting-ip
  // 判定，否则走隧道的公网请求会被误豁免、口令形同虚设。
  const cfIp = event.req.headers.get("cf-connecting-ip");
  const ip = (cfIp ?? event.node?.req?.socket?.remoteAddress ?? "").trim();
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1" || ip.endsWith("127.0.0.1");
}

function loginPage(error: string | null): Response {
  const err = error ? `<p class="err">${error}</p>` : "";
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>赤轨 · 访问口令</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
       background:#0d1117;color:#e6edf3;font-family:-apple-system,"PingFang SC",sans-serif}
  form{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:32px;
       width:min(320px,80vw);box-shadow:0 8px 30px rgba(0,0,0,.4)}
  h1{font-size:18px;margin:0 0 6px;letter-spacing:2px}
  p.sub{font-size:12px;color:#8b949e;margin:0 0 20px}
  input{width:100%;box-sizing:border-box;padding:10px 12px;border-radius:8px;
        border:1px solid #30363d;background:#0d1117;color:#e6edf3;font-size:15px;
        outline:none;margin-bottom:14px}
  input:focus{border-color:#d4382c}
  button{width:100%;padding:10px;border:0;border-radius:8px;background:#d4382c;
         color:#fff;font-size:15px;cursor:pointer}
  p.err{color:#f85149;font-size:13px;margin:0 0 12px}
</style></head><body>
<form method="post" action="${GATE_PATH}">
  <h1>赤轨</h1>
  <p class="sub">私人研究系统，请输入访问口令</p>
  ${err}
  <input type="password" name="pass" autofocus autocomplete="current-password" placeholder="访问口令">
  <button type="submit">进 入</button>
</form></body></html>`;
  return new Response(html, {
    status: error ? 401 : 200,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

export default async function gateMiddleware(event: GateEvent, next: () => unknown | Promise<unknown>): Promise<unknown> {
  const pass = gatePass();
  if (!pass) return next(); // 未启用：现状不变
  if (isLoopback(event)) return next();

  const path = event.url.pathname;

  // 口令提交端点
  if (path === GATE_PATH) {
    if ((event.req.method ?? "GET").toUpperCase() !== "POST") return loginPage(null);
    const body = await readBody(event);
    const input = new URLSearchParams(body).get("pass") ?? "";
    if (input.trim() === pass) {
      const secure = (event.req.headers.get("x-forwarded-proto") ?? "") === "https";
      return new Response(null, {
        status: 302,
        headers: {
          location: "/",
          "set-cookie": `${COOKIE_NAME}=${cookieValue(pass)}; Path=/; Max-Age=${COOKIE_MAX_AGE_S}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`,
          "cache-control": "no-store",
        },
      });
    }
    return loginPage("口令不对");
  }

  // 已有有效 cookie 放行
  const cookieHeader = event.req.headers.get("cookie") ?? "";
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (cookieValid(match?.[1], pass)) return next();

  // 其余请求一律挡在登录页（API / 静态资源也不例外）
  if (path.startsWith("/_server/") || path.startsWith("/api/")) {
    return new Response(JSON.stringify({ error: "gate" }), {
      status: 401,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return loginPage(null);
}

async function readBody(event: GateEvent): Promise<string> {
  // 优先走 Fetch Request 的 body；读不到再兜底 node 流
  const reqAny = event.req as unknown as { text?: () => Promise<string> };
  if (typeof reqAny.text === "function") {
    try {
      return await reqAny.text();
    } catch {
      // fall through to node stream
    }
  }
  interface NodeStream {
    on(event: "data", cb: (c: Buffer) => void): void;
    on(event: "end", cb: () => void): void;
  }
  const nodeReq = event.node?.req as unknown as NodeStream | undefined;
  if (!nodeReq?.on) return "";
  const chunks: Buffer[] = [];
  await new Promise<void>((resolve) => {
    nodeReq.on("data", (c) => chunks.push(c));
    nodeReq.on("end", () => resolve());
  });
  return Buffer.concat(chunks).toString("utf8");
}
