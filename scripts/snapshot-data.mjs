/**
 * 这个文件是干什么的：
 * 手动给 data/ 打一份完整快照。
 *
 * 你需要知道的：
 *
 * 1. **为什么需要它**：`record-journal.ts` 的 `backup()` 只 copyFile 一本账
 *    （`data/books/<userId>.json`），而 `factor-queue.json`、`challengers.json`、
 *    `ai-log.json`、`ai-config.json`、`factor-tombstones.jsonl` 这些**没有任何版本保护**。
 *    `data/` 在 .gitignore 里，一次误操作或写坏就等于永久丢失——那是几百轮因子判决
 *    和 AI 提议史，重跑不回来。
 *
 * 2. **什么时候跑**：动 data/ 之前、改判决函数之前、大改造开工之前。
 *    跑完确认目录里有文件，再动手。
 *
 * 3. **保留最近 5 份**，更旧的自动清掉——不然几次就把磁盘吃掉。
 *
 * 4. 这是 `.mjs`，**纯 JS，不写类型注解**（scripts 下的 .mjs 由 node 直接跑，不做类型剥离；
 *    要带类型就写成 .ts 并用 --experimental-strip-types）。
 *
 * 用法：node scripts/snapshot-data.mjs
 */

import { mkdir, readdir, rm, cp, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const KEEP = 5;
const ROOT = process.cwd();
const SRC = join(ROOT, "data");
const OUT_DIR = join(homedir(), "chiheng-backup");

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

async function main() {
  try {
    await stat(SRC);
  } catch {
    console.error(`找不到 ${SRC}。请在项目根目录运行：node scripts/snapshot-data.mjs`);
    process.exit(1);
  }

  await mkdir(OUT_DIR, { recursive: true });
  const target = join(OUT_DIR, `full-${stamp()}`);
  await cp(SRC, target, { recursive: true });
  console.log(`✅ 已快照：${target}`);

  // 只保留最近 KEEP 份 full-*，其余清掉
  const all = await readdir(OUT_DIR);
  const snapshots = all.filter((n) => n.startsWith("full-")).sort();
  const stale = snapshots.slice(0, Math.max(0, snapshots.length - KEEP));
  for (const name of stale) {
    await rm(join(OUT_DIR, name), { recursive: true, force: true });
    console.log(`   清掉旧快照：${name}`);
  }
  console.log(`   保留 ${Math.min(snapshots.length, KEEP)} 份`);
}

await main();
