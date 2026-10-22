/**
 * chiheng-dsh-client.ts —— 赤轨侧调用 DSH 桥接的客户端（drop-in 到 src/lib/market/）
 *
 * 干什么：让赤轨的 AI 闭环（agent-loop / strategy-ai / factor-queue）从「直连 OpenAI 兼容 API」
 * 切到「先走 DeepSeek HARNESS 桥接（:3080 /chihengapi/chat），连不上再回退直连」。
 *
 * 用法（两处小改，都不动判决逻辑）：
 *   1. 把本文件拷进 src/lib/market/。
 *   2. 在 factor-queue.ts 的 callAIWithFallback 里，第一行加：
 *        try { return await callDSHWithFallback(prompt, meta); } catch {}
 *      （DSH 挂了会原样抛错，再走原有的直连 fallback——灰度和回退都免费拿到）
 *
 * 纪律不变：DSH 只当「提议引擎」，返回的文本仍要走 red-line.ts / number-gate.ts /
 * factor-expr.ts 硬闸。本模块只负责「把 prompt 送进 DSH、把文本拿回来」，不碰判决。
 */

/** DSH 桥接地址。默认本机 :3080；可用环境变量 CHIHENG_DSH_URL 覆盖。 */
function dshBase(): string {
  const url = process.env.CHIHENG_DSH_URL ?? "http://127.0.0.1:3080";
  return url.replace(/\/+$/, "");
}

/** 系统提示。和直连 callAI 里写死的那句对齐：严谨量化、只出 JSON。 */
const SYSTEM = "你是一个严谨的量化研究助理。只输出要求的 JSON，不输出别的。";

/** 一次桥接调用。返回 DSH 生成的文本；任何失败抛错（交给上层回退/记 ai-log）。 */
export async function callDSH(
  prompt: string,
  opts: { system?: string; provider?: string; model?: string } = {},
): Promise<string> {
  const res = await fetch(`${dshBase()}/chihengapi/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      system: opts.system ?? SYSTEM,
      user: prompt,
      // provider / model 可选：缺省用 DSH 的 agentDefaultModel（settings.yaml）
      ...(opts.provider ? { provider: opts.provider } : {}),
      ...(opts.model ? { model: opts.model } : {}),
    }),
  });
  if (!res.ok) throw new Error(`DSH 桥接 HTTP ${res.status}`);
  const data = (await res.json()) as { ok?: boolean; text?: string; empty?: boolean; error?: string };
  if (data.ok === false) throw new Error(`DSH 桥接失败：${data.error ?? "unknown"}`);
  if (data.empty || typeof data.text !== "string" || !data.text.trim()) {
    throw new Error("DSH 返回里没有内容");
  }
  return data.text;
}

/**
 * 先 DSH、后直连的 fallback 版。签名和 callAIWithFallback 对齐（prompt + meta），
 * 这样把它插在 callAIWithFallback 开头，就能拿到「DSH 优先、直连兜底」的灰度。
 *
 * 注意：DSH 失败时会抛「DSH 桥接 HTTP …」或「DSH 桥接失败」开头的错——
 * 上层 callAIWithFallback 捕获后继续走原有直连，等于自动降级。
 */
export async function callDSHWithFallback(prompt: string, _meta: Record<string, unknown> = {}): Promise<string> {
  return callDSH(prompt);
}
