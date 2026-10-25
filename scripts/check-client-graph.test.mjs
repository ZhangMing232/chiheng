/**
 * 这个文件是干什么的：
 * 钉死 check-client-graph.mjs 的判定规则。这套规则是对着 2026-10-25
 * meanwhy.top 整站按钮失灵（同类坑第三次）立的，每条规则背后都有一次
 * 真实事故或一次无头 Chrome 实测，所以测试要钉的是「这几条不许被优化掉」。
 *
 * 规则清单（改动任何一条都要先读 check-client-graph.mjs 的头注）：
 * A. 静态可达文件的顶层 node: import → flag（现役雷，10-25 炸全站的形态）
 * B. 符号只被 serverFn handler 用的文件 → 照样 flag（休眠雷：谁在组件里
 *    多用一次符号，模块立刻进 bundle 炸站——kline-store 就是这个形态）
 * C. .functions.ts / .server.ts 是终端；handler 内的动态 import 不跟随
 *    （TanStack 剥离 handler 体，跟随它才是 10-23 静态裸扫的虚高来源）
 * D. import type 编译擦除，不产生边
 * E. 函数内动态 import("node:...") 只 warning 不 flag（项目既定安全模式，
 *    最坏调用时 reject，靠调用方 catch 降级，不杀 hydration）
 * F. 组件里的动态 import 要跟随——目标文件的顶层 node import 是雷
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze, ENTRY_FILES } from "./check-client-graph.mjs";

/** 建一套 fixture：返回 analyze() 要的 srcRoot。 */
function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "chiheng-guard-"));
  const src = join(root, "src");
  mkdirSync(src, { recursive: true });
  const put = (name, text) => writeFileSync(join(src, name), text, "utf8");

  // 入口：模拟 routeTree 静态引全部路由
  put("routeTree.gen.ts", `import { Route as AppRouteImport } from "./app";
import { Route as ResearchRouteImport } from "./research";
export const routeTree = { AppRouteImport, ResearchRouteImport };
`);

  // 组件用 store（场景 A）；import type 被剥（场景 D）；
  // 组件里动态 import lazy-target（场景 F）；顶层 import lazy-node（场景 E 的载体）
  put("app.tsx", `import { loadThing } from "./store";
import type { Thing } from "./types-only";
import { lazyNodeThing } from "./lazy-node";
export function App() {
  return (
    <button onClick={() => { loadThing(); import("./lazy-target").then((m) => m.run()); lazyNodeThing(); }}>
      x
    </button>
  );
}
export type { Thing };
`);

  // 场景 A：顶层 node import，符号被组件链路用
  put("store.ts", `import { readFile } from "node:fs/promises";
export async function loadThing() { return readFile; }
`);

  // 场景 B：顶层 node import，符号只被 serverFn handler 用（休眠雷，照样拦）
  put("handler-only.ts", `import { readFile } from "node:fs/promises";
export async function loadHandlerOnly() { return readFile; }
`);

  // 场景 B 的载体：路由文件顶层 import 它，但只在 handler 里用
  put("research.tsx", `import { loadHandlerOnly } from "./handler-only";
export const runResearchPage = createServerFn({ method: "GET" })
  .handler(async () => {
    return loadHandlerOnly();
  });
export function ResearchPage() { return null; }
`);

  // 场景 C：.functions.ts 是终端——handler 里动态 import 的 server-util 不进闭包
  put("api.functions.ts", `import { loadHandlerOnly } from "./handler-only";
export const saveThing = createServerFn({ method: "POST" })
  .handler(async () => {
    const { readServerUtil } = await import("./server-util");
    return [loadHandlerOnly(), readServerUtil()];
  });
`);
  put("server-util.ts", `import { readFile } from "node:fs/promises";
export async function readServerUtil() { return readFile; }
`);

  // 场景 D：只被 import type 引用 → 整个文件不可达
  put("types-only.ts", `import { readFile } from "node:fs/promises";
export type Thing = { raw: typeof readFile };
`);

  // 场景 E：函数内动态 import node: —— 只提醒不拦
  put("lazy-node.ts", `export function lazyNodeThing() {
  return import("node:crypto").then((m) => m.createHash("sha256"));
}
`);

  // 场景 F：被组件动态 import 的目标，顶层 node import 是雷
  put("lazy-target.ts", `import { readFile } from "node:fs/promises";
export function run() { return readFile; }
`);

  return { root, src };
}

const rel = (root, f) => f.slice(root.length + 1).replace(/^src\//, "");

test("fixture：现役雷被拦（组件链路上的顶层 node import）", () => {
  const { root, src } = makeFixture();
  try {
    const { reachable, offenders } = analyze(["routeTree.gen.ts"], src);
    const flagged = new Set(offenders.map((o) => rel(root, o.file)));
    assert.ok(flagged.has("store.ts"), `store.ts 应被 flag，实际：${[...flagged].join(",")}`);
    assert.ok(reachable.has(join(src, "store.ts")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture：休眠雷也拦（符号只被 handler 用的文件，静态 import 照样跟随）", () => {
  const { root, src } = makeFixture();
  try {
    const { offenders } = analyze(["routeTree.gen.ts"], src);
    const flagged = new Set(offenders.map((o) => rel(root, o.file)));
    assert.ok(flagged.has("handler-only.ts"), "kline-store 同款休眠雷必须被拦，否则守门装干净");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture：.functions.ts 是终端，handler 内的动态 import 不跟随", () => {
  const { root, src } = makeFixture();
  try {
    const { reachable, offenders } = analyze(["routeTree.gen.ts"], src);
    assert.ok(!reachable.has(join(src, "server-util.ts")), "server-util 只被 handler 动态 import，不该进闭包");
    const flagged = new Set(offenders.map((o) => rel(root, o.file)));
    assert.ok(!flagged.has("server-util.ts"), "server-util 不该被 flag——跟随它正是 10-23 静态裸扫的虚高来源");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture：import type 不产生边", () => {
  const { root, src } = makeFixture();
  try {
    const { reachable } = analyze(["routeTree.gen.ts"], src);
    assert.ok(!reachable.has(join(src, "types-only.ts")), "import type 编译擦除，不能把目标带进闭包");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture：函数内动态 import node: 只提醒不拦", () => {
  const { root, src } = makeFixture();
  try {
    const { reachable, offenders, warnings } = analyze(["routeTree.gen.ts"], src);
    const flagged = new Set(offenders.map((o) => rel(root, o.file)));
    assert.ok(!flagged.has("lazy-node.ts"), "函数内动态 import node: 是项目既定安全模式，不能拦");
    assert.ok(reachable.has(join(src, "lazy-node.ts")), "但文件本身是可达的（app.tsx 顶层 import 它）");
    const warned = new Set(warnings.map((w) => rel(root, w.file)));
    assert.ok(warned.has("lazy-node.ts"), "提醒要照给");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fixture：组件里的动态 import 要跟随，目标的顶层 node import 是雷", () => {
  const { root, src } = makeFixture();
  try {
    const { reachable, offenders } = analyze(["routeTree.gen.ts"], src);
    assert.ok(reachable.has(join(src, "lazy-target.ts")), "组件路径上的动态 import 必须跟随");
    const flagged = new Set(offenders.map((o) => rel(root, o.file)));
    assert.ok(flagged.has("lazy-target.ts"), "目标文件的顶层 node import 会炸，必须 flag");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("真实码库：0 违规（19 个休眠雷 2026-10-25 已全部惰性化）", () => {
  const { offenders } = analyze();
  assert.equal(offenders.length, 0, `违规：${offenders.map((o) => o.file).join(", ")}`);
});

test("真实码库锚点：industry-store 在可达集（positions loader 用它，10-25 的炸点）", () => {
  const { reachable } = analyze();
  assert.ok(
    [...reachable].some((f) => f.endsWith("lib/market/industry-store.ts")),
    "这条路径断了说明算法漏了 routeTree → 路由文件 → store 的静态链",
  );
});

test("真实码库锚点：kline-store 在可达集但无违规（休眠雷已惰性化）", () => {
  // v3 语义：静态 import 一律跟随——kline-store 经 research.tsx 路由文件
  // 静态引用，必须在可达集里（这样将来它重新引入顶层 node import 才会被抓）。
  // 「可达但不违规」= 10-25 修好的状态；谁把它的惰性 import 改回顶层，这条会挂。
  const { reachable, offenders } = analyze();
  assert.ok(
    [...reachable].some((f) => f.endsWith("lib/market/kline-store.ts")),
    "kline-store 不在可达集 = 算法漏了 research.tsx 的静态 import 边",
  );
  assert.ok(
    !offenders.some((o) => o.file.endsWith("kline-store.ts")),
    "kline-store 有违规 = 惰性化被回退了",
  );
});

test("入口清单：router + routeTree 两个都在", () => {
  assert.deepEqual(ENTRY_FILES, ["router.tsx", "routeTree.gen.ts"]);
});
