/**
 * 这个文件是干什么的：
 * 命令行跑一轮「完整进化」（和 /ai 页「跑一轮完整进化」按钮同一条编排：
 * 因子层 → 策略层 → 基因组层），给 cron / 手动验证用——不用开浏览器点按钮也能让
 * AI 闭环转起来。自动进化（autoEvolve）收盘后走的也是 runEvolveLoop。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/evolve-once.ts
 *
 * 输出：各层各自的 ok / proposed / rejected / error，退出码 0（各层都跑了，
 * 不管各自成败——成败已经记进 ai-log，这里只看结果）。
 */

import { runEvolveLoop } from "@/lib/market/evolve";
import { FACTORS } from "@/lib/market/factors";
import { readFactorRuns } from "@/lib/market/factor-runs-file";

const { agent, factor, strategy, genome } = await runEvolveLoop(
  { readRows: readFactorRuns, existingFactors: FACTORS.map((f) => ({ id: f.id, name: f.name })) },
  "manual",
  // 生产路径：基因组层跑真的（要显式声明，漏注入假实现时编排会抛错——见 evolve.ts）。
  { allowRealGenome: true },
);

const line = (label: string, r: { ok: boolean; proposed: number; rejected: number; rejectReasons: string[]; error?: string }) =>
  `${label}：${r.ok ? "ok" : "失败"}｜提议 ${r.proposed}｜拒 ${r.rejected}${r.error ? `｜${r.error}` : ""}` +
  (r.rejectReasons.length > 0 ? `\n  拒绝原因：${r.rejectReasons.join("；")}` : "");

console.log(agent ? `诊断：${agent.ok ? "ok" : `失败（${agent.error ?? "?"}）`}` : "诊断：这轮没跑成（挂了不连坐，见 ai-log）");
console.log(line("因子层", factor));
console.log(line("策略层", strategy));
console.log(line("基因组层", genome));
