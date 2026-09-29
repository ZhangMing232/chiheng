/**
 * 这个文件是干什么的：
 * 把早盘选股规则读写到本机文件 data/rules.json。
 *
 * 你需要知道的：
 * 选股条件没变，版本号不动；条件变了，版本号加一。文件坏了就用默认规则。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_RULES, parseRules, sameSelection, type EarlyRules } from "@/lib/market/rules";

const path = join(process.cwd(), "data", "rules.json");

/** 读规则。文件不存在或内容不合法时返回默认规则。版本号至少是 1。 */
export async function readRules(): Promise<EarlyRules> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
    const parsed = parseRules(raw);
    if (!parsed) return DEFAULT_RULES;
    const version = Number(raw.version);
    return { ...parsed, version: Number.isFinite(version) && version >= 1 ? version : 1 };
  } catch {
    return DEFAULT_RULES;
  }
}

/** 写入规则。和上一份选股条件相同则版本号不变，否则加一。返回带版本号的那一份。 */
export async function writeRules(input: EarlyRules): Promise<EarlyRules> {
  const prev = await readRules();
  const version = sameSelection(prev, input) ? prev.version : prev.version + 1;
  const next = { ...input, version };
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(path, JSON.stringify(next, null, 2));
  return next;
}
