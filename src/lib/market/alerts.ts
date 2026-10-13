/**
 * 这个文件是干什么的：
 * 研究告警（A4 的第一块，对标 Vibe-Research 的 `orchestrator/alerts.ts` + notify.ts 核心）。
 *
 * 它的机制（notify.ts 898 行原文）：到点跑垂类声明的任务 → 结果进本机收件箱 →
 * 按设置推送。三条纪律我照搬：
 *   1. **只在本程序运行时生效**：关机/没开就不会跑，界面要原样说明
 *      （不能让人以为装了就会准点推）
 *   2. **门判定取不到时不跑**：网络断、上游挂 → 不跑，并在收件箱说明一次
 *      （宁可少推一天，也不推一份看着正常实际是猜的东西）
 *   3. **同一条 24 小时内不重复推**、同一任务有冷却
 *
 * 赤轨版的告警来源：**旧预警核对**（knowledge.ts 的 checkOldPoints）。
 * 一只自选股的旧预警「已应验」→ 生成一条告警。这是 A5 档案和 A4 编排的闭环：
 * 上次说「盯什么」，这次到点自动核对，应验了就提醒人来看。
 *
 * 你需要知道的（纪律）：
 * 1. 告警只做「提醒来看」，**不含投资动作**——红线照样过（它 §0-3）。
 * 2. 去重键 = symbol + point.object + 日期。同一天同一只票同一个预警只报一次。
 * 3. 研判失败（拿不到数据）→ 不产告警，产一条「今天没跑成」的说明。
 */

import type { PointCheck } from "./knowledge.ts";

export type Alert = {
  /** 去重键：symbol + 预警对象 + 日期 */
  id: string;
  symbol: string;
  name: string;
  /** 告警类型：triggered = 旧预警应验；failed = 今天没跑成 */
  kind: "triggered" | "failed";
  title: string;
  detail: string;
  /** 告警时间（ISO） */
  at: string;
  /** 来源报告/档案（可回溯） */
  source: string;
};

/** 同一天同一只票同一个预警只报一次。 */
export function alertId(symbol: string, object: string, day: string): string {
  return `${symbol}-${object}-${day}`;
}

/** 今天（YYYY-MM-DD，本地时区）。 */
function today(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 静默时段：这个点该不该推（默认 08:00-23:00，之外不推——半夜不吵人）。 */
export function inQuietHours(now = new Date(), from = 8, to = 23): boolean {
  const h = now.getHours();
  return h < from || h >= to;
}

/**
 * 从旧预警核对结果生成告警。
 *
 * 只把 **triggered**（已应验）的转成告警——「还没触发」的不推（那是日常状态，
 * 推了就是骚扰）；「待人工核对」的不推（没结论的东西推什么）。
 */
export function alertsFromChecks(
  symbol: string,
  name: string,
  checks: readonly PointCheck[],
  now = new Date(),
): Alert[] {
  const day = today(now);
  const at = now.toISOString();
  const out: Alert[] = [];
  for (const c of checks) {
    if (c.status !== "triggered") continue;
    out.push({
      id: alertId(symbol, c.point.object, day),
      symbol,
      name,
      kind: "triggered",
      title: `${name} 的预警应验了：${c.point.object}`,
      detail: c.detail,
      at,
      source: c.point.source,
    });
  }
  return out;
}

/** 研判没跑成（拿不到数据/接口挂）→ 产一条说明，不产假告警。 */
export function failureAlert(symbol: string, name: string, why: string, now = new Date()): Alert {
  return {
    id: alertId(symbol, "run-failed", today(now)),
    symbol,
    name,
    kind: "failed",
    title: `${name} 今天没研判成`,
    detail: why,
    at: now.toISOString(),
    source: "A4 定时研判",
  };
}

/**
 * 合并告警并去重（同 id 只留最新一条）。用于把新告警并进已有收件箱。
 */
export function mergeAlerts(existing: readonly Alert[], incoming: readonly Alert[]): Alert[] {
  const byId = new Map<string, Alert>();
  for (const a of existing) byId.set(a.id, a);
  for (const a of incoming) byId.set(a.id, a); // 同 id 后来者覆盖（保留最新）
  return [...byId.values()].sort((a, b) => b.at.localeCompare(a.at));
}

/** 收件箱上限，超了从最旧的砍（本机文件，不让它无限长）。 */
export const ALERT_INBOX_LIMIT = 200;

export function trimInbox(alerts: readonly Alert[]): Alert[] {
  return alerts.length <= ALERT_INBOX_LIMIT ? [...alerts] : alerts.slice(0, ALERT_INBOX_LIMIT);
}
