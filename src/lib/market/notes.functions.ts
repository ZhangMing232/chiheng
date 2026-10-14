/**
 * 这个文件是干什么了：
 * 笔记页（/notes）的服务端接口：读 / 写 / 改 / 删。
 *
 * 你需要知道的：
 * - **笔记不进研判证据链**。它是用户自己写的线索，没有出处，数字闸门管不着它，
 *   研判也不引用它（和 A5 旧结论同一条纪律：只当待验证项，不当事实）。
 * - 校验失败返回 `{ok:false, reason}`，页面把 reason 原样显示给用户看，
 *   不自己编一句「保存失败」。
 * - 写失败返回 `{ok:false}`，**不吞**——页面要能说清「没存上」，否则用户以为存了。
 */

import { createServerFn } from "@tanstack/react-start";
import { addNote, checkNote, editNote, noteId, removeNote, type Note } from "./notes.ts";
import { loadNotes, saveNotes } from "./notes-store.ts";

const SYMBOL = /^(sh|sz|bj)\d{6}$/;

type Result = { ok: true; notes: Note[] } | { ok: false; reason: string; notes: Note[] };

function now(): string {
  // 上海时区，页面按它排序和显示
  return new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ");
}

export const getNotes = createServerFn({ method: "GET" }).handler(async (): Promise<Note[]> => loadNotes());

export const addNoteFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { text?: unknown; symbol?: unknown; name?: unknown })
  .handler(async ({ data }): Promise<Result> => {
    const at = now();
    const checked = checkNote({
      text: data.text,
      at,
      id: noteId(at),
      symbol: typeof data.symbol === "string" && SYMBOL.test(data.symbol) ? data.symbol : null,
      name: data.name,
    });
    const notes = await loadNotes();
    if (!checked.ok) return { ok: false, reason: checked.reason, notes };
    const saved = await saveNotes(addNote(notes, checked.note));
    if (!saved) return { ok: false, reason: "写不进 data/notes.json（权限或磁盘问题），这次没存上", notes };
    return { ok: true, notes: addNote(notes, checked.note) };
  });

export const editNoteFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { id?: unknown; text?: unknown })
  .handler(async ({ data }): Promise<Result> => {
    const notes = await loadNotes();
    const id = typeof data.id === "string" ? data.id : "";
    if (!id || !notes.some((n) => n.id === id)) return { ok: false, reason: "这条笔记不在了（可能已经被删掉）", notes };
    const text = typeof data.text === "string" ? data.text.trim() : "";
    if (text === "") return { ok: false, reason: "内容不能为空", notes };
    const next = editNote(notes, id, text);
    const saved = await saveNotes(next);
    if (!saved) return { ok: false, reason: "写不进 data/notes.json，这次没存上", notes };
    return { ok: true, notes: next };
  });

export const deleteNoteFn = createServerFn({ method: "POST" })
  .validator((input: unknown) => input as { id?: unknown })
  .handler(async ({ data }): Promise<Result> => {
    const notes = await loadNotes();
    const id = typeof data.id === "string" ? data.id : "";
    const next = removeNote(notes, id);
    const saved = await saveNotes(next);
    if (!saved) return { ok: false, reason: "写不进 data/notes.json，这次没删掉", notes };
    return { ok: true, notes: next };
  });