/**
 * 这个文件是干什么的：
 * 自媒体「AI 设计海报」的服务端入口（studio-ai.ts 管线的 HTTP 壳）。
 * POST { kind: "stock" | "sector", format: "vertical" | "square" } →
 * 拉真实资金账（loadFlow）→ AI 设计 SVG → 校验 → resvg 渲 PNG → dataURL 回前端。
 *
 * 为什么单独一个路由，不并进 /api/studio/poster：
 * - 那个是**纯模板渲染**（零成本、无 AI），这个是**烧 AI token** 的——权限口径不同。
 *
 * 你需要知道的：
 * 1. **owner-only**：每次调用都走 /ai 页配置的接口花钱（DSH 优先、直连兜底，
 *    记 ai-usage），和 testAIProfile 同一口径——只有主人账号能跑。和文案生成
 *    （generateStudioCaption，目前所有登录用户可跑）是**两个口径**，那个既有洞
 *    已知，不在本路由复制它。
 * 2. 校验两次不过返回 502，前端回退模板渲染（页面层处理），不给用户看假数图。
 */

import { defineEventHandler, readBody, setResponseStatus } from "h3";
import { loadFlow } from "../../../../src/lib/market/flow";
import { renderAIVersusPoster } from "../../../../src/lib/market/studio-ai";

type Body = { kind?: unknown; format?: unknown; direction?: unknown };

export default defineEventHandler(async (event) => {
  // 先身份闸：非主人直接 403，不碰数据也不碰 AI
  const { requirePrincipal } = await import("../../../../src/lib/auth/verify.server");
  const principal = await requirePrincipal().catch(() => null);
  if (!principal?.isOwner) {
    setResponseStatus(event, 403);
    return { ok: false as const, error: "AI 海报只有主人账号能生成（烧的是 /ai 页配置的接口额度）" };
  }

  const body = (await readBody<Body>(event).catch(() => ({}))) as Body;
  const kind = body?.kind === "sector" ? ("sector" as const) : ("stock" as const);
  const format = body?.format === "square" ? ("square" as const) : ("vertical" as const);
  // 委托人的设计要求（和设计师沟通累积的方向）。限长防注入垃圾：只是 prompt 的一段，
  // 进不了 facts，也不做逐字校验——审美约束靠模型自觉 + 重试收敛。
  const direction = typeof body?.direction === "string" ? body.direction.trim().slice(0, 1000) : "";

  const book = await loadFlow();
  try {
    const out = await renderAIVersusPoster(book, kind, format, direction ? { direction } : undefined);
    return {
      ok: true as const,
      dataUrl: "data:image/png;base64," + Buffer.from(out.png).toString("base64"),
      attempts: out.attempts,
      ms: out.ms,
    };
  } catch (error) {
    setResponseStatus(event, 502);
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
});
