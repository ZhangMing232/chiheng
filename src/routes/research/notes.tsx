/**
 * 这个文件是干什么的：
 * 「笔记」页——记你自己对某只票的观察。
 *
 * 对标 Vibe-Research 的 knowledge/ + ReportHistory 那一块（把想法和报告分开存）。
 *
 * 你需要知道的（这一页和别的不一样，纪律也不同）：
 * 1. **笔记是你自己写的，不是取来的数据**。所以它不是事实，是**待验证的线索**——
 *    写「这批货渠道反馈还行」是你判断，不是数据。页面每条都标着「你自己记的」。
 * 2. **笔记不进研判证据链**。研判页不引用它，数字闸门也不管它——它没有出处，
 *    给它套证据链是自欺。真要用它当依据，得先在研判里核实。
 * 3. **存本机**（data/notes.json），不在 git 里，换机器不会跟过来。
 * 4. 这一页只做记录和检索，不给买卖建议。
 */

import { useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Frame } from "@/components/screener/nav";
import { RESEARCH_TABS, SectionTabs } from "@/components/section-tabs";
import { Panel, thClass, tdClass } from "@/components/terminal";
import { StateBlock } from "@/components/state-block";
import { addNoteFn, deleteNoteFn, editNoteFn, getNotes } from "@/lib/market/notes.functions";
import { NOTE_MAX, filterNotes, type Note } from "@/lib/market/notes";
import { relTimeOf } from "@/lib/market/notes-view";

export const Route = createFileRoute("/research/notes")({
  loader: () => getNotes().catch(() => [] as Note[]),
  component: NotesPage,
});

function NotesPage() {
  const loaded = Route.useLoaderData();
  const [notes, setNotes] = useState<Note[] | null>(null);
  const [text, setText] = useState("");
  const [symbol, setSymbol] = useState("");
  const [name, setName] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const list = notes ?? loaded;

  // ── 页头装饰用：笔记条数（真实数据）──
  const noteCount = list.length;
  const shown = filterNotes(list, filter.trim() || null);

  async function save() {
    setBusy(true);
    setWhy(null);
    const res = await addNoteFn({
      data: { text, symbol: symbol.trim() || null, name: name.trim() || null },
    }).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
    setBusy(false);
    if (!res.ok) {
      setWhy(res.reason);
      return;
    }
    setNotes(res.notes);
    setText("");
    setSymbol("");
    setName("");
  }

  async function saveEdit(id: string) {
    setBusy(true);
    setWhy(null);
    const res = await editNoteFn({ data: { id, text: draft } }).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
    setBusy(false);
    if (!res.ok) {
      setWhy(res.reason);
      return;
    }
    setNotes(res.notes);
    setEditing(null);
  }

  async function remove(id: string) {
    setBusy(true);
    setWhy(null);
    const res = await deleteNoteFn({ data: { id } }).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : String(error) }));
    setBusy(false);
    if (!res.ok) {
      setWhy(res.reason);
      return;
    }
    setNotes(res.notes);
  }

  return (
    <Frame
      aside="笔记"
      status={{
        label: "笔记",
        // **真实数据**：本页已有的 list 长度。
        value: `${noteCount} 条`,
        tone: "neutral",
      }}
      ornamentContent={
        // **真实数据**：list[0] 是最新一条。relTimeOf 是本页已有的相对时间
        // （「3 小时前」），比绝对时间更适合页头。
        list.length > 0 ? (
          <span className="text-[11px] tabular-nums">
            最新 {relTimeOf(list[0]!.at)}
            {list[0]!.symbol ? ` · ${list[0]!.name ?? list[0]!.symbol}` : ""}
          </span>
        ) : (
          <span className="text-[11px]">还没有笔记</span>
        )
      }
    >
      <h1 className="font-display text-xl font-medium tracking-wide">研究</h1>
      <SectionTabs ariaLabel="研究" tabs={RESEARCH_TABS} />
      <Panel title="记一条" note="你自己写的观察，存在本机">
        <div className="space-y-2 border-b border-line px-3.5 py-3">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            placeholder="看到什么想到什么。例如：这批货渠道反馈还行 / 三个月后回来核对是不是真的"
            className="w-full resize-y rounded border border-line bg-transparent px-2.5 py-2 text-sm text-fg placeholder:text-muted"
          />
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={symbol}
              onChange={(e) => setSymbol(e.target.value)}
              placeholder="股票代码（可留空）"
              className="w-36 rounded border border-line bg-transparent px-2 py-1 text-xs text-fg placeholder:text-muted"
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="名称（可留空）"
              className="w-36 rounded border border-line bg-transparent px-2 py-1 text-xs text-fg placeholder:text-muted"
            />
            <button
              type="button"
              onClick={save}
              disabled={busy || text.trim() === ""}
              className="rounded border border-brand px-3 py-1 text-xs text-fg transition hover:bg-brand-soft disabled:opacity-40"
            >
              存下来
            </button>
            <span className="text-[11px] text-muted">代码填 sh600519 这种带市场前缀的；认不出来就当散记存。</span>
          </div>
          {why ? <p className="text-[11px] text-warn">没存上：{why}</p> : null}
        </div>
      </Panel>

      <Panel title="笔记" note={`${list.length} 条${filter ? ` · 筛「${filter}」` : ""} · 上限 ${NOTE_MAX} 条`}>
        <div className="flex items-center gap-2 border-b border-line px-3.5 py-2">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="按代码筛，如 sh600519"
            className="w-44 rounded border border-line bg-transparent px-2 py-1 text-xs text-fg placeholder:text-muted"
          />
          {filter ? (
            <button type="button" onClick={() => setFilter("")} className="rounded border border-line px-2 py-1 text-xs text-muted hover:text-fg">
              清除
            </button>
          ) : null}
          <span className="text-[11px] text-muted">笔记是你自己记的，不是核实过的事实。研判页不引用它。</span>
        </div>

        {shown.length === 0 ? (
          <StateBlock
            kind="empty"
            title={list.length === 0 ? "还没有笔记" : "这个筛法下没有笔记"}
            hint={
              list.length === 0
                ? "上面写一条试试。想到什么记什么，回头好核对——笔记的价值全在「回头看它准不准」。"
                : "换个代码或清除筛选。"
            }
          />
        ) : (
          <table className="data-table w-full">
            <caption className="sr-only">你写的笔记：时间、关联股票、内容</caption>
            <thead>
              <tr className="border-b border-line">
                <th className={thClass("text-left")}>时间</th>
                <th className={thClass("text-left")}>关联</th>
                <th className={thClass("text-left")}>内容</th>
                <th className={thClass()}>操作</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((note) => (
                <tr key={note.id} className="border-b border-line/60 align-top">
                  <td className={tdClass("text-left whitespace-nowrap text-muted")} title={note.at}>
                    {relTimeOf(note.at)}
                  </td>
                  <td className={tdClass("text-left whitespace-nowrap")}>
                    {note.symbol ? (
                      <span>
                        <span className="text-fg">{note.name ?? note.symbol}</span>
                        <span className="ml-1 text-[11px] text-muted">{note.symbol}</span>
                      </span>
                    ) : (
                      <span className="text-muted">散记</span>
                    )}
                  </td>
                  <td className={tdClass("text-left max-w-[60ch]")}>
                    {editing === note.id ? (
                      <div className="space-y-1.5">
                        <textarea
                          value={draft}
                          onChange={(e) => setDraft(e.target.value)}
                          rows={3}
                          className="w-full resize-y rounded border border-line bg-transparent px-2 py-1.5 text-sm text-fg"
                        />
                        <div className="flex gap-1.5">
                          <button type="button" onClick={() => saveEdit(note.id)} disabled={busy} className="rounded border border-brand px-2 py-0.5 text-[11px] text-fg">
                            存
                          </button>
                          <button type="button" onClick={() => setEditing(null)} className="rounded border border-line px-2 py-0.5 text-[11px] text-muted">
                            算了
                          </button>
                        </div>
                      </div>
                    ) : (
                      <span className="whitespace-pre-wrap">{note.text}</span>
                    )}
                  </td>
                  <td className={tdClass("whitespace-nowrap")}>
                    {editing === note.id ? null : (
                      <div className="flex gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setEditing(note.id);
                            setDraft(note.text);
                          }}
                          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-fg"
                        >
                          改
                        </button>
                        <button
                          type="button"
                          onClick={() => remove(note.id)}
                          disabled={busy}
                          className="rounded border border-line px-2 py-0.5 text-[11px] text-muted hover:text-warn disabled:opacity-40"
                        >
                          删
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </Frame>
  );
}