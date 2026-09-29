/**
 * 这个文件是干什么的：
 * 规定隔多久再问一次「外部连接的授权好了没有」，以及最多问到什么时候。
 *
 * 你需要知道的：
 * 日常选股不用改这里。
 */

export const READINESS_PROBE_DELAYS_MS = [1_000, 2_000, 3_000, 5_000] as const;

export const READINESS_PROBE_MAX_TOTAL_MS = 3 * 60_000;

export function readinessProbeDelayMs(attempt: number): number {
  const index = Math.min(
    Math.max(attempt, 0),
    READINESS_PROBE_DELAYS_MS.length - 1,
  );
  return READINESS_PROBE_DELAYS_MS[index];
}

export function readinessProbeExhausted(
  startedAtMs: number,
  nowMs: number,
): boolean {
  return nowMs - startedAtMs >= READINESS_PROBE_MAX_TOTAL_MS;
}
