/**
 * 每日对账快照（P2 报告 §5-④）。
 *
 * 为什么要有它：`/today` 名单（reviewed.json）每天被覆盖，过了当天就只剩
 * 23:30 备份里的那一份。`scripts/reconcile-p2.ts` 做 5 天评估时得翻
 * 各 full 快照目录里的 signals/reviewed.json 才凑出来——积累真实交易日样本
 * 全靠备份碰运气。这里每天收盘后把「当天信号 vs 账本成交」的对账结果落一份
 * `data/reconcile/<date>.json`，以后想扩到 20 天直接读，不用挖备份。
 *
 * 纪律：
 * - **只读账本与信号，不写回**，不改任何建仓行为；
 * - 落的是「账本 entry（真实成交）」的结论，理论成交 fill 不进快照；
 * - 读不到就写 missing 原因，不补 0（同 daily-reconcile.ts）；
 * - 同日重复跑覆盖同一份（幂等），不产生带序号后缀的碎片文件。
 */
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  reconcileDay,
  sixDigitCode,
  type ReconcileDay,
  type ReconcileResult,
  type ReconcileSignal,
} from "./daily-reconcile.ts";

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? join(process.cwd(), "data");
}

export function reconcileSnapshotPath(date: string): string {
  return join(dataDir(), "reconcile", `${date}.json`);
}

const six = (c: string | null | undefined) => sixDigitCode(c);

export type SnapshotPayload = {
  date: string;
  /** 落盘时刻（毫秒） */
  at: number;
  /** 对账结果：与页面同一份纯函数算出来的 */
  result: ReconcileResult;
  /** 当天账本成交的原始归因线索（variant/deepScan/style），供以后重算分类 */
  trades: { code: string; name: string; entry: number; style?: string; variant?: string | null; deepScan?: boolean | null }[];
};

/**
 * 落一份当天快照。返回写到的路径；读不到必要数据时返回 null + reason。
 *
 * @param args.date 交易日（YYYY-MM-DD）
 * @param args.signals /today 名单（readReviewed 的 signals 原样传）
 * @param args.days 账本 days
 * @param args.journalWhy 账本读不到时的原因
 */
export function writeReconcileSnapshot(args: {
  date: string;
  signals: ReconcileSignal[] | null;
  days: ReconcileDay[] | null;
  journalWhy?: string | null;
}): { path: string | null; reason: string | null } {
  if (!args.date) return { path: null, reason: "日期为空，不落快照" };
  const result = reconcileDay(args);
  if (result.missing && args.signals == null) {
    return { path: null, reason: result.missing };
  }
  const day = args.days?.find((d) => d.date === args.date) ?? null;
  const payload: SnapshotPayload = {
    date: args.date,
    at: Date.now(),
    result,
    trades: (day?.trades ?? []).map((t) => ({
      code: six(t.code),
      name: t.name,
      entry: t.entry,
      style: t.style,
      variant: t.variant ?? null,
      deepScan: t.deepScan ?? null,
    })),
  };
  try {
    mkdirSync(join(dataDir(), "reconcile"), { recursive: true });
    const path = reconcileSnapshotPath(args.date);
    writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    return { path, reason: null };
  } catch (err) {
    return { path: null, reason: (err as Error).message };
  }
}

/** 读某天快照；没有就是 null，不编。 */
export function readReconcileSnapshot(date: string): SnapshotPayload | null {
  const path = reconcileSnapshotPath(date);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SnapshotPayload;
  } catch {
    return null;
  }
}
