/**
 * 收盘后自选告警任务（A4 编排层，对标 Vibe-Research 的 notify.ts + alerts.ts）。
 *
 * 做什么：收盘后对**自选名单**里的每只票，读它的知识档案（上次的预警），
 * 用当前行情核对，应验了就生成告警进收件箱（data/alerts.json）。
 *
 * 纪律（照它 notify.ts 原文）：
 *   1. **只在本程序运行时生效**——服务没起就不会跑；界面要原样说明。
 *   2. **门判定取不到时不跑**——今天休市、行情拉不到，就不跑，并在收件箱留一条说明。
 *      宁可少推一天，也不推一份看着正常实际是猜的东西。
 *   3. **一天一次 + 24 小时去重**（告警 id 带日期，mergeAlerts 去重）。
 *
 * 谁调它：scripts/home-server.mjs 的定时器（每 60 秒检查一次是否到点）。
 * 手动跑：node --experimental-strip-types --import ./scripts/alias.mjs scripts/run-alerts.ts
 */

import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { loadUniverse } from "@/lib/market/quotes.functions";
import { loadKnowledge } from "@/lib/market/knowledge-store";
import { checkOldPoints } from "@/lib/market/knowledge";
import { alertsFromChecks, failureAlert, mergeAlerts, trimInbox, inQuietHours, type Alert } from "@/lib/market/alerts";
import { readWatchlist } from "@/lib/market/watchlist";

const INBOX = "data/alerts.json";

async function readInbox(root: string): Promise<Alert[]> {
  try {
    const parsed = JSON.parse(await readFile(join(root, INBOX), "utf-8")) as { alerts?: Alert[] };
    return Array.isArray(parsed?.alerts) ? parsed.alerts : [];
  } catch {
    return [];
  }
}

async function main() {
  const root = process.cwd();
  const now = new Date();

  // 门 1：静默时段不跑（它 notify 的规矩——半夜不吵人）
  if (inQuietHours(now)) {
    console.log("静默时段，跳过");
    return;
  }

  // 门 2：没收盘不跑（告警是收盘后核对，盘中数据没定）
  const hour = now.getHours();
  if (hour < 15) {
    console.log("未到收盘后，跳过");
    return;
  }

  const watch = await readWatchlist(root);
  if (watch.items.length === 0) {
    console.log("自选为空，没有要核对的票");
    return;
  }

  // 门 3：行情拉不到就不跑（它「门判定取不到时不跑」的规矩）
  const uni = await loadUniverse(false).catch(() => null);
  if (!uni) {
    const inbox = await readInbox(root);
    const note = failureAlert("system", "赤轨", "行情源拉不到，今天的自选核对没跑（宁少推一天，不推猜的）", now);
    await writeInbox(root, trimInbox(mergeAlerts(inbox, [note])));
    console.log("行情拉不到，已留说明，不产告警");
    return;
  }

  const byId = new Map(uni.quotes.map((q) => [q.id, q]));
  const inbox = await readInbox(root);
  const incoming: Alert[] = [];

  for (const item of watch.items) {
    const quote = byId.get(item.id) ?? null;
    if (!quote) {
      incoming.push(failureAlert(item.id, item.name, "自选里的这只票没在行情快照里（可能停牌或代码变了）", now));
      continue;
    }
    const knowledge = await loadKnowledge(item.id, root).catch(() => null);
    if (!knowledge) {
      continue; // 没档案 = 从没研判过，没有旧预警可核对（不产告警）
    }
    // 核对旧预警（估值分位另算：快照里没有分位，旧档案的 snapshot 有上次的）
    const checks = checkOldPoints(knowledge, quote, null);
    incoming.push(...alertsFromChecks(item.id, item.name, checks, now));
  }

  await writeInbox(root, trimInbox(mergeAlerts(inbox, incoming)));
  console.log(`核对 ${watch.items.length} 只自选，新增 ${incoming.length} 条，收件箱共 ${trimInbox(mergeAlerts(inbox, incoming)).length} 条`);
}

async function writeInbox(root: string, alerts: Alert[]): Promise<void> {
  await mkdir(join(root, "data"), { recursive: true });
  await writeFile(join(root, INBOX), JSON.stringify({ updatedAt: new Date().toISOString(), alerts }, null, 1), "utf-8");
}

main().catch((error) => {
  console.error("run-alerts 失败:", error instanceof Error ? error.message : error);
  process.exit(1);
});
