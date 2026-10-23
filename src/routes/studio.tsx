/**
 * 这个文件是干什么的：
 * 「自媒体图文」页（/studio）。选内容类型（复盘/个股流入流出/板块/游资/热点）+ 平台（抖音/公众号），
 * 一键同时生成「图片 + 文案」：图走 studio-poster 的深色行情风，文走 DSH（DeepSeek）的活人感文案。
 *
 * 你需要知道的：
 * - 图片在浏览器里用 canvas 画；文案走服务端 AI。不荐股、不编数。
 * - 内容类型是灵活的（不是固定复盘模板），每类自动套对应的排名/列表数据。
 */

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { generateStudioCaption, getBreadth, getFlow, getHotMoney, getIndices, getNews } from "@/lib/market/quotes.functions";
import { buildStudioItems, defaultTitle, KIND_LABEL, titleFromCaption, type StudioKind, type StudioPlatform } from "@/lib/market/studio";
import { drawStudioPoster, type StudioFormat, type StudioSpec } from "@/lib/market/studio-poster";
import type { FlowBook } from "@/lib/market/flow";
import type { HotBook } from "@/lib/market/hotmoney";
import type { NewsItem } from "@/lib/market/news";
import type { IndexQuote } from "@/lib/market/types";

const KINDS: StudioKind[] = ["daily", "stockIn", "stockOut", "sector", "hotMoney", "news"];
const PLATFORMS: { id: StudioPlatform; label: string }[] = [
  { id: "douyin", label: "抖音" },
  { id: "wechat", label: "公众号" },
];

export const Route = createFileRoute("/studio")({
  loader: async () => {
    const [indices, breadth, flow, hotMoney, news] = await Promise.all([
      getIndices().catch(() => [] as IndexQuote[]),
      getBreadth().catch(() => null),
      getFlow().catch(() => null),
      getHotMoney().catch(() => null),
      getNews().catch(() => [] as NewsItem[]),
    ]);
    return { indices, breadth, flow, hotMoney, news };
  },
  component: StudioPage,
});

function StudioPage() {
  const data = Route.useLoaderData();
  const [kind, setKind] = useState<StudioKind>("daily");
  const [platform, setPlatform] = useState<StudioPlatform>("douyin");
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
      const res = await generateStudioCaption({ data: { kind, platform } });
      const caption = res.ok ? res.text : "";
      if (!res.ok) setError(res.error);

      const title = caption ? titleFromCaption(caption, defaultTitle(kind)) : defaultTitle(kind);
      const items = buildStudioItems(kind, {
        indices: data.indices,
        breadth: data.breadth ?? { up: 0, down: 0, flat: 0, limitUp: 0, limitDown: 0 },
        flow: data.flow as FlowBook | null,
        hotMoney: data.hotMoney as HotBook | null,
        news: data.news,
      });
      const spec: StudioSpec = { title, items };
      const format: StudioFormat = platform === "douyin" ? "vertical" : "square";
      const drawn = drawStudioPoster(spec, format);
      drawn.canvas.toBlob((blob) => {
        if (!blob) return;
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        setImageUrl(URL.createObjectURL(blob));
        setFilename(drawn.filename);
      }, "image/png");

      if (caption) setText(caption);
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
      <Panel title="自媒体图文" note="选内容 + 平台 → 一键生成「图 + 文」· 不荐股不编数">
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
          <span className="text-[11px] text-muted">内容</span>
          {KINDS.map((k) => (
            <button key={k} type="button" onClick={() => setKind(k)} className={tabClass(kind === k)}>
              {KIND_LABEL[k]}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
          <span className="text-[11px] text-muted">平台</span>
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
