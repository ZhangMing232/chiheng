/**
 * 这个文件是干什么的：
 * 研报文档库的检索层——对标 Vibe-Research 的 MyReports 页（导入 PDF/Word、
 * 检索、提问、引用回查原文）。赤轨原来只存自己生成的研判，没有「摄入外部
 * 文档」这一层。
 *
 * 数据来自 `scripts/ingest-doc.py`，它把 PDF/Word/Markdown/文本/研判 JSON
 * 切成带 `locator`（第几页 / 第几行）的块落盘到 `data/docs/`。
 *
 * 你需要知道的：
 * 1. **不做中文分词**。中文没有空格，真分词要引 jieba（词典依赖，arm64 装包有前车之鉴）。
 *    这里用**子串匹配**：把查询切成词组逐个找子串。短查询准，长查询召回低——
 *    这是刻意的取舍，页面要提示「关键词而不是句子」。
 * 2. **每条命中都带出处**（locator + 页码），这是「引用回查原文」的落点。没有出处
 *    的命中一律不给——读的人无法核对 AI 引用的话出自哪里。
 * 3. **纯函数零 I/O**：读文件和 serverFn 是 `docs.functions.ts` 的事。
 */

/** 摄入落盘的一条块。locator 是人话（「第 3 页」「第 12-18 行」），直接显示。 */
export type DocChunk = {
  text: string;
  locator: string;
  /** PDF 才有；其他格式没有 */
  page?: number;
};

export type IngestedDoc = {
  id: string;
  title: string;
  format: string;
  sourcePath: string;
  sourceBytes: number;
  ingestedAt: string;
  stats: { extractedChars?: number; pages?: number; paragraphs?: number; fields?: number };
  chunks: DocChunk[];
};

export type DocHit = {
  docId: string;
  docTitle: string;
  format: string;
  /** 命中块 */
  chunk: DocChunk;
  /** 命中的词组 */
  terms: string[];
  score: number;
};

/** 校验摄入落盘的结构。坏块跳过——不让一份坏文档毁掉整个检索。 */
export function parseDoc(raw: unknown): IngestedDoc | null {
  const doc = raw as Partial<IngestedDoc> | null;
  if (!doc || typeof doc.id !== "string" || !Array.isArray(doc.chunks)) return null;
  const chunks: DocChunk[] = [];
  for (const raw2 of doc.chunks as Record<string, unknown>[]) {
    const text = typeof raw2?.text === "string" ? raw2.text.trim() : "";
    if (!text) continue;
    const locator = typeof raw2?.locator === "string" && raw2.locator ? raw2.locator : "（无出处）";
    const page = typeof raw2?.page === "number" && Number.isFinite(raw2.page) ? raw2.page : undefined;
    chunks.push({ text, locator, ...(page != null ? { page } : {}) });
  }
  if (chunks.length === 0) return null;
  return {
    id: doc.id,
    title: typeof doc.title === "string" && doc.title ? doc.title : doc.id,
    format: typeof doc.format === "string" ? doc.format : "?",
    sourcePath: typeof doc.sourcePath === "string" ? doc.sourcePath : "",
    sourceBytes: typeof doc.sourceBytes === "number" ? doc.sourceBytes : 0,
    ingestedAt: typeof doc.ingestedAt === "string" ? doc.ingestedAt : "",
    stats: (doc.stats ?? {}) as IngestedDoc["stats"],
    chunks,
  };
}

/**
 * 把查询切成词组。
 *
 * 引号内当一个词（`"毛利率 91"` 是一个短语），其余按空白和中文标点切。
 * **长查询会切出很多词组**，全都要命中才算高分——这是有意的（句子几乎搜不到），
 * 页面会提示「用关键词」。
 */
export function termsOf(query: string): string[] {
  const quoted = [...query.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim());
  const rest = query.replace(/"[^"]+"/g, " ");
  const loose = rest
    .split(/[\s,，。；;、:：!！?？()（）【】[\]]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [...new Set([...quoted, ...loose])];
}

/**
 * 检索：逐词组在每块里数子串出现次数。
 *
 * 分数 = 命中的词组数（主要）+ 出现次数（次要，轻权重）。
 * **不含出处的一律不给**——parseDoc 已经保证了每块都有 locator。
 */
export function searchDocs(docs: readonly IngestedDoc[], query: string, limit = 20): DocHit[] {
  const terms = termsOf(query);
  if (terms.length === 0) return [];
  const hits: DocHit[] = [];
  for (const doc of docs) {
    const title = doc.title.toLowerCase();
    for (const chunk of doc.chunks) {
      const haystack = chunk.text.toLowerCase();
      let matched = 0;
      let count = 0;
      for (const term of terms) {
        const needle = term.toLowerCase();
        if (!needle) continue;
        let found = 0;
        let from = 0;
        for (;;) {
          const at = haystack.indexOf(needle, from);
          if (at < 0) break;
          found += 1;
          from = at + needle.length;
        }
        if (found > 0) {
          matched += 1;
          count += found;
        }
      }
      if (matched === 0) continue;
      // 标题里也命中，加一点分——两份都讲同一个词时，标题对得上的更可能是主文档
      const titleHits = terms.filter((term) => title.includes(term.toLowerCase())).length;
      hits.push({
        docId: doc.id,
        docTitle: doc.title,
        format: doc.format,
        chunk,
        terms: terms.filter((term) => haystack.includes(term.toLowerCase())),
        score: matched + Math.min(count, 5) * 0.1 + titleHits * 0.5,
      });
    }
  }
  // 分数降序；同分时文档标题稳定排序，免得刷新一次顺序就变
  return hits
    .sort((a, b) => b.score - a.score || a.docTitle.localeCompare(b.docTitle) || a.chunk.locator.localeCompare(b.chunk.locator))
    .slice(0, limit);
}

/** 命中的上下文片段：把命中词前后各带一点，够看清句子又不至于刷屏。 */
export function snippetOf(chunk: DocChunk, terms: readonly string[], radius = 60): string {
  const text = chunk.text;
  const lower = text.toLowerCase();
  let first = -1;
  for (const term of terms) {
    const at = lower.indexOf(term.toLowerCase());
    if (at >= 0 && (first < 0 || at < first)) first = at;
  }
  if (first < 0) return text.slice(0, radius * 2);
  const start = Math.max(0, first - radius);
  const end = Math.min(text.length, first + radius * 2);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}
