/**
 * 这个文件是干什么的：
 * 账本备份的加固版（从 record-journal.ts 抽出，原来内联在那里的 backup()）。
 *
 * 原版的三个问题（2026-10-13  E3 加固时发现）：
 *   1. **备份失败会拖垮记账进程**——copyFile 抛错被外层 unhandledRejection 接住，
 *      直接 mark(false) + exit(1)。备份是冗余，不该有让主流程陪葬的权力。
 *   2. **无轮换**——每天一份按日期存，永不清理，半年后目录无限长。
 *   3. **无校验**——复制完就算成功，复制到一半断电就是一份坏 JSON，
 *      而坏备份比没备份更危险（真出事时它顶着「备份」的名字）。
 *
 * 加固后：
 *   - 任何失败都返回 { ok, reason }，**不抛**——主流程照常记账
 *   - 保留最近 BACKUP_KEEP_DAYS 份，超出清理（pruneBackups）
 *   - 备份后校验（JSON 可解析），坏的不留、更不用它覆盖好备份
 */

import { access, copyFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

/** 保留最近多少份备份（约一个半月，够回溯又不无限长）。 */
export const BACKUP_KEEP_DAYS = 45;

export type BackupResult = { ok: boolean; reason?: string; path?: string };

/** 备份目录：~/chiheng-backup/<userId>/（和原来一致）。 */
export function backupDir(userId: string, home = homedir()): string {
  return join(home, "chiheng-backup", userId);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** 校验备份可用：JSON 能解析且有结构（books 数组或 entries 数组）。坏的不算备份。 */
export async function verifyBackup(path: string): Promise<boolean> {
  try {
    const raw = await readFile(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return false;
    const rec = parsed as Record<string, unknown>;
    return Array.isArray(rec.trades) || Array.isArray(rec.entries) || Array.isArray(rec.days);
  } catch {
    return false;
  }
}

/**
 * 备份账本。源不存在 → { ok: true }（幂等：没账本就没什么可备）。
 * 任何失败都不抛，返回原因让调用方记日志。
 */
export async function backupJournal(userId: string, date: string, root = process.cwd(), home = homedir()): Promise<BackupResult> {
  const from = join(root, "data", "books", `${userId}.json`);
  if (!(await exists(from))) return { ok: true, reason: "账本还不存在，跳过备份" };

  try {
    const dir = backupDir(userId, home);
    await mkdir(dir, { recursive: true });
    const to = join(dir, `journal-${date}.json`);
    await copyFile(from, to);
    // 校验：复制完的这一份必须是好 JSON，否则删掉并报错（不留坏备份）
    if (!(await verifyBackup(to))) {
      await unlink(to).catch(() => {});
      return { ok: false, reason: "备份校验失败（不是可解析的账本 JSON），已删除坏文件" };
    }
    return { ok: true, path: to };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * 清理旧备份，只留最近 keepDays 份。返回删掉的份数。
 * 失败不抛（清理是家务，不该影响主流程）。
 */
export async function pruneBackups(userId: string, keepDays = BACKUP_KEEP_DAYS, home = homedir()): Promise<number> {
  const dir = backupDir(userId, home);
  try {
    const names = await readdir(dir);
    const dated = names
      .map((name) => ({ name, date: name.match(/^journal-(\d{4}-\d{2}-\d{2})\.json$/)?.[1] }))
      .filter((x): x is { name: string; date: string } => x.date != null)
      .sort((a, b) => b.date.localeCompare(a.date));
    const stale = dated.slice(keepDays);
    for (const item of stale) {
      await unlink(join(dir, item.name)).catch(() => {});
    }
    return stale.length;
  } catch {
    return 0;
  }
}

/** 备份目录里现在有几份（监控/排查用）。 */
export async function countBackups(userId: string, home = homedir()): Promise<number> {
  try {
    const names = await readdir(backupDir(userId, home));
    return names.filter((n) => /^journal-\d{4}-\d{2}-\d{2}\.json$/.test(n)).length;
  } catch {
    return 0;
  }
}

/** 最近一份备份的日期（没有返回 null）。 */
export async function latestBackupDate(userId: string, home = homedir()): Promise<string | null> {
  try {
    const names = await readdir(backupDir(userId, home));
    const dated = names.map((n) => n.match(/^journal-(\d{4}-\d{2}-\d{2})\.json$/)?.[1]).filter((d): d is string => d != null);
    return dated.length > 0 ? dated.sort().pop()! : null;
  } catch {
    return null;
  }
}

/** 备份文件大小（排查用，没有返回 null）。 */
export async function backupSize(userId: string, date: string, home = homedir()): Promise<number | null> {
  try {
    const info = await stat(join(backupDir(userId, home), `journal-${date}.json`));
    return info.size;
  } catch {
    return null;
  }
}
