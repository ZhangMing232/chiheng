/**
 * 这个文件是干什么的：
 * 把选股偏好读写到本机文件 data/prefs.json。
 *
 * 你需要知道的：
 * 文件坏了或还没有，就用默认偏好，不会抛错。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PREFS, parsePrefs, type Prefs } from "./prefs.ts";

const path = join(process.cwd(), "data", "prefs.json");

/** 读偏好。文件不存在、解析失败或内容不合法时，返回默认偏好。 */
export async function readPrefs(): Promise<Prefs> {
  try {
    return parsePrefs(JSON.parse(await readFile(path, "utf8"))) ?? DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

/** 把一份偏好写成 JSON。目录不存在会先建好。返回写进去的那一份。 */
export async function writePrefs(input: Prefs): Promise<Prefs> {
  await mkdir(join(process.cwd(), "data"), { recursive: true });
  await writeFile(path, JSON.stringify(input, null, 2));
  return input;
}
