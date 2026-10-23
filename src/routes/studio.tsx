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

import { useEffect, useState } from "react";
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
  const [topic, setTopic] = useState<StudioTopic>("stockVersus");
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
  const [stage, setStage] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  // 生成内容多选：图片/文案各自独立，图片格式（竖版/方版）也可多选一次出多张
  const [wantImage, setWantImage] = useState(true);
  const [wantText, setWantText] = useState(true);
  const [wantVertical, setWantVertical] = useState(true);
  const [wantSquare, setWantSquare] = useState(false);
  // AI 设计沟通：委托人（用户）和 AI 设计师的对话。user 消息累积成「设计要求」
  // 注入海报 prompt——聊得越具体，出图越符合想法。页面状态保管，刷新即新会话。
  const [chat, setChat] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);

  // 秒表：busy 期间每秒跳一次，让用户看到「它还在跑」而不是死等
  useEffect(() => {
    if (!busy) {
      setElapsed(0);
      return;
    }
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [busy]);

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
    setRenderNote("");
    // 生成内容多选：图片 / 文案各自独立，可只出一个。图片格式也可多选——
    // 竖版+方版都勾就一次出两张（预览显示最后一张，下载逐张保存）。
    const formats: StudioFormat[] = [
      ...(wantVertical ? (["vertical"] as const) : []),
      ...(wantSquare ? (["square"] as const) : []),
    ];
    const doImage = wantImage && formats.length > 0;
    const doText = wantText;
    if (!doImage && !doText) {
      setBusy(false);
      return;
    }
    const isVersus = topic === "stockVersus" || topic === "sectorVersus";
    try {
      const direction = chat.filter((m) => m.role === "user").map((m) => m.content).join("\n") || undefined;

      // **并行抢跑**：海报和文案同时开工，不等对方。AI 写 SVG 要 1–2 分钟，
      // 海报先跑起来，文案回来时图基本画完。只出图/只出文案时另一边不启动（不烧 token）。
      const captionPromise = doText
        ? generateStudioCaption({ data: { genre, topic, platform, extra } })
        : null;
      setStage(
        doImage && doText
          ? `海报：${isVersus ? "AI 设计师排版中（通常 1–2 分钟）" : "渲染中"} · 文案：同步撰写中`
          : doImage
            ? isVersus
              ? "海报：AI 设计师排版中（真实数据已注入，通常 1–2 分钟）"
              : "海报渲染中…"
            : "文案撰写中…",
      );

      // caption 惰性 await：promise 早已开跑，第一次用到时才等它
      let captionRes: { ok: boolean; text?: string; error?: string } | null = null;
      const caption = async (): Promise<string> => {
        if (!doText) return "";
        if (captionRes === null) captionRes = await captionPromise;
        const r = captionRes;
        if (!r || !r.ok) {
          setError(r?.error ?? "文案生成失败");
          return "";
        }
        return r.text ?? "";
      };

      let doneImages = 0;
      for (let i = 0; i < formats.length; i++) {
        const format = formats[i]!;
        const fmtLabel = format === "vertical" ? "抖音竖版" : "公众号方版";
        if (formats.length > 1) {
          setStage(`海报 ${i + 1}/${formats.length}（${fmtLabel}）${isVersus ? "：AI 设计师排版中…" : "：渲染中…"}`);
        }

        // **资金流向对比体裁：AI 设计优先**。数字和事实走模板逐字注入，审美/排版交给
        // 模型写 SVG；服务端先校验（真实数字、免责声明、品牌标识、NaN）再渲染，不过自动重画。
        // AI 不可用（非主人账号 / 接口失败）时安静回退到下面的模板路径。
        let usedAI = false;
        if (isVersus) {
          const ai = await fetch("/api/studio/ai-poster", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              kind: topic === "sectorVersus" ? "sector" : "stock",
              format,
              direction,
            }),
          })
            .then(
              (r) =>
                r.json() as Promise<
                  | { ok: true; dataUrl: string; attempts: number; ms: number }
                  | { ok: false; error: string }
                >,
            )
            .catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }));
          if (ai.ok) {
            if (imageUrl) URL.revokeObjectURL(imageUrl);
            setImageUrl(ai.dataUrl);
            setFilename(`赤轨-资金流向对比-${new Date().toISOString().slice(0, 10)}-${fmtLabel}.png`);
            setRenderPath("svg");
            doneImages++;
            setRenderNote(`AI 设计 · ${ai.attempts} 次尝试 · ${Math.round(ai.ms / 1000)}s · 数字已逐字校验 · 带赤轨品牌标`);
            usedAI = true;
          } else {
            setRenderNote(`AI 设计不可用（${ai.error}），已回退模板渲染`);
          }
        }
        if (usedAI) continue;

        // **服务端 SVG 优先，失败回退 canvas**。SVG 版式更好（声明式、条件渲染），
        // 但服务端要有字体和原生模块；回退保证任何情况下都能出图。
        const cap = await caption();
        const spec = buildStudioSpec(genre, topic, studioData, { topN, newsIndex });
        const title = cap ? titleFromCaption(cap, defaultTitle(topic)) : defaultTitle(topic);
        const withTitle = { ...spec, title };
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
          setFilename(`赤轨-${new Date().toISOString().slice(0, 10)}-${fmtLabel}.png`);
          setRenderPath("svg");
          doneImages++;
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
          setRenderNote((prev) => (prev ? `${prev}；${why}` : why));
          doneImages++;
        }
      }
      if (doneImages > 1) {
        setRenderNote((prev) => `${prev ? `${prev}；` : ""}已生成 ${doneImages} 张图（预览显示最后一张，点下载逐张保存）`);
      }

      const cap = await caption();
      if (cap) setText(cap);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setStage(null);
      setBusy(false);
    }
  }

  async function sendChat() {
    const text = chatInput.trim();
    if (!text || chatBusy) return;
    const next = [...chat, { role: "user" as const, content: text }];
    setChat(next);
    setChatInput("");
    setChatBusy(true);
    try {
      const r = await fetch("/api/studio/ai-design-chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: topic === "sectorVersus" ? "sector" : "stock",
          messages: next,
        }),
      }).then(
        (res) => res.json() as Promise<{ ok: true; reply: string } | { ok: false; error: string }>,
      );
      setChat((c) => [...c, { role: "assistant", content: r.ok ? r.reply : `（设计师没回上话：${r.error}）` }]);
    } catch (e) {
      setChat((c) => [...c, { role: "assistant", content: `（网络没通：${e instanceof Error ? e.message : String(e)}）` }]);
    } finally {
      setChatBusy(false);
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
            资金流向题材：AI 设计排版 + 真实数据逐字注入（服务端校验数字）· 其他题材：模板渲染（AI 画的数字不可信）
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

          {/* 生成内容多选：想只出图、只出文，还是都要；图片可一次出多种尺寸 */}
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg">
              <input
                type="checkbox"
                checked={wantImage}
                onChange={(e) => setWantImage(e.target.checked)}
                className="accent-brand"
              />
              图片
            </label>
            {wantImage ? (
              <span className="flex items-center gap-2 text-[11px] text-muted">
                格式
                <label className="flex cursor-pointer items-center gap-1">
                  <input type="checkbox" checked={wantVertical} onChange={(e) => setWantVertical(e.target.checked)} className="accent-brand" />
                  抖音竖版
                </label>
                <label className="flex cursor-pointer items-center gap-1">
                  <input type="checkbox" checked={wantSquare} onChange={(e) => setWantSquare(e.target.checked)} className="accent-brand" />
                  公众号方版
                </label>
              </span>
            ) : null}
            <label className="flex cursor-pointer items-center gap-1.5 text-xs text-fg">
              <input
                type="checkbox"
                checked={wantText}
                onChange={(e) => setWantText(e.target.checked)}
                className="accent-brand"
              />
              文案
            </label>
            <button
              type="button"
              onClick={() => void generate()}
              disabled={busy || (!wantImage && !wantText) || (wantImage && !wantVertical && !wantSquare)}
              className="rounded-full border border-line bg-surface px-3 py-2 text-sm disabled:opacity-40"
            >
              {busy
                ? "生成中，别关页面…"
                : wantImage && wantText
                  ? chat.length
                    ? "按设计沟通生成图 + 文"
                    : "生成图 + 文"
                  : wantImage
                    ? "只生成图片"
                    : "只生成文案"}
            </button>
          </div>

          {/* 进度可见：阶段 + 秒表。AI 设计 1–2 分钟是正常的，但不能让用户对着
              一个静止按钮死等——每秒跳的秒表就是「它还在跑」的证据。 */}
          {busy ? (
            <div className="flex items-center gap-2 rounded border border-line bg-surface px-3 py-2">
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-brand border-t-transparent" />
              <span className="text-xs text-fg">{stage ?? "处理中…"}</span>
              <span className="ml-auto text-xs tabular-nums text-muted">{elapsed}s</span>
            </div>
          ) : null}

          {/* AI 设计沟通（资金流向题材）：像跟真人设计师聊方案——它看得见今天的真实
              数据，给的建议落在实际内容上。聊完点上面「生成图 + 文」，说过的话会全部
              作为设计要求带进出图。 */}
          {topic === "stockVersus" || topic === "sectorVersus" ? (
            <div className="rounded border border-line">
              <div className="border-b border-line px-3 py-2">
                <span className="text-xs font-medium text-fg">AI 设计师沟通</span>
                <span className="ml-2 text-[11px] text-muted">
                  聊设计方向（配色/布局/氛围），它看着今天的真实数据回你 · 聊完点「生成图 + 文」
                </span>
              </div>
              {chat.length ? (
                <div className="flex max-h-64 flex-col gap-2 overflow-y-auto px-3 py-2">
                  {chat.map((m, i) => (
                    <div key={i} className={m.role === "user" ? "self-end text-right" : "self-start text-left"}>
                      <span
                        className={
                          "inline-block max-w-[85%] whitespace-pre-wrap rounded px-2.5 py-1.5 text-xs leading-relaxed " +
                          (m.role === "user" ? "bg-brand/15 text-fg" : "bg-surface text-fg")
                        }
                      >
                        {m.content}
                      </span>
                    </div>
                  ))}
                  {chatBusy ? <span className="text-[11px] text-muted">设计师思考中…</span> : null}
                </div>
              ) : (
                <p className="px-3 py-2 text-[11px] text-muted">
                  试试：「想要科技感暗色风，流入侧用金色强调」或「上半部分太满，标题区留点呼吸」
                </p>
              )}
              <div className="flex items-center gap-2 border-t border-line px-3 py-2">
                <input
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing) void sendChat();
                  }}
                  placeholder="跟设计师说你的想法…（回车发送）"
                  maxLength={300}
                  className="flex-1 rounded border border-line bg-transparent px-2.5 py-1.5 text-xs text-fg outline-none placeholder:text-muted focus:border-brand"
                />
                <button
                  type="button"
                  onClick={() => void sendChat()}
                  disabled={chatBusy || !chatInput.trim()}
                  className="rounded-full border border-line bg-surface px-3 py-1.5 text-xs disabled:opacity-40"
                >
                  {chatBusy ? "思考中…" : "发送"}
                </button>
              </div>
            </div>
          ) : null}

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
