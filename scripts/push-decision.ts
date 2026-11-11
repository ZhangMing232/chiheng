/**
 * 早盘决策推送——每天 9:26 竞价审核落盘后把「今日决策」推微信。
 *
 * 为什么不是 8:30：8:30 只有昨收预判，9:26 review-auction 跑完 reviewed.json
 * 才有「可执行/观望」的实盘判决——推的是可执行，不是预判。
 *
 * 内容 = /decision 页的推送版：
 *   ① 市场在玩什么（昨日收盘的指标条 + 题材热度 + 情绪）
 *   ② 短线买什么（题材补涨腿）
 *   ③ 中长线买什么（低估值腿）
 *   ④ 什么时候卖（纪律）
 *
 * 数据全部读已落盘文件，不现场拉外部接口（避免早盘把接口打爆、也避免超时）。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/push-decision.ts [--push]
 */

import { readFile } from "node:fs/promises";

type Snapshot = { date: string; limitUp: { name?: string }[]; limitDown: unknown[]; summary?: { ladder?: { streak: number; count: number }[]; breakRate?: number | null } | null };
type Themes = { date: string; hot: { name: string; limitUp: number; avg: number; leader?: { name?: string } | null }[] };
type Reviewed = { date: string; signals: { leg?: "long" | "short"; strategy: string; name: string; code: string; buyPrice: number }[] };

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function moodOf(breakRate: number | null, maxStreak: number, ladderCount: number) {
  const br = breakRate ?? 0;
  if (br >= 0.4) return { band: "退潮", action: "炸板率高，追高被套概率大，短线少动" };
  if (maxStreak >= 5) return { band: "沸点", action: "情绪亢奋，只跟题材不追高连板" };
  if (ladderCount >= 15 && br < 0.25) return { band: "温和偏热", action: "梯队健康，短线可做题材龙头" };
  if (ladderCount < 5) return { band: "冰点", action: "情绪冷，冰点不抄底（次日−0.04%），观望" };
  return { band: "温和", action: "中性，只做有题材支撑的票" };
}

async function main() {
  const snap = await readJson<Snapshot>("data/signals/limit-pools-today.json");
  const themes = await readJson<Themes>("data/theme-heat.json");
  const reviewed = await readJson<Reviewed>("data/signals/reviewed.json");

  const ladder = snap?.summary?.ladder ?? [];
  const limitUpCount = snap?.limitUp?.length ?? 0;
  const ladderCount = ladder.reduce((n, l) => n + (l.streak >= 2 ? l.count : 0), 0);
  const maxStreak = ladder.reduce((m, l) => Math.max(m, l.streak), 0);
  const breakRate = snap?.summary?.breakRate ?? null;
  const mood = moodOf(breakRate, maxStreak, ladderCount);

  const hot = (themes?.hot ?? []).slice(0, 6);
  const shortSignals = (reviewed?.signals ?? []).filter((s) => s.leg === "short").slice(0, 6);
  const longSignals = (reviewed?.signals ?? []).filter((s) => s.leg === "long").slice(0, 6);

  const lines: string[] = [];
  lines.push("【市场在玩什么】");
  lines.push(`涨停 ${limitUpCount} · 连板 ${ladderCount} · 最高 ${maxStreak}板 · 跌停 ${snap?.limitDown?.length ?? 0} · 炸板率 ${breakRate != null ? (breakRate * 100).toFixed(0) + "%" : "—"}`);
  lines.push(`情绪：${mood.band} —— ${mood.action}`);
  if (hot.length) {
    lines.push("题材热度：");
    for (const r of hot) {
      lines.push(`  · ${r.name}｜${r.limitUp}涨停｜均${r.avg > 0 ? "+" : ""}${r.avg.toFixed(1)}%｜龙头${r.leader?.name ?? "—"}`);
    }
  }
  lines.push("");
  if (shortSignals.length) {
    lines.push("【短线买什么】热门题材的补涨股（不追高连板）");
    for (const s of shortSignals) lines.push(`  · ${s.name}(${s.code}) 挂 ${s.buyPrice}`);
  } else {
    lines.push("【短线买什么】今天没有短线信号（题材补涨腿没触发）");
  }
  lines.push("");
  if (longSignals.length) {
    lines.push("【中长线买什么】低估值（PE≤18/PB≤2，唯一实盘为正，但本质银行beta）");
    for (const s of longSignals) lines.push(`  · ${s.name}(${s.code}) 挂 ${s.buyPrice}`);
  } else {
    lines.push("【中长线买什么】今天没有低估值候选");
  }
  lines.push("");
  lines.push("【什么时候卖】");
  lines.push("  短线：断板/炸板率升到40%+/情绪退潮 → 走");
  lines.push("  中长线：跌破止损/估值到位/趋势破位（20日线拐头）→ 走");
  lines.push("");
  lines.push(`（数据：${snap?.date ?? "—"} 收盘 / 题材 ${themes?.date ?? "—"} / 信号 ${reviewed?.date ?? "—"}）`);
  lines.push("纪律：短线跟题材不追高连板（追高三连板+已证伪 −3.71%）；中长线低估值不承诺超额。");

  const body = lines.join("\n");
  console.log(body);

  if (process.argv.includes("--push")) {
    try {
      const { sendPushPlus } = await import("../src/lib/market/push.ts");
      const title = `📋 今日决策 · ${snap?.date ?? ""} · 情绪${mood.band}`;
      const sent = await sendPushPlus(title, body, "txt");
      console.log(sent ? "决策已推送微信" : "推送未发出");
    } catch (e) {
      console.log(`推送失败: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

main().catch((e) => {
  console.error("决策推送失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
