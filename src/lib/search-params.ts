/**
 * 这个文件是干什么的：
 * 路由 search 参数的校验助手，供各页面 validateSearch 复用。
 *
 * 为什么要有它：TanStack 路由器默认把**纯数字**的 query 值 JSON 解析成 number——
 * ?q=600519 进来是 600519（number）不是 "600519"（string）。只认 string 的校验会
 * 把它吃掉，路由认为归一化结果和 URL 不一致，307 清回 ?q=（2026-10-21 实测：
 * 多空辩论/个股研判/个股研究输入数字代码「没反应」，因子批次 ?batch=5 被清回 -1）。
 * 这里统一「string | number 都收、出 string/number」的口径，并配单测钉死。
 */

/** 股票搜索词：string 原样收，number 转字符串（600519 → "600519"），其余归空。 */
export function qParam(search: Record<string, unknown>): string {
  const raw = search.q;
  if (typeof raw === "string") return raw.trim().slice(0, 20);
  if (typeof raw === "number" && Number.isFinite(raw)) return String(raw).slice(0, 20);
  return "";
}

/** 因子批次：0=最旧，不传=最新；string/number 都收，负数/非法归 -1。 */
export function parseBatch(search: Record<string, unknown>): number {
  if (typeof search.batch === "number" && Number.isInteger(search.batch) && search.batch >= 0) {
    return Math.min(search.batch, 9999);
  }
  return typeof search.batch === "string" && /^\d+$/.test(search.batch) ? Number(search.batch) : -1;
}
