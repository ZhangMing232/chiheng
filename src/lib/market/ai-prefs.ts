/**
 * 这个文件是干什么的：
 * AI 偏好开关（data/ai-prefs.json），目前只有一个：autoEvolve = 收盘后让记账
 * 进程每天自动跑一轮进化（因子层 + 策略层各一次）。和 ai-config.json 分开存——
 * 接口配置清空时开关的态不丢，重新配好接口自动进化就接着生效。
 *
 * 你需要知道的：
 * 1. 自动进化的去重靠 ai-log.json，但口径是「层」不是「天」：今天这层已有
 *    ok=true 的记录才跳过；ok=false 只算一次失败尝试，当天按 AUTO_RETRY
 *    （evolve-breaker.ts，上限 3 次 / 间隔 30 分钟）自动补跑。
 * 2. 开关只控制「自动触发」，/ai 页的手动按钮任何时候都能跑。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type AIPrefs = { autoEvolve: boolean };

export const DEFAULT_AI_PREFS: AIPrefs = { autoEvolve: false };

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

const aiPrefsPath = () => join(dataDir(), "ai-prefs.json");

/** 读开关。文件不存在 / 坏了 / 字段类型不对 → 全默认（关），绝不抛错。 */
export async function readAIPrefs(): Promise<AIPrefs> {
  try {
    const parsed = JSON.parse(await readFile(aiPrefsPath(), "utf8")) as { autoEvolve?: unknown };
    return { autoEvolve: parsed.autoEvolve === true };
  } catch {
    return { ...DEFAULT_AI_PREFS };
  }
}

export async function writeAIPrefs(prefs: AIPrefs): Promise<void> {
  await mkdir(dataDir(), { recursive: true });
  await writeFile(aiPrefsPath(), JSON.stringify({ autoEvolve: prefs.autoEvolve === true }, null, 2));
}
