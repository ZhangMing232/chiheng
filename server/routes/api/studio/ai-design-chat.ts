/**
 * 这个文件是干什么的：
 * 「AI 设计沟通」接口——委托人像跟真人设计师一样聊设计方向。
 * POST { kind, messages: [{role:"user"|"assistant", content}] } →
 * 拉真实资金账 → 设计师看着数据回一段设计建议（纯文字，不出 SVG）。
 *
 * 为什么单独一个路由：
 * - 它烧 AI token（同 ai-poster 的 owner-only 口径），但产出是文字不是图——
 *   前端聊天面板专用。设计师拿得到真实数据块，建议会落在实际内容上。
 *
 * 你需要知道的：
 * - messages 由客户端保管（页面状态），服务端无会话——刷新即新会话，简单可靠。
 * - 最后一条应是委托人的话；服务端原样拼接对话记录，不做角色扮演校正。
 */

import { defineEventHandler, readBody, setResponseStatus } from "h3";
import { loadFlow } from "../../../../src/lib/market/flow";
import { chatWithDesigner, type DesignMessage } from "../../../../src/lib/market/studio-ai";

type Body = { kind?: unknown; messages?: unknown };

function sanitizeMessages(raw: unknown): DesignMessage[] | null {
  if (!Array.isArray(raw)) return null;
  const out: DesignMessage[] = [];
  for (const m of raw.slice(-20)) {
    if (typeof m !== "object" || m === null) continue;
    const { role, content } = m as { role?: unknown; content?: unknown };
    if ((role === "user" || role === "assistant") && typeof content === "string" && content.trim()) {
      out.push({ role, content: content.trim().slice(0, 1000) });
    }
  }
  return out.length ? out : null;
}

export default defineEventHandler(async (event) => {
  const { requirePrincipal } = await import("../../../../src/lib/auth/verify.server");
  const principal = await requirePrincipal().catch(() => null);
  if (!principal?.isOwner) {
    setResponseStatus(event, 403);
    return { ok: false as const, error: "设计沟通只有主人账号能用（烧的是 /ai 页配置的接口额度）" };
  }

  const body = (await readBody<Body>(event).catch(() => ({}))) as Body;
  const kind = body?.kind === "sector" ? ("sector" as const) : ("stock" as const);
  const messages = sanitizeMessages(body?.messages);
  if (!messages || messages[messages.length - 1]?.role !== "user") {
    setResponseStatus(event, 400);
    return { ok: false as const, error: "对话为空或最后一条不是委托人消息" };
  }

  const book = await loadFlow();
  try {
    const reply = await chatWithDesigner(book, kind, messages);
    return { ok: true as const, reply };
  } catch (error) {
    setResponseStatus(event, 502);
    return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
  }
});
