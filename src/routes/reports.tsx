/**
 * 这个文件是干什么的：
 * 「我的报告」页。列出这台机器上存过的研判报告，点开能看原文。
 *
 * 你需要知道的：
 * - 报告在 `data/reports/`，**data 不在 git 里**。换机器、或者从来没存过，
 *   这一页就是空的——空态要说清「去哪存」（/research 页研判完点「存成报告」）。
 * - 每一行都带 AI 状态：ok = 有 AI 综合；failed/skipped = 只有规则结论。
 *   不许让读者以为每份都有 AI 参与。
 */

import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Frame } from "@/components/screener/nav";
import { Panel, Tag, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { getReportContent, getReports } from "@/lib/market/reports.functions";
import { getDocLibrary, searchDocLibrary } from "@/lib/market/docs.functions";
import { snippetOf } from "@/lib/market/docs";
import { Link } from "@tanstack/react-router";

export const Route = createFileRoute("/reports")({
  loader: () => Promise.all([getReports(), getDocLibrary()]),
  component: ReportsPage,
});

const AI_LABEL: Record<string, { text: string; tone: "brand" | "warn" | "muted" }> = {
  ok: { text: "有 AI 综合", tone: "brand" },
  refused: { text: "AI 被红线拦下", tone: "warn" },
  failed: { text: "AI 没接通", tone: "warn" },
  skipped: { text: "未调用 AI", tone: "muted" },
  none: { text: "未调用 AI", tone: "muted" },
};

function ReportsPage() {
  const [rows, library] = Route.useLoaderData();
  const [openId, setOpenId] = useState<string | null>(null);
  const { data: opened, isFetching } = useQuery({
    queryKey: ["report-content", openId],
    queryFn: () => getReportContent({ data: { id: openId! } }),
    enabled: openId != null,
    staleTime: 60_000,
  });

  return (
    <Frame>
      <Panel title="我的报告" note={<span className="text-xs text-muted">每次研判可存一份 · 存在本机 data/reports/</span>}>
        {rows.length === 0 ? (
          <StateBlock
            kind="empty"
            title="这台机器上还没有报告"
            hint="去「个股研判」页输入一只股票，七阶段跑完后点「存成报告」，这里就会出现。报告存在本机，data 目录不进 git，换机器不会跟过来。"
            action={{ label: "去个股研判", onClick: () => { window.location.assign("/research"); } }}
          />
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">已保存的研判报告列表</caption>
            <thead>
              <tr>
                <th className={thClass("text-left")}>标的</th>
                <th className={thClass("text-left")}>生成时间</th>
                <th className={thClass("text-left")}>AI</th>
                <th className={thClass("text-right")}>缺口</th>
                <th className={thClass("text-right")}>拦下</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-line">
                  <td className={tdClass("text-left")}>
                    <button
                      type="button"
                      onClick={() => setOpenId(openId === row.id ? null : row.id)}
                      className="text-accent hover:underline"
                    >
                      {row.name || row.symbol}
                      <span className="ml-2 text-xs text-muted">{row.symbol}</span>
                    </button>
                  </td>
                  <td className={tdClass("text-left text-xs text-muted")}>{row.at.replace("T", " ").slice(0, 19)}</td>
                  <td className={tdClass("text-left")}>
                    <Tag tone={AI_LABEL[row.aiStatus]?.tone ?? "muted"}>{AI_LABEL[row.aiStatus]?.text ?? row.aiStatus}</Tag>
                  </td>
                  <td className={tdClass("text-muted")}>{row.gaps}</td>
                  <td className={tdClass(row.blocked > 0 ? "text-warn" : "text-muted")}>{row.blocked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>

      {openId ? (
        <Panel title="报告原文" note={<span className="text-xs text-muted">markdown · 与落盘文件一致</span>}>
          {isFetching && !opened ? (
            <div className="px-3 py-6 text-center text-sm text-muted">正在读…</div>
          ) : opened?.md ? (
            <pre className="max-h-[32rem] overflow-auto scroll-slim px-3 py-2 text-xs leading-relaxed whitespace-pre-wrap">{opened.md}</pre>
          ) : (
            <StateBlock kind="error" title="这份报告读不到" hint="文件可能被手动删了，或者这台机器不是当初存它的那台（data 目录不进 git）。" />
          )}
        </Panel>
      ) : null}

      <p className="px-1 text-xs leading-relaxed text-muted">
        报告里带了宪法口径、四档可信度和证据 id——AI 说过什么、依据是哪几条，事后都查得到。
        想去研判新标的？<Link to="/research" search={{ q: "" }} className="text-accent hover:underline">去个股研判</Link>
      </p>
      <DocLibraryPanel library={library} />
    </Frame>
  );
}

/**
 * 文档库：摄入进来的研报（PDF/Word/Markdown/文本/自己的研判 JSON），可搜索、
 * 每条命中带出处。
 *
 * **三条口径写在页面上，不藏着**：
 * 1. **不做中文分词**——中文没有空格，真分词要引 jieba 词典（arm64 装包有前车之鉴）。
 *    所以搜索框要的是**关键词**，不是整句话。
 * 2. **出处必显示**（第几页/第几行）。没有出处的命中一律不给——读的人无法核对
 *    AI 引用的话出自哪里，这是「引用回查原文」的落点。
 * 3. **抽取质量如实显示**：PDF 抽出多少字写在每份文档上。扫描件（图片版）抽不出，
 *    摄入时就会报错不入库——需要 OCR，pypdf 做不到。
 */
function DocLibraryPanel({ library }: { library: Awaited<ReturnType<typeof getDocLibrary>> }) {
  const [q, setQ] = useState("");
  const [submitted, setSubmitted] = useState("");
  const { data } = useQuery({
    queryKey: ["doc-search", submitted],
    queryFn: () => searchDocLibrary({ data: { q: submitted, limit: 20 } }),
    enabled: submitted.trim().length > 0,
    staleTime: 60_000,
  });

  return (
    <Panel
      title="文档库"
      note={
        <span className="text-xs text-muted">
          摄入 PDF/Word/Markdown/文本 · {library.docs.length} 份 / {library.totalChunks} 块 ·
          存在本机 data/docs/
        </span>
      }
    >
      {library.docs.length === 0 ? (
        <StateBlock
          kind="empty"
          title="还没有摄入任何文档"
          hint="跑一次 python3 scripts/ingest-doc.py <路径>（支持 PDF / docx / md / txt / json）。PDF 用 pypdf 解析，扫描件抽不出字会直接报错不入库。"
        />
      ) : (
        <>
          <form
            className="flex gap-2 border-b border-line px-3.5 py-2"
            onSubmit={(event) => {
              event.preventDefault();
              setSubmitted(q);
            }}
          >
            <input
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="关键词（不是整句话）"
              className="min-w-0 flex-1 rounded border border-line bg-surface px-2 py-1 text-sm outline-none focus:border-brand"
            />
            <button type="submit" className="rounded border border-brand px-3 py-1 text-sm text-brand-text hover:bg-brand-soft">
              搜
            </button>
          </form>

          {submitted.trim() ? (
            <div className="border-b border-line px-3.5 py-2">
              {!data || data.hits.length === 0 ? (
                <p className="text-sm text-muted">
                  {data ? `「${submitted}」在 ${data.searched} 份文档里没找到` : "搜着…"}
                  <span className="ml-2 text-xs">换短关键词试试——这里不做中文分词，长句搜不到。</span>
                </p>
              ) : (
                <ul>
                  {data.hits.map((hit, index) => (
                    <li key={`${hit.docId}-${hit.chunk.locator}-${index}`} className="border-t border-line py-2 first:border-t-0">
                      <div className="flex flex-wrap items-baseline gap-2">
                        <span className="text-sm font-medium">{hit.docTitle}</span>
                        <Tag tone="muted">{hit.format}</Tag>
                        <Tag tone="brand">{hit.chunk.locator}</Tag>
                        <span className="text-[11px] text-muted">命中 {hit.terms.join("、")}</span>
                      </div>
                      <p className="mt-1 text-sm leading-relaxed text-fg">{snippetOf(hit.chunk, hit.terms)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ) : null}

          <ul>
            {library.docs.map((doc) => (
              <li key={doc.id} className="flex flex-wrap items-baseline justify-between gap-2 border-t border-line px-3.5 py-2 first:border-t-0">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{doc.title}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {doc.chunks.length} 块
                    {doc.stats.extractedChars != null ? ` / ${doc.stats.extractedChars} 字` : ""}
                    {doc.stats.pages != null ? ` / ${doc.stats.pages} 页` : ""} · 摄入于 {doc.ingestedAt.slice(0, 10)}
                  </div>
                </div>
                <Tag tone="muted">{doc.format}</Tag>
              </li>
            ))}
          </ul>

          {library.broken.length > 0 ? (
            <p className="border-t border-line px-3.5 py-2 text-[11px] text-warn">
              {library.broken.length} 份读不出来（没算进上面的列表）：
              {library.broken.map((b) => `${b.file}（${b.why}）`).join("、")}
            </p>
          ) : null}

          <p className="border-t border-line px-3.5 py-2 text-[11px] text-muted">
            摄入脚本：<code>python3 scripts/ingest-doc.py &lt;路径&gt;</code>。PDF 用 pypdf（纯 Python，
            arm64 能装）；.docx 是 zip+XML 同样零依赖手写解析，老式 .doc 读不了。
            <strong>扫描件（图片版 PDF）抽不出字会直接报错不入库</strong>——那需要 OCR。
          </p>
        </>
      )}
    </Panel>
  );
}
