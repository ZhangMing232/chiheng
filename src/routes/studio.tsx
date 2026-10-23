/**
 * 这个文件是干什么的：
 * 「自媒体图文」页（/studio）。选内容类型（每日复盘/资金异动）+ 平台（抖音/公众号），
 * 一键同时生成「图片（海报）+ 文案（AI 初稿）」，图可下载、文可改可复制。
 *
 * 你需要知道的：
 * - 图片在浏览器里用 canvas 画（复用 poster 主题），文案走 DSH（DeepSeek）生成。
 * - 文案是 AI 初稿、有「活人感」约束，你改一改再发；不荐股、不编数。
 */

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { generateStudioCaption, getBreadth, getFlow, getIndices } from "@/lib/market/quotes.functions";
import { drawDailyPoster, drawStudioFlowPoster, type StudioFormat } from "@/lib/market/studio-poster";
import type { FlowBook } from "@/lib/market/flow";
import type { IndexQuote } from "@/lib/market/types";

type Kind = "daily" | "flow";
type Platform = "douyin" | "wechat";

const KINDS: { id: Kind; label: string }[] = [
  { id: "daily", label: "每日复盘" },
  { id: "flow", label: "资金异动" },
];
const PLATFORMS: { id: Platform; label: string }[] = [
  { id: "douyin", label: "抖音" },
  { id: "wechat", label: "公众号" },
];

export const Route = createFileRoute("/studio")({
  loader: async () => {
    const [indices, breadth, flow] = await Promise.all([
      getIndices().catch(() => [] as IndexQuote[]),
      getBreadth().catch(() => null),
      getFlow().catch(() => null),
    ]);
    return { indices, breadth, flow };
  },
  component: StudioPage,
});

function StudioPage() {
  const { indices, breadth, flow } = Route.useLoaderData();
  const [kind, setKind] = useState<Kind>("daily");
  const [platform, setPlatform] = useState<Platform>("douyin");
  const [text, setText] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      // 文案（AI）
      const res = await generateStudioCaption({ data: { kind, platform } });
      if (res.ok) setText(res.text);
      else setError(res.error);

      // 图片（客户端 canvas 画）
      const format: StudioFormat = platform === "douyin" ? "vertical" : "square";
      let drawn: { canvas: HTMLCanvasElement; filename: string };
      if (kind === "daily") {
        drawn = drawDailyPoster({ indices, breadth: breadth ?? { up: 0, down: 0, flat: 0, limitUp: 0, limitDown: 0 }, flow: flow as FlowBook | null }, format);
      } else {
        if (!flow) throw new Error("资金数据暂时拉不下来");
        drawn = drawStudioFlowPoster(flow, format);
      }
      drawn.canvas.toBlob((blob) => {
        if (!blob) return;
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        setImageUrl(URL.createObjectURL(blob));
        setFilename(drawn.filename);
      }, "image/png");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function copy() {
    if (!text) return;
    navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      },
      () => undefined,
    );
  }

  function saveImage() {
    if (!imageUrl) return;
    const link = document.createElement("a");
    link.href = imageUrl;
    link.download = filename || "赤轨-图文.png";
    link.click();
  }

  function tabClass(active: boolean) {
    return "rounded border px-2.5 py-1 text-xs transition " + (active ? "border-brand text-fg" : "border-line text-muted hover:text-fg");
  }

  return (
    <Frame aside="自媒体图文">
      <Panel title="自媒体图文" note="一键生成「图 + 文」· 图可下载、文可改可复制 · 不荐股不编数">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
          <span className="text-[11px] text-muted">内容</span>
          {KINDS.map((k) => (
            <button key={k.id} type="button" onClick={() => setKind(k.id)} className={tabClass(kind === k.id)}>
              {k.label}
            </button>
          ))}
          <span className="ml-3 text-[11px] text-muted">平台</span>
          {PLATFORMS.map((p) => (
            <button key={p.id} type="button" onClick={() => setPlatform(p.id)} className={tabClass(platform === p.id)}>
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3 px-3.5 py-3">
          <div>
            <button
              type="button"
              onClick={() => void generate()}
              disabled={busy}
              className="rounded-full border border-line bg-surface px-3 py-2 text-sm disabled:opacity-40"
            >
              {busy ? "正在生成图+文…" : "生成图 + 文"}
            </button>
          </div>

          {error ? <p className="text-sm text-up">{error}</p> : null}

          {imageUrl ? (
            <div className="flex flex-col gap-2">
              <img src={imageUrl} alt="配图" className="w-full max-w-md rounded border border-line" />
              <div>
                <button type="button" onClick={saveImage} className="rounded-full border border-line bg-surface px-3 py-2 text-sm">
                  下载图片
                </button>
              </div>
            </div>
          ) : null}

          {text ? (
            <>
              <textarea value={text} onChange={(e) => setText(e.target.value)} rows={10} className="w-full rounded border border-line bg-transparent px-3 py-2 text-[13px] leading-relaxed text-fg" />
              <div className="flex items-center gap-3">
                <button type="button" onClick={copy} className="rounded-full border border-line bg-surface px-3 py-2 text-sm">
                  {copied ? "已复制 ✓" : "复制文案"}
                </button>
                <span className="text-xs text-muted">文案可先改再复制，直接粘贴到抖音/公众号。</span>
              </div>
            </>
          ) : null}
        </div>
      </Panel>
    </Frame>
  );
}
