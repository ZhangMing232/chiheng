/**
 * 这个文件是干什么的：
 * 钉住数据新鲜度的判据。
 *
 * 重点：
 * 1. **文件不存在 ≠ 过期**：显示「没抓过」，不显示「0 天前」。这两件事的原因不同，
 *    混成一句「数据缺失」会让人查错方向
 * 2. **必须有却没有**的项要能单独挑出来（那是真问题，不只是过期）
 * 3. TTL 查 fetch-policy，不在这里重写数字
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DATA_FILES, allFreshness, freshnessOf, missingRequired, type Facts } from "@/lib/market/data-files";

const NOW = 1_700_000_000_000;
const MIN = 60_000;

const universe = DATA_FILES.find((f) => f.path === "data/universe-cache.json")!;
const notes = DATA_FILES.find((f) => f.path === "data/notes.json")!;

test("文件不存在说「没抓过」，不是「0 天前」", () => {
  const f = freshnessOf(universe, {}, NOW);
  assert.equal(f.state, "missing");
  assert.equal(f.ageMs, null);
  assert.equal(f.sizeKb, null);
  assert.match(f.note, /没这个文件/);
  assert.match(f.refresh, /服务自己维护/, "要告诉别人怎么补");
});

test("必需项缺失和可选项缺失，说话不一样", () => {
  const required = freshnessOf(universe, {}, NOW);
  const optional = freshnessOf(notes, {}, NOW);
  assert.match(required.note, /页面有些地方会开不了/);
  assert.match(optional.note, /不影响其它页面/);
});

test("过了 TTL 就是过期，没过就是新鲜", () => {
  const fresh = freshnessOf(universe, { [universe.path]: { size: 1024 * 300, mtime: NOW - 2 * MIN } }, NOW);
  assert.equal(fresh.state, "ok");
  assert.match(fresh.note, /还新鲜/);
  const stale = freshnessOf(universe, { [universe.path]: { size: 1024 * 300, mtime: NOW - 60 * MIN } }, NOW);
  assert.equal(stale.state, "stale");
  assert.match(stale.note, /已过新鲜期/);
});

test("不看新鲜度的文件（自动记账、笔记）只报多久没更新", () => {
  const f = freshnessOf(notes, { [notes.path]: { size: 200, mtime: NOW - 3 * 24 * 60 * MIN } }, NOW);
  assert.equal(f.state, "na");
  assert.match(f.note, /3 天前更新/);
  assert.ok(f.ageMs != null, "还是要给年龄");
});

test("必需项缺失能单独挑出来（那是真问题，不只是过期）", () => {
  const cap = DATA_FILES.find((f) => f.path === "data/backtest/cap.json")!;
  const facts: Facts = {
    [universe.path]: { size: 1, mtime: NOW },
    "data/recorder.json": null,
    [cap.path]: { size: 1, mtime: NOW },
  };
  const rows = allFreshness(facts, NOW);
  const missing = missingRequired(rows);
  assert.deepEqual(missing.map((m) => m.label), ["自动记账"]);
});

test("每份文件都写了给人看的说明（refresh 不能空）", () => {
  for (const f of DATA_FILES) assert.ok(f.refresh.length > 5, `${f.path} 没写说明`);
});

test("🔴 给人看的说明里不许再出现命令行或 data/ 路径", () => {
  // 2026-11-07 用户视角走查：设置页整列都在教人开终端跑脚本，跟「打开配置文件夹」
  // 是同一个毛病。命令挪到 command 字段、页面收进折叠，这里钉住不许爬回来。
  for (const f of DATA_FILES) {
    assert.ok(!/scripts\/|python3 |npm run |data\//.test(f.refresh), `${f.path} 的说明里又有工程命令：${f.refresh}`);
  }
});

test("command 点名的脚本必须真实存在——指向不存在的脚本等于假补救", () => {
  // 2026-10-24 踩过：cap.json 的补救命令写着 build-floatcap.mjs，而那个脚本并不建
  // cap.json（它只建 floatcap.json），于是 cap.json 静默腐烂 19 天没人知道该跑什么。
  for (const f of DATA_FILES) {
    for (const m of (f.command ?? "").matchAll(/scripts\/[\w.-]+\.(?:mjs|ts|py)/g)) {
      assert.ok(existsSync(join(process.cwd(), m[0])), `${f.path} 的补救命令指向不存在的脚本：${m[0]}`);
    }
  }
});

test("两份市值快照都登记在册——漏登记的那份烂了也没人喊", () => {
  const paths = DATA_FILES.map((f) => f.path);
  assert.ok(paths.includes("data/backtest/cap.json"), "总市值快照没登记");
  assert.ok(paths.includes("data/backtest/floatcap.json"), "流通市值快照没登记");
});
// ── 过期数据要说清「影响什么」（2026-11-14）──────────────────────
// 实测：行业分类/行业月度已过期 1 个月，页面只说「已过新鲜期（6 小时）」，
// 用户会以为系统坏了或以为选股受影响。查代码：strategies.ts 完全不读行业数据。

test("🔴 登记了 impact 的，过期时要把影响面带出去", () => {
  const now = Date.now();
  const old = now - 40 * 24 * 3600_000; // 40 天前
  const fact = {
    path: "data/backtest/industry.json",
    label: "行业分类（东财三级）",
    ttlKey: "industry" as const,
    refresh: "行业分类，板块归属要用。由后台抓取任务生成",
    required: false,
    impact: "过期只影响研究页/持仓体检/板块页，不影响选股",
  };
  const r = freshnessOf(fact as never, { [fact.path]: { size: 1024, mtime: old } }, now);
  assert.equal(r.state, "stale");
  assert.match(r.impact!, /不影响选股/);
});

test("没登记 impact 的不编，留 null", () => {
  const now = Date.now();
  const fact = { path: "x.json", label: "X", ttlKey: null, refresh: "r", required: false };
  const r = freshnessOf(fact as never, { "x.json": { size: 1, mtime: now } }, now);
  assert.equal(r.impact, null, "没想清楚影响面就别猜");
});

test("真实清单里，过期风险最高的两项都登记了 impact", () => {
  // 行业数据 1 个月没更新，是最可能被误读成「系统坏了」的两项
  const industry = DATA_FILES.filter((f) => f.path.includes("industry"));
  assert.ok(industry.length >= 2);
  for (const f of industry) {
    assert.ok(f.impact, `${f.label} 应登记 impact，否则过期时用户不知道影响什么`);
    assert.match(f.impact!, /不影响|不参与/, `${f.label} 的 impact 该说清「不影响什么」`);
  }
});
