/**
 * 这个文件是干什么的：
 * 知识档案的落盘（对标 Vibe-Research 的 knowledge/companies/）。
 *
 * 你需要知道的：
 * - **一只票一份快照**（data/knowledge/<symbol>.json），新的覆盖旧的——
 *   档案是「当前认知」不是流水账。被覆盖的结论通过 manifest 的裁决记录留痕。
 * - 写入原子化（临时名带 pid+随机数），同 watchlist.ts 的理由。
 * - data/ 不在 git，换机器档案不跟过来。
 */

import { readFile, rename, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { randomInt } from "node:crypto";
import type { KnowledgeFile } from "./knowledge.ts";

function dir(root = process.cwd()): string {
  return join(root, "data", "knowledge");
}

function pathFor(symbol: string, root = process.cwd()): string {
  return join(dir(root), `${symbol}.json`);
}

/** 读一只票的档案。没有返回 null。 */
export async function loadKnowledge(symbol: string, root = process.cwd()): Promise<KnowledgeFile | null> {
  try {
    const parsed = JSON.parse(await readFile(pathFor(symbol, root), "utf-8")) as KnowledgeFile;
    if (!parsed || typeof parsed.symbol !== "string" || !Array.isArray(parsed.points)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 覆盖写一只票的档案。 */
export async function saveKnowledge(file: KnowledgeFile, root = process.cwd()): Promise<string> {
  await mkdir(dir(root), { recursive: true });
  const tmp = join(dir(root), `.knowledge.${process.pid}.${randomInt(1e9).toString(36)}.tmp`);
  await writeFile(tmp, JSON.stringify(file, null, 1), "utf-8");
  await rename(tmp, pathFor(file.symbol, root));
  return pathFor(file.symbol, root);
}
