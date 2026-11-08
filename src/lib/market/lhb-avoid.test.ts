/**
 * 这个文件是干什么的：
 * 守住龙虎榜回避过滤器的两条硬约束，防止被回退。
 *
 * 1. **模块分层不许合回去**：src/lib/market/strategies.ts 在客户端可达图上
 *    （routeTree → routes/index.tsx → strategies.ts）。它引的 lhb-avoid.ts 必须是
 *    零 IO 的纯同步模块；一旦有人把 `import "node:fs/promises"` 挪回 lhb-avoid.ts，
 *    vite 会把 node 内置模块转成空壳桩，浏览器一访问就抛 → hydration 死 →
 *    全站按钮点不动（10-25 meanwhy.top 整站失灵，同类坑第三次）。
 *    读盘必须待在 lhb-avoid-index.server.ts（TanStack 认 .server.ts 为服务端）。
 *    check-client-graph.mjs 是通用守门，但这个测试把「分层意图」写成明文，
 *    出事时能直接看出是哪条约定被破了。
 *
 * 2. **索引没加载时必须返回 false**：宁可不多删，也不能因为漏加载而静默全删——
 *    静默全删 = 把整个股票池从候选里抹掉 = 策略当天不交易，且没人知道为什么。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";
import { getAvoidIndex, setAvoidIndex, shouldAvoid } from "@/lib/market/lhb-avoid";

const ROOT = join(import.meta.dirname, "..", "..", "..");

test("分层：客户端安全的 lhb-avoid.ts 里不许有 node 内置模块顶层 import", () => {
  const src = readFileSync(join(ROOT, "src/lib/market/lhb-avoid.ts"), "utf8");
  const offenders: string[] = [];
  const re = /(?:^|\n)[ \t]*import\s+(?!type\s)[^;]*?from\s*["'](node:[^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) offenders.push(m[1]);
  assert.deepEqual(offenders, [], `lhb-avoid.ts 被拖进浏览器 bundle 了：${offenders.join(", ")}`);
});

test("分层：读盘逻辑在 lhb-avoid-index.server.ts 里（TanStack 认 .server.ts 为服务端）", () => {
  const src = readFileSync(join(ROOT, "src/lib/market/lhb-avoid-index.server.ts"), "utf8");
  assert.ok(src.includes("node:fs/promises"), "建索引的文件应负责读盘");
  assert.ok(src.includes("export async function loadAvoidIndex"), "loadAvoidIndex 应住在 .server.ts");
  // 反向断言：安全文件里不该再有 loadAvoidIndex 的实现（否则有人会把 fs 拖回来）
  const safe = readFileSync(join(ROOT, "src/lib/market/lhb-avoid.ts"), "utf8");
  assert.ok(
    !safe.includes("export async function loadAvoidIndex"),
    "loadAvoidIndex 的实现不该出现在客户端安全文件里",
  );
});

test("安全默认：索引未加载时 shouldAvoid 返回 false（不能静默全删）", () => {
  setAvoidIndex(null as unknown as Map<string, string[]>); // 显式清空，不依赖测试执行顺序
  assert.equal(getAvoidIndex(), null, "清空后索引应为 null");
  assert.equal(shouldAvoid("sz301486", "2026-10-26", 20), false);
});

test("shouldAvoid：窗口内的事件票被剔除，窗口外的保留", () => {
  const m = new Map<string, string[]>([["sz301486", ["2026-10-26"]]]);
  setAvoidIndex(m);
  assert.equal(shouldAvoid("sz301486", "2026-10-26", 20), true, "事件当天应剔除");
  // 事件日 + 40 天，窗口 20 天 → 早已冷却
  assert.equal(shouldAvoid("sz301486", "2026-12-05", 20), false, "冷却后应保留");
  assert.equal(shouldAvoid("sz999999", "2026-10-26", 20), false, "无事件票应保留");
  setAvoidIndex(null as unknown as Map<string, string[]>);
});
