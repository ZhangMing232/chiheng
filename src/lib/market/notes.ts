/**
 * 这个文件是干什么的：
 * 笔记的数据形状和纯逻辑。笔记是**用户自己写的观察**，不是取来的数据。
 *
 * 你需要知道的（这条决定了这个模块和别的东西有什么不同）：
 * 1. **笔记不是事实，是待验证的线索**。用户写「这只票的产能要扩了」——这是判断，
 *    不是数据。所以它在任何地方都不能被当证据引用（和 A5 的旧结论同一条纪律：
 *    旧结论只当待验证项，不当事实）。页面必须标清「这是你自己记的」。
 * 2. **不跑数字闸门**。闸门管的是「结论里的数字有没有出处」，笔记里全是用户自己的
 *    数字（成本价、仓位），它们没有出处，也不该有。所以笔记**不进研判证据链**。
 * 3. 带股票代码才进得了研判页的关联列表；不带代码的是散记（纯想法）。
 * 4. 纯函数，不碰 fs、不碰时间（now 由调用方传进来，测试才可复现）。
 */

export type Note = {
  id: string;
  /** YYYY-MM-DD HH:mm（本地时间，页面按它排序） */
  at: string;
  /** 关联的股票（内部 id，如 sh600519）。散记没有代码 */
  symbol: string | null;
  name: string | null;
  text: string;
};

export const NOTE_MAX = 1000;
/** 正文的合理上限。超了就是往里塞别的东西，不是记笔记。 */
export const NOTE_TEXT_MAX = 4000;

export type NoteInput = {
  text: string;
  symbol?: string | null;
  name?: string | null;
  at: string;
  id: string;
};

/** 校验一条笔记。不合格返回原因，调用方拿它告诉用户哪儿不对。 */
export function checkNote(input: unknown): { ok: true; note: Note } | { ok: false; reason: string } {
  if (!input || typeof input !== "object") return { ok: false, reason: "不是一条笔记" };
  const v = input as Record<string, unknown>;
  const text = typeof v.text === "string" ? v.text.trim() : "";
  if (text === "") return { ok: false, reason: "内容是空的" };
  if (text.length > NOTE_TEXT_MAX) return { ok: false, reason: `内容超过 ${NOTE_TEXT_MAX} 字` };
  const at = typeof v.at === "string" ? v.at : "";
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(at)) return { ok: false, reason: "时间格式不对" };
  const id = typeof v.id === "string" && v.id !== "" ? v.id : "";
  if (id === "") return { ok: false, reason: "缺 id" };
  const symbol = typeof v.symbol === "string" && /^(sh|sz|bj)\d{6}$/.test(v.symbol) ? v.symbol : null;
  const name = typeof v.name === "string" && v.name.trim() !== "" ? v.name.trim() : null;
  return { ok: true, note: { id, at, symbol, name, text } };
}

/** 新的在前，同一天新的在后（按 id 兜底稳定排序，别让同一天的笔记乱跳）。 */
export function sortNotes(notes: readonly Note[]): Note[] {
  return [...notes].sort((a, b) => (a.at === b.at ? b.id.localeCompare(a.id) : b.at.localeCompare(a.at)));
}

/** 按股票过滤。传空 = 全部。 */
export function filterNotes(notes: readonly Note[], symbol: string | null): Note[] {
  if (!symbol) return sortNotes(notes);
  return sortNotes(notes.filter((n) => n.symbol === symbol));
}

/** 加一条。超过上限就丢最旧的一条——笔记是流水，不是档案。 */
export function addNote(notes: readonly Note[], note: Note): Note[] {
  const next = [note, ...notes.filter((n) => n.id !== note.id)];
  return next.length > NOTE_MAX ? next.slice(0, NOTE_MAX) : next;
}

/** 改一条。改不了就原样返回（别静默删）。 */
export function editNote(notes: readonly Note[], id: string, text: string): Note[] {
  const checked = checkNote({ text, at: "2000-01-01 00:00", id });
  if (!checked.ok) return [...notes];
  return notes.map((n) => (n.id === id ? { ...n, text: checked.note.text } : n));
}

/** 删一条。 */
export function removeNote(notes: readonly Note[], id: string): Note[] {
  return notes.filter((n) => n.id !== id);
}

/** 生成笔记 id：时间戳 + 随机。同毫秒写两条也不会撞。 */
export function noteId(at: string): string {
  return `${at.replace(/\D/g, "").slice(0, 12)}-${Math.random().toString(36).slice(2, 8)}`;
}