/**
 * 这个文件是干什么的：
 * **import 卫生测试**——静态扫 src/ 和 scripts/，抓住会让 node 跑不起来的 import 写法。
 *
 * 为什么要有它（2026-10-14 踩的，代价是记账挂了 18.7 小时）：
 * `src/lib/market/quotes.functions.ts` 里写了
 *     import { ttlOf } from "@/lib/market/fetch-policy」+「.ts」（别名后又带了后缀）
 * `@/` 别名后面又带了 `.ts`。`scripts/alias.mjs` 的逻辑是
 *     `../src/${specifier.slice(2)}.ts`
 * 于是拼出 fetch-policy 后面跟两个 .ts，**node 直接 ERR_MODULE_NOT_FOUND**。
 *
 * 要命的是**看不见**：
 * - `tsc` 不报错（TypeScript 认识 `.ts` 后缀的 import）
 * - `npm test` 759 条全绿（serverFn 文件没有被 node 侧测试 import 过）
 * - 网页照常能开（Vite 自己解析 `@/`，不走 alias.mjs）
 * 只有**记账进程**每分钟崩一次，而心跳停在 18 小时前，没人看日志就不会发现。
 *
 * 所以这条测试只做一件事：**扫出 `@/...ts` 这种写法**。它是唯一能在
 * 「网页正常、测试全绿」的情况下抓住这个 bug 的东西。
 */

import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";

const ROOT = process.cwd();
const DIRS = ["src", "scripts"];

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      out.push(...(await walk(full)));
    } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

test("🔴 @/ 别名不许带 .ts 后缀（alias 会拼成双扩展名，node 跑不起来）", async () => {
  const files: string[] = [];
  for (const dir of DIRS) files.push(...(await walk(join(ROOT, dir))));

  const bad: string[] = [];
  for (const file of files) {
    const text = await readFile(file, "utf-8");
    // 形如 import ... from 「@/ 路径 + .ts」的写法（alias 会再拼一个 .ts）
    const re = /(?:import|export)[^;\n]*?\sfrom\s*"(@\/[^"]*\.ts)"/g;
    for (const m of text.matchAll(re)) {
      bad.push(`${relative(ROOT, file)}: ${m[1]}`);
    }
    // ⚠️ **相对路径带 .ts 后缀是合法的**（`from "./fetch-policy.ts"`），别把它也拦掉：
    // node 的 --experimental-strip-types 认 .ts 扩展名，只是不认**无扩展名**
    // （`from "./fetch-policy"` → ERR_MODULE_NOT_FOUND）。src/lib/market 下有 100+
    // 处这种写法在跑着，动它之前先看证据。
    // 真正要拦的只有上面那一种：@/ 别名后面带 .ts，因为 alias.mjs 会再拼一个。
    // import「@/ 路径 + .ts」的动态形式
    for (const m of text.matchAll(/import\(\s*"(@\/[^"]*\.ts)"\s*\)/g)) {
      bad.push(`${relative(ROOT, file)}: ${m[1]}（动态 import）`);
    }
  }
  assert.deepEqual(bad, [], `这些 import 会让 node 跑不起来（@/ 后面不要再带 .ts）：\n${bad.join("\n")}`);
});

test("🔴 被 node 跑的 serverFn 文件必须真能被加载（import 路径错了当场炸）", async () => {
  // 上一轮踩的坑：quotes.functions.ts 的 import 错了，759 条测试全绿、
  // 网页正常，只有记账进程每分钟崩。所以逐个 import 一遍这些文件。
  // 全部 *.functions.ts：记账进程（home-server → record-journal）和页面 loader
  // 都会加载它们，import 路径错了就是运行时炸。**枚举而不是 glob**——
  // glob 出来的列表如果自己错了，测试会 silently 变松。
  const files = [
    "alerts.functions",
    "calendar.functions",
    "industry.functions",
    "notes.functions",
    "overseas-list.functions",
    "quotes.functions",
    "reports.functions",
    "settings.functions",
    "watchlist.functions",
  ];
  const failed: string[] = [];
  for (const name of files) {
    try {
      await import(`@/lib/market/${name}`);
    } catch (error) {
      failed.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  assert.deepEqual(failed, [], `这些 serverFn 文件加载不了：\n${failed.join("\n")}`);
});
