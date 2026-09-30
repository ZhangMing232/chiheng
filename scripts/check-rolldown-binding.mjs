/**
 * 这个文件是干什么的：
 * 构建之前，确认 rolldown 有当前平台对应的原生绑定，缺了就给出修复命令。
 *
 * 你需要知道的：
 * 这台 Mac 是 arm64，但 shell 里的 node 是 x86_64（Rosetta 下运行）。node_modules 若是用
 * arm64 的 npm 装的，里面只有 binding-darwin-arm64，x64 的 node 一构建就报
 * "Cannot find module '@rolldown/binding-darwin-x64'"。这里提前拦住，免得看一长串报错。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bindingDir = join(root, "node_modules", "@rolldown", `binding-${process.platform}-${process.arch}`);

if (existsSync(bindingDir)) process.exit(0);

console.error(
  `[rolldown] 缺当前平台（${process.platform}-${process.arch}）的原生绑定。\n` +
    `node_modules 里可能只有别的架构的绑定。修复：\n` +
    `  npm install --no-save --no-audit --no-fund "@rolldown/binding-${process.platform}-${process.arch}@$(node -p "require('./node_modules/rolldown/package.json').version")"\n` +
    `装完再重新构建。`,
);
process.exit(1);
