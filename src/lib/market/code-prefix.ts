/**
 * A 股代码 → 本项目 K 线缓存文件名前缀（sh/sz/bj + 6 位代码）。
 *
 * 2026-11-08 全量体检：这个函数原先在 6 个文件里各抄一份，全都写成
 *   if (/^[0-3]/) sz; if (/^[6-9]/) sh; if (/^[48]/) bj;
 * 顺序有 bug：`/^[6-9]/` 先吞掉 8、9 开头，导致 `[48]` 的 8 分支永远不可达，
 * 北交所 920xxx / 8xxxxx 会被错标成 sh，和 K 线缓存里的 bj9 前缀对不上 →
 * 这些票在龙虎榜索引里被静默漏掉（实测缓存里有 40 只 bj9）。
 *
 * 现在按「北交所优先」判定，并统一到这一处，避免 6 份实现各自漂移。
 * 纯函数、零 IO，客户端可达也能安全 import。
 */
export function codePrefix(code: string): string {
  // 北交所：43 / 83 / 87 / 88 / 920 开头（8、9 开头的 6 位代码）
  // 沪市 B 股 900xxx 也是 9 开头，但它带 sh 前缀；用 920 精确区分。
  if (/^(43|83|87|88|920)/.test(code)) return "bj" + code;
  if (/^[0-3]/.test(code)) return "sz" + code;
  if (/^[6-9]/.test(code)) return "sh" + code;
  return code;
}
