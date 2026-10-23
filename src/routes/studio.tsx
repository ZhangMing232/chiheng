/**
 * 这个文件是干什么的：
 * 「自媒体图文」页（/studio）。选内容类型（每日复盘/资金异动）+ 平台（抖音/公众号），
 * AI 生成一段可直接发布的文案（标题/正文/标签），你改一改就能发。
 *
 * 你需要知道的：
 * - 文案是 AI 初稿，可编辑、可复制；不荐股、不编数。
 * - 配图走各页的「生成汇总图」按钮（资金流向/每日复盘/快讯等），本页只生成文案。
 */

import { useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { Panel } from "@/components/terminal";
import { generateStudioCaption } from "@/lib/market/quotes.functions";

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

export const Route = createFileRoute("/studio")({ component: StudioPage });

function StudioPage() {
  const [kind, setKind] = useState<Kind>("daily");
  const [platform, setPlatform] = useState<Platform>("douyin");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await generateStudioCaption({ data: { kind, platform } });
      if (res.ok) setText(res.text);
      else setError(res.error);
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

  function tabClass(active: boolean) {
    return "rounded border px-2.5 py-1 text-xs transition " + (active ? "border-brand text-fg" : "border-line text-muted hover:text-fg");
  }

  return (
    <Frame aside="自媒体图文">
      <Panel title="自媒体图文" note="AI 生成文案初稿 · 你改一改就能发 · 配图去各页「生成汇总图」">
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
              {busy ? "AI 正在写文案…" : "生成文案"}
            </button>
          </div>

          {error ? <p className="text-sm text-up">{error}</p> : null}

          {text ? (
            <>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={10}
                className="w-full rounded border border-line bg-transparent px-3 py-2 text-[13px] leading-relaxed text-fg"
              />
              <div className="flex items-center gap-3">
                <button type="button" onClick={copy} className="rounded-full border border-line bg-surface px-3 py-2 text-sm">
                  {copied ? "已复制 ✓" : "复制文案"}
                </button>
                <span className="text-xs text-muted">文案可先改再复制，直接粘贴到抖音/公众号即可。</span>
              </div>
            </>
          ) : null}
        </div>

        <p className="border-t border-line px-3.5 py-2 text-[11px] text-muted">
          配图：去 <Link to="/flow" className="text-fg underline">资金流向</Link>（资金异动）或{" "}
          <Link to="/review" className="text-fg underline">每日复盘</Link> 页，点「生成汇总图」即可出图。后面我会把「图+文」一键整合到这一页。
        </p>
      </Panel>
    </Frame>
  );
}
