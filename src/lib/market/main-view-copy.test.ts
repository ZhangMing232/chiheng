/**
 * 主视图文案守门：不许把工程操作摆给用户。
 *
 * 2026-11-08 全量体检发现 `src/components/factor-sections.tsx` 的 RERUN_HINT
 * 里塞了一整条 `BT_FACTOR=1 node ... scripts/backtest.ts` 命令行，还被 4 个
 * 空态/提示渲染出来。这和 `data-files.test.ts` 钉的是同一条纪律，只是那份只管
 * `DATA_FILES.refresh` 字段，管不到组件常量与页面 hint。
 *
 * 用源码读取而非 import 组件：组件是 .tsx，import 会把 React/JSX 依赖拖进
 * node --test 的裸环境（不经过 vite 转换），没必要为一句文案引整个渲染栈。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const BANNED = /scripts\/|python3 |npm run |node --experimental|data\/|BT_[A-Z_]+=/;
const sections = readFileSync(join(ROOT, "src/components/factor-sections.tsx"), "utf8");

function constValue(name: string): string {
  const re = new RegExp(`export const ${name}\\s*=\\s*\\n?\\s*"([^"]*)"`);
  const m = sections.match(re);
  assert.ok(m, `找不到 ${name} 的定义`);
  return m[1];
}

test("RERUN_HINT 是给人看的话，不含命令行或工程路径", () => {
  const hint = constValue("RERUN_HINT");
  assert.ok(hint.length > 10, "提示不能是空话");
  assert.ok(!BANNED.test(hint), `提示里又有工程细节：${hint}`);
});

test("工程命令单独放在 RERUN_COMMAND，且主视图不渲染它", () => {
  const cmd = constValue("RERUN_COMMAND");
  assert.ok(cmd.includes("scripts/backtest.ts"), "开发者命令要保留可用");
  const pages = [
    "src/routes/factors/buckets.tsx",
    "src/routes/factors/gates.tsx",
    "src/routes/factors/index.tsx",
  ];
  for (const p of pages) {
    const src = readFileSync(join(ROOT, p), "utf8");
    assert.ok(!src.includes("RERUN_COMMAND"), `${p} 把开发者命令摆给用户了`);
    for (const line of src.split("\n")) {
      if (line.includes("hint=") || line.includes("hint={")) {
        assert.ok(!BANNED.test(line), `${p} 的用户提示里出现工程细节：${line.trim().slice(0, 120)}`);
      }
    }
  }
});
