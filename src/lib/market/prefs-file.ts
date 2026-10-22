/**
 * 这个文件是干什么的：
 * 把选股偏好读写到本机文件 data/prefs/<userId>.json（按用户分账）。
 *
 * 你需要知道的：
 * 文件坏了或还没有，就用默认偏好，不会抛错。
 * 旧的 data/prefs.json（单用户时代）会在第一次读时迁移到 dev-user 名下，之后不再动。
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_PREFS, parsePrefs, type Prefs } from "./prefs.ts";
import { OWNER_ID, safeUserId } from "./book-file.ts";

// 必须在用到的时候才 join：本文件会进客户端 bundle（quotes.functions.ts 引用），
// 浏览器里 node:path 是空壳，模块顶层调用 join 会让整站 JS 一启动就崩（2026-10-16 修过）。
const dataDir = () => process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
const prefsPath = (userId: string) => join(dataDir(), "prefs", `${safeUserId(userId)}.json`);
const legacyPath = () => join(dataDir(), "prefs.json");

/** 旧的单用户 prefs.json → dev-user 名下（rename 幂等，失败靠 try/catch 吞掉）。 */
async function migrateLegacyPrefs(): Promise<void> {
  try {
    await mkdir(join(dataDir(), "prefs"), { recursive: true });
    await rename(legacyPath(), prefsPath(OWNER_ID));
  } catch {
    // 没有旧文件，或已经迁过
  }
}

/** 读这一位用户的偏好。文件不存在、解析失败或内容不合法时，返回默认偏好。 */
export async function readPrefs(userId: string): Promise<Prefs> {
  await migrateLegacyPrefs();
  try {
    return parsePrefs(JSON.parse(await readFile(prefsPath(userId), "utf8"))) ?? DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

/** 把这一位用户的偏好写成 JSON。目录不存在会先建好。返回写进去的那一份。 */
export async function writePrefs(userId: string, input: Prefs): Promise<Prefs> {
  await mkdir(join(dataDir(), "prefs"), { recursive: true });
  await writeFile(prefsPath(userId), JSON.stringify(input, null, 2));
  return input;
}
