/**
 * 这个文件是干什么的：
 * 常见模型的参考价目表（元/百万 tokens，人民币）——「只填 API key 就搞定全部」
 * 的最后一块：档案不填单价时按这张表自动计价，历史没快照的调用也按它出估算。
 *
 * 你需要知道的：
 * 1. **是市场信息，会变**：asOf 标注核对月份，来源是各家官网/官方价格页
 *    （DeepSeek 2026-10 官方价，Kimi 见 ai-presets.ts 预设注释同源的官方人民币价）。
 *    价改了往表里改数，别改结构。
 * 2. **DeepSeek 有峰谷价**：表里的数是谷时价（北京时间工作日 01:00-04:00、
 *    06:00-10:00 UTC 之外全按谷时），高峰时段实际账单是 2 倍。计量保守按谷时，
 *    页面 footnote 写明「高峰时段实际可能更高」。
 * 3. **缓存命中更便宜**：DeepSeek 命中缓存的输入只收约 3%（flash $0.003 vs
 *    $0.15）。接口 usage 不区分命中与否，按全量 miss 计价——估算偏保守（偏高），
 *    实际账单只会更少。
 * 4. 匹配规则：精确名 → 退役名别名（deepseek-v4-flash 已路由到 V4.1 Flash，
 *    按 flash 价计）→ null。模型名对不上就返回 null，调用方「不算钱不瞎编」。
 */

export type ModelPrice = { prompt: number; completion: number };

/** 参考价核对时间（表里的数是截至这个月的官方价）。 */
export const AI_PRICE_ASOF = "2026-10";

/** 精确名 → 参考价（元/百万 tokens，人民币，谷时/标准价）。 */
const PRICES: Record<string, ModelPrice> = {
  // DeepSeek 官方（platform.deepseek.com，2026-10）：$0.15/$0.60、$0.66/$1.98 ×7.2
  "deepseek-flash": { prompt: 1.1, completion: 4.3 },
  "deepseek-v4-pro": { prompt: 4.7, completion: 14.1 },
  // Moonshot Kimi 官方人民币价（见 ai-presets.ts 预设注释，2026-10）
  "kimi-k2-0905-preview": { prompt: 4, completion: 16 },
  "kimi-k2.6": { prompt: 6.5, completion: 27 },
  "kimi-k2.7-code": { prompt: 6.5, completion: 27 },
  "kimi-k2.7-code-highspeed": { prompt: 6.5, completion: 54 },
  "kimi-k3": { prompt: 20, completion: 100 },
};

/** 退役/改名模型 → 现行等价模型的价（计历史账时用）。 */
const ALIASES: Record<string, string> = {
  // 2026-09-10 起 deepseek-v4-flash 由 V4.1 Flash 应答，按 flash 价计。
  "deepseek-v4-flash": "deepseek-flash",
};

/** 按模型名查参考价：精确 → 别名 → null（对不上不瞎编）。 */
export function referencePriceOf(model: string): ModelPrice | null {
  const exact = PRICES[model.trim()];
  if (exact) return exact;
  const alias = ALIASES[model.trim()];
  return alias ? (PRICES[alias] ?? null) : null;
}
