/**
 * 这个文件是干什么的：
 * smoke 覆盖清单的守门测试。smoke-test.mjs 的 PAGES 上一版停在 2026-10-21 的信息
 * 架构：/flow/* 五个条目全是已并入 /review/flow/* 的旧路由，10-21 之后新增的页面
 * （membership/login/admin/butler/studio/reports/overseas/notes/settings/my-stocks/
 * inbox/research/debate、资金流向 9 个子页、factors 子页、ai/rules）一页没盖；
 * NAV_PAGES 里的 /flow 侧栏入口已撤，步骤 3 必败。46 条路由只盖 23 条，漂移没人发现。
 *
 * 这个测试钉三件事：
 *   1. **活路由必须全在 PAGES 里**——加新页面不加 smoke 覆盖，这里红
 *      （活路由 = routeTree 注册的路由，减掉旧书签重定向、空白布局壳、根路径）
 *   2. **PAGES 不许列不存在的路由**——改了路由名/删了页面，这里红
 *   3. **旧书签代表 + NAV_PAGES 不许悄悄消失**——每次信息架构合并留一个重定向
 *      代表验不断链；侧栏导航项必须真的是侧栏里点得到的链接
 *
 * 为什么从 routeTree.gen.ts 推导而不是手写清单：那份文件是生成物，加路由它一定变；
 * 手写清单的话，测试和 smoke 会一起过期。注意嵌套子页在 routeTree 里注册的是
 * **相对路径**（review/signals 注册成 '/signals'），所以按 import 的文件路径推 URL。
 */
import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 旧书签重定向路由（路由文件本身不渲染页面，beforeLoad 直接送走）。
 *  每次信息架构合并往这里补一行 + 写日期；不补的话活路由判定会把它们算成漏覆盖。 */
const LEGACY_ALIASES = [
  "/screener", // 10-21 策略区合并 → /strategies/screener
  "/positions", // 10-21 策略区合并 → /strategies/positions
  "/signals", // 10-21 复盘区合并 → /review/signals
  "/calendar", // 10-21 复盘区合并 → /review/events
  "/events", // 10-21 复盘区合并 → /review/events
  "/sectors", // 10-23 资金流向合并 → /review/flow/sectors
  "/flow", // 10-23 资金流向合并 → /review/flow
];

/** 不进 PAGES 的路由，理由写清楚（别让跳过变成静默）。 */
const SKIP_WITH_REASON = {
  "/": "首页由步骤 1 单独测（菜单按钮点击 + 控制台），不走逐页扫描",
  "/strategies": "空白布局壳（只透 Outlet 不渲染），两个子页面都已覆盖",
};

/** 每个合并动作留一个重定向代表，验旧书签不断链。 */
const BOOKMARK_SAMPLES = ["/screener", "/positions", "/signals", "/calendar", "/flow/stocks"];

// ── 从 routeTree.gen.ts 的 import 清单推全部路由 URL ──────────────────────
function routeUrls() {
  const tree = readFileSync(join(root, "src/routeTree.gen.ts"), "utf8");
  const files = [...tree.matchAll(/from '\.\/routes\/([^']+)'/g)].map((m) => m[1]);
  assert.ok(files.length > 20, `routeTree import 只解析到 ${files.length} 条——正则是不是该修了`);
  const urls = new Set();
  const splatPrefixes = [];
  for (const f of files) {
    if (f === "__root") continue;
    if (f.endsWith("$")) {
      // 动态段路由（flow.$ → /flow/*）：它的子路径（/flow/stocks 等）由 PAGES
      // 直接列，这里只记前缀，phantom 检查时放行。
      splatPrefixes.push(`/${f.replace(/\.\$$/, "")}/`);
      continue;
    }
    let url = `/${f}`;
    if (f === "index") url = "/"; // 根索引：/index 剥成 / 而不是空串
    else if (url.endsWith("/index")) url = url.slice(0, -"/index".length);
    urls.add(url);
  }
  return { urls, splatPrefixes };
}

// ── 从 smoke-test.mjs 里取 PAGES / NAV_PAGES ─────────────────────────────
function smokeLists() {
  const src = readFileSync(join(root, "scripts/smoke-test.mjs"), "utf8");
  const grab = (name) => {
    const m = src.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
    assert.ok(m, `smoke-test.mjs 里找不到 ${name}`);
    return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
  };
  return { pages: grab("PAGES"), nav: grab("NAV_PAGES") };
}

const { urls, splatPrefixes } = routeUrls();
const { pages, nav } = smokeLists();
const pagePaths = pages.map((p) => p.split("?")[0]);

test("活路由全在 smoke PAGES 里（加页面不加覆盖 → 红）", () => {
  const missing = [...urls]
    .filter((u) => !LEGACY_ALIASES.includes(u) && !(u in SKIP_WITH_REASON))
    .filter((u) => !pagePaths.includes(u))
    .sort();
  assert.deepEqual(missing, [], `这些活路由没进 smoke PAGES：${missing.join(", ")}`);
});

test("PAGES 不许列不存在的路由（路由改了名/删了 → 红）", () => {
  const phantom = pagePaths.filter((p) => !urls.has(p) && !splatPrefixes.some((pre) => p.startsWith(pre)));
  assert.deepEqual(phantom, [], `PAGES 里有路由树上不存在的路径：${phantom.join(", ")}`);
});

test("PAGES 第一项是 /（步骤 1 测首页，逐页扫描 slice(1) 跳过它）", () => {
  assert.equal(pages[0], "/");
  assert.equal(new Set(pagePaths).size, pagePaths.length, "PAGES 有重复条目");
});

test("旧书签重定向代表都在（每次架构合并留一个，验不断链）", () => {
  const missing = BOOKMARK_SAMPLES.filter((p) => !pagePaths.includes(p));
  assert.deepEqual(missing, [], `旧书签代表没了：${missing.join(", ")}——合并重定向要留样本`);
});

test("NAV_PAGES 全是侧栏里点得到的链接，且都在 PAGES 里", () => {
  // 侧栏链接（含底部 pinned 的 AI 入口）和 navigate() 调用都长 to: "/..."，
  // 这里取全集——NAV_PAGES 是它的子集就够（漂移的 /flow 就是这样被抓的）。
  const navSrc = readFileSync(join(root, "src/components/screener/nav.tsx"), "utf8");
  // 侧栏链接两种写法都在：SIDEBAR 表里是 to: "/x"（对象属性），pinned 的 AI
  // 入口是 JSX to="/ai"（属性）。漏一种就会把真实入口误判成不存在。
  const linked = new Set([...navSrc.matchAll(/to[:=]\s*"(\/[^"]*)"/g)].map((m) => m[1]));
  for (const p of nav) {
    assert.ok(linked.has(p), `NAV_PAGES 的 ${p} 不是侧栏/代码里的链接——步骤 3 点不到它`);
    assert.ok(pagePaths.includes(p.split("?")[0]), `NAV_PAGES 的 ${p} 不在 PAGES 里——整页加载没覆盖它`);
  }
});
