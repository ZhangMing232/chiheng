/**
 * 这个文件是干什么的：
 * 全站统一的「数据可信度」状态模型：5 态 + 延迟格式化。
 * 来源：2026-11-06 外部参考实现 full-shell-implementation 的 status.ts，
 * 按本项目纪律改造（中文注释、补齐状态的中文语义、和现有 3 态判断对齐）。
 *
 * 你需要知道的：
 * - 5 态语义（README 设计规则 §3「数据可信度」）：
 *   healthy   数据可用，正常操作
 *   loading   正在请求/计算——显示骨架，**不许把旧数据当新数据展示**
 *   delayed   有数据但超过延迟阈值——显示更新时间与延迟；高风险操作降级为「仅供查看」
 *   offline   服务/数据源断开——显示最后成功时间、原因、重试
 *   unavailable 该模块没有这项数据——**写「—」或说明，不许伪造 0 或空结果**
 *     （和项目铁律「缺数据 ≠ 确认没有」是同一件事的两个说法）
 * - 和现有 3 态（useSysStatus 的 online/心跳超时/离线）的关系：那套判的是
 *   「记账进程活没活着」，这套判的是「一份数据能不能用」——层级不同，不互相替代；
 *   系统级状态继续走 StatusBar，模块级数据用这套。
 */

export type HealthState = "healthy" | "loading" | "delayed" | "offline" | "unavailable";

/** 一个数据块的可信度快照。label 是给人看的主状态语义，如「行情延迟」。 */
export type StatusSnapshot = {
  state: HealthState;
  label: string;
  /** 数据来源（如「腾讯行情」），没有就不写 */
  source?: string;
  /** 最近成功时间（本地时钟 HH:mm:ss） */
  updatedAt?: string;
  /** 延迟秒数。null = 没有可算的延迟 */
  latencySeconds?: number;
  /** 降级提示（如「当前数据仅供查看」） */
  message?: string;
  /** 可以重试吗（offline/delayed 通常为 true） */
  canRetry?: boolean;
};

export const statusMeta: Record<HealthState, { tone: "positive" | "primary" | "warning" | "negative" | "neutral"; icon: string; cn: string }> = {
  healthy: { tone: "positive", icon: "✓", cn: "正常" },
  loading: { tone: "primary", icon: "⋯", cn: "加载中" },
  delayed: { tone: "warning", icon: "◷", cn: "延迟" },
  offline: { tone: "negative", icon: "!", cn: "断开" },
  unavailable: { tone: "neutral", icon: "—", cn: "暂无数据" },
};

/** 延迟秒数 → 「87s」/「1m 27s」。null → 「—」。 */
export function formatLatency(seconds?: number | null): string {
  if (seconds == null || !Number.isFinite(seconds)) return "—";
  const sec = Math.max(0, Math.round(seconds));
  if (sec < 60) return `${sec}s`;
  return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
}

/** 一行摘要：「行情延迟 · 延迟 87s · 更新于 14:50」。 */
export function describeSnapshot(snapshot: StatusSnapshot): string {
  const parts = [snapshot.label];
  if (snapshot.latencySeconds != null) parts.push(`延迟 ${formatLatency(snapshot.latencySeconds)}`);
  if (snapshot.updatedAt) parts.push(`更新于 ${snapshot.updatedAt}`);
  return parts.join(" · ");
}
