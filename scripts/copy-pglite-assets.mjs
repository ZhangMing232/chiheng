/**
 * 这个文件是干什么的：
 * 构建之后，把 PGLite 运行时要读的三个二进制资源补进 .output，免得登录数据库起不来。
 *
 * 你需要知道的：
 * 打包器会把 PGlite 的 JS 打进 .output/server/_libs，但不会把 pglite.data / pglite.wasm /
 * initdb.wasm 这几个运行时按 URL 引用的资源带过去，于是服务一启动就报 ENOENT。
 * 这里从 node_modules 原包复制到产物里。日常选股不用改这里。
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDir = join(root, "node_modules", "@electric-sql", "pglite", "dist");
const targetDir = join(root, ".output", "server", "_libs");

if (!existsSync(targetDir)) {
  console.log("[copy-pglite-assets] .output/server/_libs 不存在，跳过（可能不是本机构建）。");
  process.exit(0);
}

let copied = 0;
for (const name of ["pglite.data", "pglite.wasm", "initdb.wasm"]) {
  const from = join(sourceDir, name);
  const to = join(targetDir, name);
  if (!existsSync(from)) {
    console.warn(`[copy-pglite-assets] 源文件缺失：${from}`);
    continue;
  }
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
  copied += 1;
}

console.log(`[copy-pglite-assets] 已复制 ${copied} 个 PGLite 资源到 ${targetDir}`);
