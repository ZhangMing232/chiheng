/**
 * 这个文件是干什么的：
 * 自媒体图文的**服务端渲染接口**。L1 改造后，配图由服务端用 SVG 模板 +
 * resvg 渲染成 PNG 返回（浏览器端的 canvas 路线保留做回退）。
 *
 * 你需要知道的：
 * 1. **为什么必须服务端**：@resvg/resvg-js 是原生模块，浏览器跑不了。
 *    所以「图」要过一次网络往返。好处是能按 spec 缓存；代价是多一次延迟
 *    （实测渲染 300ms，加上首屏字体库加载约 1.2s）。
 * 2. **失败要说清原因，不返回空图**：字体缺失、字形没生效都会抛错，
 *    页面收到错误后回退 canvas 路线，并在提示里说清回退原因。
 * 3. 返回 dataURL（base64 PNG）而不是二进制流——前端直接塞 <img src>，
 *    不用管 blob 生命周期。
 */

import { createServerFn } from "@tanstack/react-start";
import { specToSvg } from "./studio-card.ts";
import { FONT_CANDIDATES, pickFont, renderSvg } from "./studio-svg.ts";
import type { StudioSpec } from "./studio-poster.ts";

export type RenderPosterInput = {
  spec: StudioSpec;
  format: "vertical" | "square";
};

export const renderStudioPoster = createServerFn({ method: "POST" })
  .validator((data: unknown): RenderPosterInput => {
    const d = (data ?? {}) as { spec?: unknown; format?: unknown };
    const spec = (d.spec ?? {}) as Partial<StudioSpec>;
    const items = Array.isArray(spec.items) ? spec.items : [];
    return {
      format: d.format === "square" ? "square" : "vertical",
      spec: {
        title: typeof spec.title === "string" ? spec.title.slice(0, 60) : "赤轨",
        subtitle: typeof spec.subtitle === "string" ? spec.subtitle.slice(0, 60) : undefined,
        layout: spec.layout === "stat" || spec.layout === "event" || spec.layout === "ladder" ? spec.layout : "ranking",
        items: items.map((it) => ({
          name: String((it as { name?: unknown }).name ?? "").slice(0, 40),
          value: String((it as { value?: unknown }).value ?? "").slice(0, 30),
          color: String((it as { color?: unknown }).color ?? "#f5f6f8").slice(0, 16),
          note: typeof (it as { note?: unknown }).note === "string" ? (it as { note: string }).note.slice(0, 60) : undefined,
        })),
        body: Array.isArray(spec.body) ? spec.body.map((b) => String(b).slice(0, 400)) : undefined,
        meta: typeof spec.meta === "string" ? spec.meta.slice(0, 120) : undefined,
        stats: Array.isArray(spec.stats) ? spec.stats : undefined,
        breadth: spec.breadth,
        rungs: Array.isArray(spec.rungs) ? spec.rungs : undefined,
        mood: typeof spec.mood === "string" ? spec.mood.slice(0, 200) : undefined,
        dist: spec.dist,
        mini: Array.isArray(spec.mini) ? spec.mini : undefined,
        footNote: typeof spec.footNote === "string" ? spec.footNote.slice(0, 120) : undefined,
      },
    };
  })
  .handler(async ({ data }): Promise<{ ok: true; dataUrl: string; ms: number } | { ok: false; error: string }> => {
    try {
      const font = pickFont(FONT_CANDIDATES);
      if (!font) {
        return { ok: false, error: "服务端没有可用的中文字体（macOS 缺系统字体或 Linux 缺 fonts-noto-cjk）" };
      }
      const svg = specToSvg(data.spec, data.format, font.family);
      const out = await renderSvg(svg);
      const dataUrl = `data:image/png;base64,${Buffer.from(out.png).toString("base64")}`;
      return { ok: true, dataUrl, ms: out.ms };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
