/**
 * 这个文件是干什么的：
 * 读收件箱（`data/alerts.json`，run-alerts.ts 收盘后写的）。
 *
 * 你需要知道的：
 * - **data 不在 git 里**，而且告警只在服务运行时产生（它 notify 的纪律：
 *   电脑关机、服务没开就不会跑）。所以读不到 = 这台机器还没产生过告警，
 *   页面要说清「什么时候会有」，不假装有。
 * - 收件箱上限 200 条（alerts.ts:trimInbox），超了从最旧砍。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Alert } from "./alerts.ts";

/** 读收件箱。没有文件或结构不对返回空数组（调用方按空态展示）。 */
export async function loadAlertInbox(root = process.cwd()): Promise<Alert[]> {
  try {
    const parsed = JSON.parse(await readFile(join(root, "data", "alerts.json"), "utf-8")) as { alerts?: unknown };
    if (!Array.isArray(parsed?.alerts)) return [];
    return parsed.alerts.filter(
      (a): a is Alert =>
        typeof a === "object" && a != null && typeof (a as Alert).id === "string" && typeof (a as Alert).title === "string",
    );
  } catch {
    return [];
  }
}
