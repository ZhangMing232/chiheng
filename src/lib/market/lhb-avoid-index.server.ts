/**
 * 龙虎榜回避索引的**建索引**部分（服务端专用，读盘）。
 *
 * 【为什么要单独一个文件】src/lib/market/strategies.ts（客户端可达）要用 shouldAvoid()，
 * 而建索引必须读 node:fs。若两者同文件，顶层 import node 内置模块会把 strategies.ts
 * 拖进浏览器 bundle → 模块求值即抛 → hydration 死 → 全站按钮点不动。
 * 本文件名带 .server.ts，TanStack 认它是服务端模块，客户端图检查直接终端，不会被拖进 bundle。
 *
 * 用法（仅服务端脚本）：await loadAvoidIndex() 建好索引后，同进程里的 shouldAvoid 就能同步查。
 */
import { readFile, readdir } from "node:fs/promises";
import { LHB_THRESH, SEATS, setAvoidIndex } from "./lhb-avoid.ts";
import { codePrefix } from "./code-prefix.ts";

const RISK = "data/risk";



/** 按席位口径建索引：龙虎榜文件 → 每只票的事件日列表（已排序）。 */
async function buildIndex(mode: "all" | "noninst" = SEATS): Promise<Map<string, string[]>> {
  let names: Record<string, string> = {};
  try {
    names = JSON.parse(await readFile(`${RISK}/hotmoney-names.json`, "utf8"));
  } catch {
    // 没有名称映射就没法把席位股票名映射到代码，索引为空 = 不回避任何票（安全默认）
    return new Map();
  }
  const files = (await readdir(`${RISK}/hotmoney`)).filter((f) => f.endsWith(".json")).sort();
  const m = new Map<string, string[]>();
  for (const f of files) {
    let d: any;
    try {
      d = JSON.parse(await readFile(`${RISK}/hotmoney/${f}`, "utf8"));
    } catch {
      continue;
    }
    if (!d.date) continue;
    const agg: Record<string, number> = {};
    for (const seat of d.seats ?? []) {
      if (mode === "noninst" && seat.name === "机构") continue; // 仅游资/营业部驱动反向信号，剔除机构席位
      for (const st of seat.stocks ?? []) {
        const code = codePrefix(names[st.name]);
        if (!code) continue;
        agg[code] = (agg[code] ?? 0) + (Number(st.netWan) || 0);
      }
    }
    for (const [code, net] of Object.entries(agg)) {
      if (net >= LHB_THRESH) {
        const arr = m.get(code) ?? [];
        arr.push(d.date);
        m.set(code, arr);
      }
    }
  }
  for (const arr of m.values()) arr.sort();
  return m;
}

/**
 * 安慰剂对照：把真实事件（code, date）整体随机重分配给同样数量的股票。
 * 事件日期分布、事件总数、涉及股票数全部不变，只打乱「哪只票带印记」。
 * 若随机版效果与真实版相同 → 收益来自「少买了票」而非龙虎榜信号本身。
 * 仅供研究用：LHB_PLACEBO=1 时启用。live 路径永远不启用（默认关闭）。
 */
function placeboIndex(real: Map<string, string[]>): Map<string, string[]> {
  const entries: { code: string; dates: string[] }[] = [];
  for (const [code, dates] of real) entries.push({ code, dates });
  const allDates = entries.flatMap((e) => e.dates);
  const target = [...real.keys()];
  // Fisher-Yates 打乱代码分配
  for (let i = target.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [target[i], target[j]] = [target[j], target[i]];
  }
  const m = new Map<string, string[]>();
  const shuffled = [...allDates].sort(() => Math.random() - 0.5);
  let k = 0;
  for (let i = 0; i < entries.length; i++) {
    const code = target[i % target.length];
    const n = entries[i].dates.length;
    const arr = m.get(code) ?? [];
    for (let j = 0; j < n; j++) arr.push(shuffled[k++ % shuffled.length]);
    m.set(code, arr);
  }
  for (const arr of m.values()) arr.sort();
  return m;
}

/**
 * 一次性建索引（默认按 LHB_SEATS env 口径，通常 noninst）。
 * 不传 seatsMode 时结果写入模块级 `index`，供 shouldAvoid 同步读取；
 * 传 seatsMode 可建指定口径的索引（用于验证/对比），不影响 live 的 `index`。
 */
export async function loadAvoidIndex(seatsMode?: "all" | "noninst"): Promise<Map<string, string[]>> {
  let m = await buildIndex(seatsMode ?? SEATS);
  if (process.env.LHB_PLACEBO === "1") {
    m = placeboIndex(m);
    console.log("[lhb-avoid] 安慰剂模式：事件已随机重分配（对照实验，live 不会启用）");
  }
  if (!seatsMode) setAvoidIndex(m);
  return m;
}
