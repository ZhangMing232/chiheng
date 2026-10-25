#!/usr/bin/env node
/**
 * 这个文件是干什么的：
 * **源码级的客户端模块图体检**——从路由入口出发，只追「浏览器真的会加载并求值」
 * 的模块，看有没有「顶层 import node 内置模块」这种一求值就崩的写法。
 *
 * 为什么需要它（2026-10-25 meanwhy.top 整站按钮失灵，同类坑第三次）：
 * - vite 把 `import { readFile } from "node:fs/promises"` 转成**顶层解构空壳桩**，
 *   浏览器一访问桩属性就抛「Module externalized」→ 模块求值即抛 →
 *   React hydration 没机会跑 → 页面能看、全站按钮点不动。
 * - 10-16、10-23 各犯过一次；10-25 是 routeTree.gen.ts 静态引全部路由，
 *   把 positions.tsx → industry-store/pe-history 的雷炸成了全站。
 * - **check-client-bundle.mjs 拦不住这次**：它扫 build 产物，而 8787 和
 *   meanwhy.top（Cloudflare 隧道）跑的都是 vite dev，产物不更新。
 *   所以要有这个源码级守门：dev 模式下也生效。
 *
 * 和 check-client-bundle.mjs 的分工：
 * - 本文件：源码静态分析，快（<1s），进 npm test 第一段（scripts）。
 * - check-client-bundle.mjs：build 产物扫描，事实基准，进 build:mac 链。
 * 两边都绿才算真干净。
 *
 * 核心算法（2026-10-25 用无头 Chrome netlog 实测校准过）：
 * TanStack Start 会把 serverFn handler 体的 import 摇出客户端 bundle——
 * 顶层 import 的符号只被 handler 用 = 浏览器现在不加载它。**但这是休眠雷**：
 * import 语句还躺在路由文件里，谁哪天在组件/loader 里多用一次这个符号
 * （不用动 import 行），模块立刻进 bundle 炸站。实测：research.tsx 顶层
 * import kline-store，loadKlines 只出现在 handler → 现在不可达；
 * positions.tsx 在 loader 里用 loadIndustry → 每页都加载（10-25 炸全站的雷）。
 * 所以：
 * - **静态 import 一律跟随**（不按 handler 摇树过滤）——休眠雷也要拦；
 * - 顶层 import node: 内置模块 → 进客户端即炸（hydration 死）→ flag；
 * - **动态 import() 按 handler 区间判**——handler 里 `await import("./db")`
 *   是明确的服务端行为，跟随它才是误报（10-23 静态裸扫的虚高来源）；
 * - `.functions.ts` / `.server.ts` 整个文件是服务端（TanStack 剥离 handler 体），终端；
 * - `import type` 编译擦除，剥掉。
 *
 * **动态 import node: 只提醒不拦**（warnings，不进 offenders）：
 * 项目既定安全模式就是「函数内动态 import node:」（check-client-bundle.mjs 的修法
 * 指引也是它）。它顶层求值干净，最坏是调用时 reject——调用方都有 .catch 降级
 * （industry-store.ts:loadIndustry 等）。杀 hydration 的只有顶层静态 import。
 *
 * 跑法：node scripts/check-client-graph.mjs（--verbose 打印可达文件清单）
 * 退出码 0 = 干净；1 = 有会崩的写法
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SRC = join(ROOT, "src");

/** 浏览器一定加载的入口：router + 静态引全部路由的 routeTree（相对 src 目录）。 */
export const ENTRY_FILES = ["router.tsx", "routeTree.gen.ts"];

/** 服务端专属文件：TanStack 编译时剥离 handler 体，浏览器 bundle 里只剩 ID 注册。 */
const SERVER_ONLY = /\.(functions|server)\.tsx?$/;

/** `import ... from "x"` / `import "x"` / `import type ...`。 */
const IMPORT_RE = /(?:^|\n)[ \t]*import\s+(type\s+)?([^;]*?)[ \t]*from\s*["']([^"']+)["']/g;
const BARE_IMPORT_RE = /(?:^|\n)[ \t]*import\s*["']([^"']+)["']/g;
/** `export { a, b } from "x"` / `export * from "x"` / `export type {..} from`。 */
const EXPORT_FROM_RE =
  /(?:^|\n)[ \t]*export\s+(type\s+)?(?:\*|\{[^}]*\})[ \t]*(?:as\s+[\w$]+[ \t]*)?from\s*["']([^"']+)["']/g;
/** 动态 import("x")——排除 `foo.import(` 这种成员名误配。 */
const DYNAMIC_IMPORT_RE = /(?<![\w$.])import\s*\(\s*["']([^"']+)["']\s*\)/g;
/** `.handler(` 的位置——serverFn 服务端体的起点。 */
const HANDLER_RE = /\.handler\s*\(/g;

/** import 子句里的符号表：`{ a, b as c, type D }` → 值符号 {a, b}。 */
function parseClause(clause) {
  const names = [];
  const brace = clause.match(/\{([^}]*)\}/);
  if (brace) {
    for (const part of brace[1].split(",")) {
      const seg = part.trim();
      if (!seg) continue;
      const m = seg.match(/^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/);
      if (!m) continue;
      if (/^type\s/.test(seg)) continue; // 类型符号编译擦除
      names.push(m[2] ?? m[1]);
    }
    // `* as ns` 和默认导入
    const rest = clause.replace(/\{[^}]*\}/, "").replace(/,/g, " ").trim();
    const rm = rest.match(/^\*\s+as\s+([\w$]+)$/);
    if (rm) names.push(rm[1]);
    else if (/^[\w$]+$/.test(rest)) names.push(rest);
  } else {
    const rm = clause.match(/^\*\s+as\s+([\w$]+)$/);
    if (rm) names.push(rm[1]);
    else if (/^[\w$]+$/.test(clause.trim())) names.push(clause.trim());
  }
  return names;
}

/** 找所有 `.handler(` 配平括号的区间 [start, end)。字符串里出现的同名片段会误判，保守方向是多算服务端区间——接受（实测校准兜底）。 */
function handlerRanges(text) {
  const ranges = [];
  HANDLER_RE.lastIndex = 0;
  let m;
  while ((m = HANDLER_RE.exec(text))) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let i = open;
    for (; i < text.length; i++) {
      const ch = text[i];
      if (ch === "(") depth++;
      else if (ch === ")") {
        depth--;
        if (depth === 0) break;
      }
    }
    ranges.push([m.index, Math.min(i + 1, text.length)]);
  }
  return ranges;
}

function inRanges(pos, ranges) {
  for (const [s, e] of ranges) if (pos >= s && pos < e) return true;
  return false;
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const EXT_CANDIDATES = ["", ".ts", ".tsx", ".mjs", ".js", "/index.ts", "/index.tsx", "/index.mjs", "/index.js"];

/** 解析 import 说明符到 src 内的绝对路径。包名（react 等）返回 null——node_modules 不是我们的雷区。 */
function resolveSpec(fromFile, spec) {
  let base;
  if (spec.startsWith("@/")) base = join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null;
  for (const ext of EXT_CANDIDATES) {
    const p = base + ext;
    if (existsSync(p)) {
      try {
        if (readFileSync(p, "utf8").length >= 0) return p;
      } catch {
        /* 目录等，继续试 */
      }
    }
  }
  return null;
}

/**
 * 分析客户端可达模块图。
 * @returns {{ reachable: Set<string>, parents: Map<string,string>, offenders: Array<{file:string, spec:string, names:string[], reason:string}>, warnings: Array<{file:string, spec:string}> }}
 */
export function analyze(entryFiles = ENTRY_FILES, srcRoot = SRC) {
  const reachable = new Set();
  const parents = new Map(); // 文件 → 第一个把它带进可达集的 import 者（排查「经哪条路可达」用）
  const offenders = [];
  const warnings = [];
  const queue = [];

  for (const rel of entryFiles) {
    const abs = resolve(srcRoot, rel);
    if (existsSync(abs)) {
      reachable.add(abs);
      queue.push(abs);
    }
  }

  while (queue.length) {
    const file = queue.shift();
    if (SERVER_ONLY.test(file)) continue; // 服务端专属，终端
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const hRanges = handlerRanges(text);

    // 1) 静态 import / export-from
    const stmts = [];
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(text))) {
      const [full, typeKw, clause, spec] = m;
      const start = m.index;
      const end = start + full.length;
      if (typeKw) continue; // import type：编译擦除
      stmts.push({ spec, names: parseClause(clause), start, end, dynamic: false });
    }
    BARE_IMPORT_RE.lastIndex = 0;
    while ((m = BARE_IMPORT_RE.exec(text))) {
      const start = m.index;
      const end = start + m[0].length;
      stmts.push({ spec: m[1], names: [], start, end, dynamic: false, bare: true });
    }
    EXPORT_FROM_RE.lastIndex = 0;
    while ((m = EXPORT_FROM_RE.exec(text))) {
      const [full, typeKw, spec] = m;
      if (typeKw) continue;
      const start = m.index;
      const end = start + full.length;
      stmts.push({ spec, names: [], start, end, dynamic: false, reExport: true });
    }

    for (const st of stmts) {
      // node: 内置模块没有文件目标，但必须**先** flag 再 continue——
      // 2026-10-25 踩过：flag 检查放在 resolveSpec 之后，node: spec 永远
      // resolve 不出目标 → 被 continue 静默跳过 → kline-store.ts 这种
      // 「本来就在可达集里的休眠雷」假装干净。
      if (st.spec.startsWith("node:")) {
        const why = st.bare ? "副作用 import（必求值）" : st.names.length ? `符号 ${st.names.join(",")} 可被客户端代码引用` : "export-from";
        offenders.push({ file, spec: st.spec, names: st.names, reason: why });
        continue;
      }
      const target = resolveSpec(file, st.spec);
      if (!target) continue;
      if (!reachable.has(target)) {
        reachable.add(target);
        parents.set(target, file);
        queue.push(target);
      }
    }

    // 2) 动态 import()：handler 区间外 = 客户端可达
    DYNAMIC_IMPORT_RE.lastIndex = 0;
    while ((m = DYNAMIC_IMPORT_RE.exec(text))) {
      const pos = m.index;
      if (inRanges(pos, hRanges)) continue;
      const target = resolveSpec(file, m[1]);
      if (target && !reachable.has(target)) {
        reachable.add(target);
        parents.set(target, file);
        queue.push(target);
      }
      // 动态 import node:：顶层求值干净，最坏调用时 reject（调用方 .catch 降级）——提醒，不拦
      if (m[1].startsWith("node:")) {
        warnings.push({ file, spec: m[1] });
      }
    }
  }

  // 去重（同文件同语句可能被 export-from 和 import 重复记）
  const seen = new Set();
  const deduped = offenders.filter((o) => {
    const key = `${o.file}|${o.spec}|${o.names.join(",")}|${o.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const seenW = new Set();
  const dedupedWarnings = warnings.filter((o) => {
    const key = `${o.file}|${o.spec}`;
    if (seenW.has(key)) return false;
    seenW.add(key);
    return true;
  });
  return { reachable, parents, offenders: deduped, warnings: dedupedWarnings };
}

// ---- CLI ----
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const verbose = process.argv.includes("--verbose");
  const { reachable, parents, offenders, warnings } = analyze();
  /** 从入口走到文件的 import 链（排查「经哪条路可达」用）。 */
  const pathOf = (file) => {
    const chain = [relative(ROOT, file)];
    let cur = file;
    const guard = new Set([file]);
    while (parents.has(cur) && !guard.has(parents.get(cur))) {
      cur = parents.get(cur);
      guard.add(cur);
      chain.unshift(relative(ROOT, cur));
    }
    return chain.join(" → ");
  };
  if (verbose) {
    console.log(`客户端可达文件 ${reachable.size} 个：`);
    for (const f of [...reachable].sort()) console.log(`   ${relative(ROOT, f)}`);
    if (warnings.length) {
      console.log(`\n提醒（不阻断）：${warnings.length} 处函数内动态 import node:，靠调用方 catch 降级：`);
      for (const w of warnings) console.log(`   ${relative(ROOT, w.file)} → import("${w.spec}")`);
    }
  }
  if (offenders.length === 0) {
    console.log(`✅ 客户端模块图干净（可达 ${reachable.size} 个文件，没有会崩的 node 顶层用法）`);
    process.exit(0);
  }
  console.error(`🔴 ${offenders.length} 处 node 内置模块用法会进客户端 bundle，加载即抛 externalized：`);
  for (const o of offenders) {
    console.error(`   ${relative(ROOT, o.file)} → import from "${o.spec}"（${o.reason}）`);
    console.error(`      可达路径：${pathOf(o.file)}`);
  }
  console.error("");
  console.error("修法：函数内动态 import（`const { readFile } = await import(\"node:fs/promises\")`），");
  console.error("或把该文件拆成 .server.ts / .functions.ts（TanStack 只让服务端加载）。");
  process.exit(1);
}
