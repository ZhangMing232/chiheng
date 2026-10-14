/**
 * 这个文件是干什么的：
 * 设置页（/settings）的服务端接口：系统状态 + 配置现状 + 数据新鲜度。
 *
 * 你需要知道的：
 * - 这一页**不做设置表单**。改选股规则在策略选股页、改 AI 档案在 /ai、推送在那边。
 *   这里只回答三个问题：系统现在什么状态、配置现在是什么值、哪些数据旧了怎么补。
 *   摆一堆跳转链接看着整齐，实际是什么都答不上来。
 * - 配置值读出来是**只读展示**。这里显示的每个值都要说清它在哪儿改，别让人以为
 *   在这儿改了就能存。
 * - 数据新鲜度的事实收集在这里（stat 文件），判据在 data-files.ts（有单测）。
 */

import { createServerFn } from "@tanstack/react-start";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DATA_FILES, allFreshness, missingRequired, type Facts, type Freshness } from "./data-files.ts";
import { readRules } from "./rules-file.ts";
import { readPrefs } from "./prefs-file.ts";

/** 配置现状。只读展示，每项都带「在哪儿改」。 */
export type ConfigRow = { label: string; value: string; where: string };

async function factsOf(root: string): Promise<Facts> {
  const out: Facts = {};
  for (const file of DATA_FILES) {
    try {
      const st = await stat(join(root, file.path));
      out[file.path] = { size: st.size, mtime: st.mtimeMs };
    } catch {
      out[file.path] = null;
    }
  }
  return out;
}

async function configRows(): Promise<ConfigRow[]> {
  const rows: ConfigRow[] = [];
  // 选股规则
  try {
    const rules = await readRules();
    rows.push({
      label: "选股规则版本",
      value: `v${rules.version} · 当日涨幅 ${rules.chgMin}~${rules.chgMax}% · 20 日涨幅 ${rules.d20Min}~${rules.d20Max}%`,
      where: "策略选股页",
    });
  } catch {
    rows.push({ label: "选股规则", value: "读不到（多半是文件没生成）", where: "策略选股页" });
  }
  // 偏好
  try {
    const prefs = await readPrefs();
    const keys = Object.entries(prefs)
      .slice(0, 6)
      .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join("/") : String(v)}`)
      .join(" · ");
    rows.push({ label: "自选偏好", value: keys || "没设过", where: "自选与持仓页" });
  } catch {
    rows.push({ label: "自选偏好", value: "读不到", where: "自选与持仓页" });
  }
  return rows;
}

export type SettingsPayload = {
  recorder: { at: number | null; ok: boolean };
  universe: { source: string | null; count: number; ageMin: number | null };
  files: Freshness[];
  missing: Freshness[];
  config: ConfigRow[];
  gaps: string[];
};

export const getSettings = createServerFn({ method: "GET" }).handler(async (): Promise<SettingsPayload> => {
  const root = process.cwd();
  const gaps: string[] = [];

  // 记账心跳
  let recorder = { at: null as number | null, ok: false };
  try {
    const parsed = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "data", "recorder.json"), "utf8")) as {
      at?: unknown;
      ok?: unknown;
    };
    recorder = { at: typeof parsed.at === "number" ? parsed.at : null, ok: parsed.ok !== false };
  } catch {
    gaps.push("读不到记账心跳 data/recorder.json——服务可能没在跑，或从没记过账");
  }

  // 行情快照
  let universe = { source: null as string | null, count: 0, ageMin: null as number | null };
  try {
    const snap = JSON.parse(await (await import("node:fs/promises")).readFile(join(root, "data", "universe-cache.json"), "utf8")) as {
      at?: unknown;
      payload?: { source?: string; quotes?: unknown[] };
    };
    const quotes = snap.payload?.quotes ?? [];
    universe = {
      source: typeof snap.payload?.source === "string" ? snap.payload.source : null,
      count: Array.isArray(quotes) ? quotes.length : 0,
      ageMin: typeof snap.at === "number" ? Math.max(0, Math.round((Date.now() - snap.at) / 60_000)) : null,
    };
    if (universe.source === "sina") {
      gaps.push("行情快照来自新浪（备源）。它的 d5/d10/d20/d60 整批为 null，依赖涨幅的策略今天会不出票");
    }
  } catch {
    gaps.push("读不到行情快照 data/universe-cache.json——页面上的实时数字会开不了");
  }

  const files = allFreshness(await factsOf(root));
  const missing = missingRequired(files);
  const config = await configRows();

  return { recorder, universe, files, missing, config, gaps };
});