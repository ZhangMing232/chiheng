/**
 * 这个文件是干什么的：
 * 研报文档库的读取与检索接口（/reports 的「文档库」区用）。
 *
 * 数据是 `scripts/ingest-doc.py` 落盘到 `data/docs/` 的。这里只读文件，不做摄入
 * ——摄入是脚本的活（PDF 解析要 pypdf，放 serverFn 里会让每次页面加载都挂着）。
 *
 * 你需要知道的：
 * - **一次把整个库读进内存再检索**。个人库几十份文档、每份几千块，内存里几 MB，
 *   比每次查询去开文件快得多。文档量到几百份再说（那时该上索引）。
 * - 读不出来的文件**跳过并记原因**，不让一份坏文档让整个页面 500。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createServerFn } from "@tanstack/react-start";
import { parseDoc, searchDocs, type DocHit, type IngestedDoc } from "./docs.ts";

const DIR = () => join(process.cwd(), "data", "docs");

export type DocLibrary = {
  docs: IngestedDoc[];
  /** 读不出来的文件（带原因）——要让读者知道「库不是空的，是有几份坏了」 */
  broken: { file: string; why: string }[];
  totalChunks: number;
};

export const getDocLibrary = createServerFn({ method: "GET" }).handler(async (): Promise<DocLibrary> => {
  const dir = DIR();
  let files: string[];
  try {
    files = (await readdir(dir)).filter((n) => n.endsWith(".json"));
  } catch {
    return { docs: [], broken: [], totalChunks: 0 };
  }
  const docs: IngestedDoc[] = [];
  const broken: DocLibrary["broken"] = [];
  for (const file of files) {
    try {
      const doc = parseDoc(JSON.parse(await readFile(join(dir, file), "utf-8")));
      if (doc) docs.push(doc);
      else broken.push({ file, why: "内容认不出来（结构不对或全是空块）" });
    } catch (error) {
      broken.push({ file, why: error instanceof Error ? error.message : String(error) });
    }
  }
  docs.sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
  return {
    docs,
    broken,
    totalChunks: docs.reduce((sum, d) => sum + d.chunks.length, 0),
  };
});

export const searchDocLibrary = createServerFn({ method: "GET" })
  .validator((input: unknown): { q: string; limit: number } => {
    const v = (input ?? {}) as Record<string, unknown>;
    return {
      q: typeof v.q === "string" ? v.q.slice(0, 200) : "",
      limit: typeof v.limit === "number" ? Math.max(1, Math.min(50, Math.round(v.limit))) : 20,
    };
  })
  .handler(async ({ data }): Promise<{ hits: DocHit[]; searched: number }> => {
    const library = await getDocLibrary();
    return { hits: searchDocs(library.docs, data.q, data.limit), searched: library.docs.length };
  });
