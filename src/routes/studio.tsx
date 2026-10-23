/**
 * 这个文件是干什么的：
 * 「自媒体图文」页（/studio）。**体裁 × 数据源**两级选择：先选怎么写（榜单/游资/
 * 事件/复盘/情绪），再选写什么（哪份榜、哪条快讯），范围可调、观点可补。
 * 一键生成「图 + 文」：图按体裁走四种版式（studio-poster），文按体裁走不同写法
 * （studio.ts 的 GENRE_VOICE），所以不再是所有内容都长一个样。
 *
 * 你需要知道的：
 * - 图片在浏览器里用 canvas 画；文案走服务端 AI（DSH）。不荐股、不编数。
 * - 「我的观点」是可选项：AI 把它自然融进文案，不原话照搬、不盖过数据。
 */

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { generateStudioCaption, getBreadth, getFlow, getHotMoney, getIndices, getNews } from "@/lib/market/quotes.functions";
import { getSignals } from "@/lib/market/limit-up.functions";
import { buildStudioSpec, defaultTitle, genreOf, titleFromCaption, GENRES, type StudioData, type StudioGenre, type StudioPlatform, type StudioTopic } from "@/lib/market/studio";
import { drawStudioPoster, type StudioFormat } from "@/lib/market/studio-poster";
import type { StudioTheme } from "@/lib/market/studio-card";
import type { FlowBook } from "@/lib/market/flow";
import type { HotBook } from "@/lib/market/hotmoney";
import type { NewsItem } from "@/lib/market/news";
import type { IndexQuote } from "@/lib/market/types";

const PLATFORMS: { id: StudioPlatform; label: string }[] = [
  { id: "douyin", label: "抖音" },
  { id: "wechat", label: "公众号" },
];

export const Route = createFileRoute("/studio")({
  loader: async () => {
    // signals 给出连板梯队和炸板率（情绪体裁要用）；拉不到就缺着，不编
    const [indices, breadth, flow, hotMoney, news, signals] = await Promise.all([
      getIndices().catch(() => [] as IndexQuote[]),
      getBreadth().catch(() => null),
      getFlow().catch(() => null),
      getHotMoney().catch(() => null),
      getNews().catch(() => [] as NewsItem[]),
      getSignals().catch(() => null),
    ]);
    return { indices, breadth, flow, hotMoney, news, signals };
  },
  component: StudioPage,
});

function StudioPage() {
  const data = Route.useLoaderData();
  const [genre, setGenre] = useState<StudioGenre>("ranking");
  const [topic, setTopic] = useState<StudioTopic>("stockIn");
  const [topN, setTopN] = useState(10);
  const [newsIndex, setNewsIndex] = useState(0);
  const [platform, setPlatform] = useState<StudioPlatform>("douyin");
  const [theme, setTheme] = useState<StudioTheme>("dark");
  const [extra, setExtra] = useState("");
  const [text, setText] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [filename, setFilename] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [renderPath, setRenderPath] = useState<"svg" | "canvas" | null>(null);
  const [renderNote, setRenderNote] = useState("");

  const g = genreOf(genre);
  const studioData: StudioData = {
    indices: data.indices,
    breadth: data.breadth ?? { up: 0, down: 0, flat: 0, limitUp: 0, limitDown: 0 },
    flow: data.flow as FlowBook | null,
    hotMoney: data.hotMoney as HotBook | null,
    news: data.news,
    ladder: data.signals?.summary?.ladder ?? [],
    breakRate: data.signals?.summary?.breakRate ?? null,
  };

  async function generate() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await generateStudioCaption({ data: { genre, topic, platform, extra } });
      const caption = res.ok ? res.text : "";
      if (!res.ok) setError(res.error);

      const spec = buildStudioSpec(genre, topic, studioData, { topN, newsIndex });
      const title = caption ? titleFromCaption(caption, defaultTitle(topic)) : defaultTitle(topic);
      const format: StudioFormat = platform === "douyin" ? "vertical" : "square";
      const withTitle = { ...spec, title };

      // **服务端 SVG 优先，失败回退 canvas**。SVG 版式更好（声明式、条件渲染），
      // 但服务端要有字体和原生模块；回退保证任何情况下都能出图。
      const rendered = await fetch("/api/studio/poster", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ spec: withTitle, format, theme }),
      })
        .then((r) => r.json() as Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }>)
        .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
      if (rendered.ok) {
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        setImageUrl(rendered.dataUrl);
        setFilename(`赤轨-${new Date().toISOString().slice(0, 10)}-${platform === "douyin" ? "抖音" : "公众号"}.png`);
        setRenderPath("svg");
        setRenderNote("");
      } else {
        const drawn = drawStudioPoster(withTitle, format);
        drawn.canvas.toBlob((blob) => {
          if (!blob) return;
          if (imageUrl) URL.revokeObjectURL(imageUrl);
          setImageUrl(URL.createObjectURL(blob));
          setFilename(drawn.filename);
        }, "image/png");
        setRenderPath("canvas");
        // 404 在 dev 下是**预期行为**：Nitro 的 server/routes 要 build 后才生效
        // （vite.config 里 serverDir 只在 build/preview 分支配了 nitro 插件）。
        // 所以这里要说清楚，别让人以为是服务器坏了。
        const why = /404|fetch|Failed/i.test(rendered.error)
          ? "服务端渲染接口当前不可用（开发模式下 server/routes 要 build 后才生效），已用浏览器绘制。"
          : `服务端渲染失败，已回退浏览器绘制：${rendered.error}`;
        setRenderNote(why);
      }

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
      <Panel title="自媒体图文" note="选体裁 → 选数据 → 生成图+文 · 不荐股不编数">
        {/* 第一级：体裁 */}
        <div className="border-b border-line px-3.5 py-2">
          <div className="pb-1.5 text-[11px] text-muted">怎么写（体裁决定图和文的形态）</div>
          <div className="flex flex-wrap gap-2">
            {GENRES.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => {
                  setGenre(item.id);
                  setTopic(item.topics[0]!.id);
                }}
                className={tabClass(genre === item.id)}
              >
                {item.label}
                <span className="ml-1 hidden text-[10px] text-muted sm:inline">{item.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* 第二级：数据源 + 范围 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
          <span className="text-[11px] text-muted">写什么</span>
          {g.topics.map((t) => (
            <button key={t.id} type="button" onClick={() => setTopic(t.id)} className={tabClass(topic === t.id)}>
              {t.label}
            </button>
          ))}
          {g.topNOptions.length > 1 ? (
            <>
              <span className="ml-2 text-[11px] text-muted">条数</span>
              {g.topNOptions.map((n) => (
                <button key={n} type="button" onClick={() => setTopN(n)} className={tabClass(topN === n)}>
                  {n}
                </button>
              ))}
            </>
          ) : null}
        </div>

        {/* 事件体裁：挑一条快讯 */}
        {topic === "news" && data.news.length > 0 ? (
          <div className="border-b border-line px-3.5 py-2">
            <div className="pb-1.5 text-[11px] text-muted">挑一条深读（最新 {data.news.length} 条）</div>
            <div className="flex max-h-32 flex-col gap-1 overflow-y-auto">
              {data.news.slice(0, 20).map((n, i) => (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => setNewsIndex(i)}
                  className={
                    "truncate rounded border px-2 py-1 text-left text-xs transition " +
                    (newsIndex === i ? "border-brand text-fg" : "border-line text-muted hover:text-fg")
                  }
                >
                  <span className="tabular-nums text-[10px] text-muted">{n.time}</span> {n.title}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {/* 风格（两套视觉系统：深色行情风 / 浅色杂志风） */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
          <span className="text-[11px] text-muted">风格</span>
          {([
            { id: "dark", label: "深色行情" },
            { id: "light", label: "浅色杂志" },
          ] as const).map((x) => (
            <button key={x.id} type="button" onClick={() => setTheme(x.id)} className={tabClass(theme === x.id)}>
              {x.label}
            </button>
          ))}
          <span className="text-[11px] text-muted">
            数据图必须模板渲染——AI 画的数字是编的；AI 只适合封面氛围图
          </span>
        </div>

        {/* 平台 */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line px-3.5 py-2">
          <span className="text-[11px] text-muted">平台</span>
          {PLATFORMS.map((p) => (
            <button key={p.id} type="button" onClick={() => setPlatform(p.id)} className={tabClass(platform === p.id)}>
              {p.label}
            </button>
          ))}
        </div>

        <div className="flex flex-col gap-3 px-3.5 py-3">
          {/* 我的观点（可选） */}
          <div>
            <input
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="我的观点（可选）：想让大家额外注意到什么，AI 会自然融进文案"
              maxLength={200}
              className="w-full rounded border border-line bg-transparent px-3 py-2 text-[13px] text-fg outline-none placeholder:text-muted focus:border-brand"
            />
          </div>

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
          {renderNote ? <p className="text-xs text-warn">{renderNote}</p> : null}
          {renderPath ? (
            <p className="text-[11px] text-muted">
              渲染路径：{renderPath === "svg" ? "服务端 SVG 模板" : "浏览器 canvas（回退）"}
            </p>
          ) : null}

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
