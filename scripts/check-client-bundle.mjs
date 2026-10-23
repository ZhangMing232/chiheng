/**
 * 这个文件是干什么的：
 * **build 后的客户端 bundle 体检**——扫 .output/public 里的 JS，看有没有
 * 「顶层解构 node 内置模块」这种一加载就崩的写法。
 *
 * 为什么需要它（2026-10-23 实测的两次整站瘫痪）：
 * - vite 会把 `import { readFile } from "node:fs/promises"` 转成**顶层解构**
 *   （`const readFile = __vite__cjsImport0_...["readFile"]`）。
 * - 浏览器里 node:fs 是 vite 的空壳桩，**访问它的任何属性就抛**
 *   「Module externalized for browser compatibility」。
 * - 模块一求值就抛 → React hydration 根本没机会跑 → **整站点不动**
 *   （页面能看、按钮点不动）。SSR 正常、测试全绿，肉眼极难发现。
 * - 10-16 修过一次（只把顶层**调用**改成惰性，import 还在，症状一样），
 *   10-23 又犯了一次。
 *
 * 为什么用「扫产物」而不是「静态扫源码」：
 * TanStack Start 会剥离 serverFn handler 体的 import，静态扫源码会误报十几个
 * 实际没进 bundle 的文件（10-23 实测）。**产物是唯一的事实**。
 *
 * 跑法：node scripts/check-client-bundle.mjs（build 之后）
 * 退出码 0 = 干净；1 = 有会崩的写法
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const OUT = join(ROOT, ".output", "public");

/** 顶层（行首无缩进）解构 node 桩的形态。 */
const TOP_LEVEL_NODE_DECONSTRUCT = /^const \w+ = __vite__cjsImport\d+_node_\w+ ?\[/m;
/** 顶层 import node 内置模块（ESM 形态，没被 vite 转 CJS interop 的）。 */
const TOP_LEVEL_NODE_IMPORT = /^import\s+[^;]*?from\s+["']node:/m;
/** 顶层直接调用 node API（join(...) 之类）——10-16 那次修的是这个。 */
const TOP_LEVEL_NODE_CALL = /^(?:const|let|var|export)\s+\w+\s*=\s*[^;]*\b(?:join|resolve|existsSync|readFileSync|writeFileSync|mkdirSync)\s*\(/m;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

let files;
try {
  files = walk(OUT);
} catch {
  console.error("找不到 .output/public —— 先跑 npm run build:mac");
  process.exit(1);
}

if (files.length === 0) {
  console.log("⚠️ .output/public 里没有 JS 文件（构建可能没完成），跳过检查");
  process.exit(0);
}

const offenders = [];
for (const file of files) {
  let txt;
  try {
    txt = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (txt.includes("__vite-browser-external:node:")) {
    const reasons = [];
    if (TOP_LEVEL_NODE_DECONSTRUCT.test(txt)) reasons.push("顶层解构 node 桩");
    if (TOP_LEVEL_NODE_IMPORT.test(txt)) reasons.push("顶层 import node 内置模块");
    if (TOP_LEVEL_NODE_CALL.test(txt)) reasons.push("顶层调用 node API");
    if (reasons.length > 0) {
      offenders.push({ file: relative(ROOT, file), reasons });
    }
  }
}

if (offenders.length === 0) {
  console.log(`✅ 客户端 bundle 干净（扫了 ${files.length} 个 JS，没有会崩的 node 顶层用法）`);
  process.exit(0);
}

console.error(`🔴 客户端 bundle 里有 ${offenders.length} 个文件会导致整站点击失灵：`);
for (const o of offenders) {
  console.error(`   ${o.file} → ${o.reasons.join("、")}`);
}
console.error("");
console.error("修法：把 node 内置模块改成**函数内动态 import**");
console.error("（`const { readFile } = await import(\"node:fs/promises\")`），");
console.error("或者把该文件拆成 .server.ts（TanStack 会只让服务端加载）。");
process.exit(1);
