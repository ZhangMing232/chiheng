/**
 * 这个文件是干什么的：
 * 同一只票两份研判报告的对比（学 Vibe-Research 的 reportDiff.ts）。
 *
 * 按「## 章节」对齐逐行比（LCS），只并列两次写了什么，不解读、不判断好坏——
 * 「变了」不等于「变好了」，那是读者自己的事。
 *
 * 你需要知道的（纪律）：
 * 1. **比较前必须去证据编号**。赤轨的证据 id 是内容哈希（ev-xxxx/calc-xxxx，
 *    base36），同内容同 id；但引用链 calc 行里的参数每次运行都会变（chars、refs
 *    计数），不去掉的话每一行都算「改了」。行内 id（ev-身份-收盘价 这种稳定的
 *    行 id）**不去**——它由阶段+标签决定，跨次稳定，留着还能帮助对齐。
 *    哈希 id 用前瞻限定 1-7 位 base36 且后面不许紧跟 [0-9a-z-]，防止吃掉行内 id。
 * 2. **表格分隔行和空行不算内容**（lineKey 返回 ""），变了也不报。
 * 3. 第一个「## 」之前是标题和报告 id，每次必然不同，不参与比较。
 * 4. 章节按新版顺序排，旧版有、新版没有的章节放最后标 removed。
 * 5. 纯函数零 I/O，直接单测。LCS 超 25 万格退回集合差（多报不漏报）。
 */

export type Section = { title: string; lines: string[] };
export type LineOp = { op: "add" | "del"; text: string };
export type SectionDiff = {
  title: string;
  status: "same" | "changed" | "added" | "removed";
  added: number;
  removed: number;
  /** 只列增删的行（按新版顺序穿插），没变的行不列 */
  ops: LineOp[];
};

const ID_ONE = String.raw`(?:\[(?:ev|calc)-[0-9a-z]{1,7}(?![0-9a-z-])\]|\b(?:ev|calc)-[0-9a-z]{1,7}(?![0-9a-z-])\b)`;
/** 连着写的几个编号（「[calc-a] / [calc-b]」「[ev-a]、[ev-b]」）当一个整体去掉，不留下孤零零的「/」 */
const ID_MARK = new RegExp(`${ID_ONE}(?:\\s*[/、,，]\\s*${ID_ONE})*`, "gi");
const TABLE_RULE = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;

/** 去掉哈希编号，再收拾编号留下的空括号和标点前的空格（「倍 [calc-…],」→「倍,」） */
export function stripIds(s: string): string {
  return s.replace(ID_MARK, "")
    .replace(/[(（]\s*(?:如|见|另见)?[\s/、,，;；]*[)）]/g, "")
    .replace(/\s+/g, " ")
    .replace(/ ([,，。;；:：、)）])/g, "$1")
    .trim();
}

/** 第一个「## 」之前是标题和运行信息，每次都不同，不参与比较 */
export function splitSections(md: string): Section[] {
  const out: Section[] = [];
  let cur: Section | null = null;
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const h = /^##\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h && !raw.startsWith("###")) {
      cur = { title: h[1]!.trim(), lines: [] };
      out.push(cur);
      continue;
    }
    if (cur && raw.trim()) cur.lines.push(raw.trimEnd());
  }
  return out;
}

/** 比较用的键：去掉编号、压空白；表格分隔行和空行不算内容 */
export function lineKey(s: string): string {
  if (TABLE_RULE.test(s.trim())) return "";
  return stripIds(s).replace(/\s*\|\s*/g, "|");
}

/** 给人看的样子：表格行拆成「格 · 格」，去掉编号和加粗记号 */
export function displayLine(s: string): string {
  const t = stripIds(s.replace(/\*\*/g, ""));
  if (t.startsWith("|")) {
    return t.split("|").map((c) => c.trim()).filter((c) => c && !/^[/、,，\s]+$/.test(c)).join(" · ");
  }
  return t.replace(/^#{3,}\s*/, "");
}

/** 最长公共子序列逐行对齐；太大时退回按集合比（只会多报，不会漏报） */
export function diffLines(a: string[], b: string[]): LineOp[] {
  const A = a.map((l) => ({ l, k: lineKey(l) })).filter((x) => x.k);
  const B = b.map((l) => ({ l, k: lineKey(l) })).filter((x) => x.k);
  if (A.length * B.length > 250_000) {
    const ka = new Set(A.map((x) => x.k));
    const kb = new Set(B.map((x) => x.k));
    return [
      ...A.filter((x) => !kb.has(x.k)).map((x) => ({ op: "del" as const, text: displayLine(x.l) })),
      ...B.filter((x) => !ka.has(x.k)).map((x) => ({ op: "add" as const, text: displayLine(x.l) })),
    ];
  }
  const n = A.length, m = B.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = A[i]!.k === B[j]!.k ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: LineOp[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A[i]!.k === B[j]!.k) {
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ op: "del", text: displayLine(A[i++]!.l) });
    } else {
      ops.push({ op: "add", text: displayLine(B[j++]!.l) });
    }
  }
  while (i < n) ops.push({ op: "del", text: displayLine(A[i++]!.l) });
  while (j < m) ops.push({ op: "add", text: displayLine(B[j++]!.l) });
  return ops;
}

/** 两份报告逐节对比：新版的章节按新版顺序，旧版有、新版没有的放最后 */
export function diffReports(base: string, next: string): SectionDiff[] {
  // 同名章节按出现次序配对（极少见，但别把第二个同名节和第一个比）
  const keyed = (secs: Section[]) => {
    const seen = new Map<string, number>();
    return secs.map((s) => {
      const k = lineKey(s.title);
      const n0 = seen.get(k) ?? 0;
      seen.set(k, n0 + 1);
      return { key: `${k}#${n0}`, s };
    });
  };
  const B = keyed(splitSections(base));
  const N = keyed(splitSections(next));
  const baseBy = new Map(B.map((x) => [x.key, x.s]));
  const nextKeys = new Set(N.map((x) => x.key));
  const out: SectionDiff[] = [];
  for (const { key, s } of N) {
    const old = baseBy.get(key);
    const ops = diffLines(old?.lines ?? [], s.lines);
    const added = ops.filter((o) => o.op === "add").length;
    out.push({ title: s.title, status: !old ? "added" : ops.length ? "changed" : "same", added, removed: ops.length - added, ops });
  }
  for (const { key, s } of B) {
    if (nextKeys.has(key)) continue;
    const ops = diffLines(s.lines, []);
    out.push({ title: s.title, status: "removed", added: 0, removed: ops.length, ops });
  }
  return out;
}
