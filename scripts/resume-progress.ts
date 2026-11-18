/**
 * 这个文件是干什么的：
 * D-RESUME 恢复实验的每日进度推送（2026-11-17 预登记，design/RESUME-DOWN-SHAPES）。
 * 每天收盘后统计两个解冻变体（rebound-hold12 / trend-stop8）的新样本数、
 * 持仓浮盈，微信推给主人——2 周判决期内不用主动查，进度自动上门。
 *
 * 为什么独立脚本：record-journal 已经 1500 行，再塞推送逻辑会更难维护；
 * scan-short-forms 的先例就是独立脚本 + 家用服务器定时拉起。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/resume-progress.ts
 * 频率：收盘后（家用服务器 15:40 档拉起，和事件流采集同窗口）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const OWNER_ID = "dev-user";
const VARIANTS = ["rebound-hold12", "trend-stop8"] as const;
/** 解冻日（experiment-allowlist.json 的 at），样本从这里起算。 */
async function resumeSince(): Promise<string> {
  const allow = JSON.parse(await readFile("data/experiment-allowlist.json", "utf8")) as { at?: string };
  return allow.at ?? "2026-11-17";
}

async function main() {
  const since = await resumeSince();
  const book = JSON.parse(await readFile(join(process.cwd(), "data", "books", `${OWNER_ID}.json`), "utf8")) as {
    days: { date: string; trades: { id: string; name: string; entry: number; exit?: number | null; exitDate?: string | null; variant?: string }[] }[];
  };
  const universeCache = JSON.parse(await readFile(join(process.cwd(), "data", "universe-cache.json"), "utf8")) as {
    payload: { quotes: { id: string; name: string; price: number; chg: number | null }[] };
  };
  const priceById = new Map(universeCache.payload.quotes.map((q) => [q.id, q]));

  const lines: string[] = [];
  let anyPosition = false;
  for (const v of VARIANTS) {
    // 解冻后的新样本：买入日 >= since
    const newTrades = book.days
      .filter((d) => d.date >= since)
      .flatMap((d) => d.trades.filter((t) => t.variant === v).map((t) => ({ ...t, buyDay: d.date })));
    const closed = newTrades.filter((t) => t.exit != null);
    const open = newTrades.filter((t) => t.exit == null);
    const wins = closed.filter((t) => (t.exit! - t.entry) / t.entry > 0).length;
    lines.push(`【${v}】新样本 ${newTrades.length}/12（已平 ${closed.length} · 胜 ${wins}）`);
    for (const t of open) {
      const q = priceById.get(t.id);
      anyPosition = true;
      if (q?.price) {
        const pnl = ((q.price - t.entry) / t.entry) * 100;
        lines.push(`  持仓 ${t.name} ${t.entry}→${q.price} (${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}%)`);
      } else {
        lines.push(`  持仓 ${t.name} ${t.entry}（现价取不到）`);
      }
    }
    for (const t of closed.slice(-3)) {
      const ret = ((t.exit! - t.entry) / t.entry) * 100;
      lines.push(`  已平 ${t.name} ${t.entry}→${t.exit} ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}% (${t.exitDate})`);
    }
  }
  // 链路健康段（2026-11-18 加）：今天两变体各该尝试买 1 笔，没买到要写原因——
  // 12 天判决期里任何一天静默断链都会少 1 个样本，堆积起来判决就不可信。
  try {
    const today = new Date().toLocaleDateString("sv-SE");
    const log = await readFile(join(process.cwd(), "data", "serve.log"), "utf8").catch(() => "");
    const todayLines = log.split("\n").filter((l) => l.startsWith(today));
    const health: string[] = [];
    for (const v of VARIANTS) {
      const bought = todayLines.some((l) => l.includes(`bought-challenge ${OWNER_ID} ${today}`) && l.includes(v));
      const skipped = todayLines.filter((l) => l.includes(`challenger-skip ${OWNER_ID} ${today} ${v}`)).map((l) => l.slice(l.indexOf(v) + v.length + 1, l.indexOf(v) + v.length + 61));
      if (bought) health.push(`✓ ${v} 今日已建仓`);
      else if (skipped.length) health.push(`⚠ ${v} 今日未建仓：${skipped[0]}`);
      else if (new Date().getHours() < 15) health.push(`… ${v} 今日还没到买入窗口`);
      else health.push(`⚠ ${v} 今日无建仓记录也无跳过日志——查名单是否为空`);
    }
    lines.push("──────────────────");
    lines.push("链路健康：");
    for (const h of health) lines.push(`  ${h}`);
  } catch {
    // 健康段失败不影响主推送
  }
  // 每日赚钱研究名单（2026-11-17 用户要求）：按环境战绩排序的候选，数据研究非建议。
  try {
    const cand = JSON.parse(await readFile(join(process.cwd(), "data", "daily-candidates.json"), "utf8")) as {
      picks?: Record<string, { 历史战绩?: { n: number; win: number; avg: number } | null; 候选?: { name: string; 挂单?: number }[] }>;
    };
    lines.push("──────────────────");
    lines.push("今日研究名单（按账本战绩排序，非投资建议）：");
    for (const [shape, info] of Object.entries(cand.picks ?? {})) {
      const p = info.历史战绩;
      const names = (info.候选 ?? []).map((c) => `${c.name}(${c.挂单 ?? "?"})`).join("、");
      lines.push(`  ${shape}（n=${p?.n ?? "?"} 胜率${p?.win ?? "?"}% 均${p?.avg ?? "?"}%）：${names}`);
    }
  } catch {
    // 名单生成失败不阻断主推送
  }
  // 大盘温度计（2026-11-18）：回测 121 天超额 +12.26pp，熊市里跟着它少亏一半。
  try {
    const idxCloses = JSON.parse(await readFile(join(process.cwd(), "data", "index-closes.json"), "utf8")) as { date: string; close: number }[];
    const { todayRegime } = await import("../src/lib/market/regime-thermometer.ts");
    const t = todayRegime(idxCloses);
    if (t) {
      lines.push("──────────────────");
      lines.push(`🌡 大盘温度计 ${t.date}：${t.regime}（沪深300 ${t.close}，MA20 ${t.ma20.toFixed(0)}，偏离 ${t.aboveMa20Pct.toFixed(1)}%，MA20斜率 ${t.ma20SlopePct.toFixed(2)}%）`);
      if (t.regime === "空仓") lines.push("  → 今日不买任何新票，持仓票按止损纪律执行");
      else if (t.regime === "观察") lines.push("  → 可能筑底，只允许已持仓票企稳加仓，不开新仓");
      else lines.push("  → 转牛信号，可以分批进攻");
      // 刷新 index-closes（用最新数据，明天回测也用）
      await writeFile(join(process.cwd(), "data", "index-closes.json"), JSON.stringify(idxCloses));
    }
  } catch {
    // 温度计失败不阻断主推送
  }
  // 主线抄底（2026-11-18）：回测160笔+0.47%/笔胜率55.6%，进攻信号。
  try {
    const md = JSON.parse(await readFile(join(process.cwd(), "data", "mainline-dip.json"), "utf8")) as {
      matched?: number; rows?: { name: string; chg: number; volRatio: number | null; themes: string[] }[];
      backtest?: { avgPct: number; winRate: number };
    };
    if (md.rows?.length) {
      lines.push("──────────────────");
      lines.push(`主线抄底候选（${md.matched} 只，回测 +${md.backtest?.avgPct}%/笔 胜率 ${md.backtest?.winRate}%，次日开盘买/再次日卖）：`);
      for (const r of md.rows.slice(0, 5)) {
        lines.push(`  ${r.name} 今日${r.chg.toFixed(1)}% 量比${r.volRatio ?? "?"}｜${(r.themes ?? []).slice(0,2).join("、")}`);
      }
      lines.push("（进攻信号未实盘验证，单笔≤20%仓位，一字跌停不追）");
    }
  } catch {
    // 没扫就没这段
  }
  // 游资追踪名单（2026-11-18）：龙虎榜游资大额净买，回测次日超额 +0.975pp。
  try {
    const ss = JSON.parse(await readFile(join(process.cwd(), "data", "seat-signals.json"), "utf8")) as {
      seatDate?: string;
      matched?: number;
      rows?: { name: string; price: number | null; hotNetWan: number; chg: number | null }[];
      backtest?: { nextDayEdgePp: number; nextDayWinRate: number };
    };
    if (ss.rows?.length) {
      lines.push("──────────────────");
      lines.push(`游资追踪 ${ss.seatDate}（${ss.matched} 只，回测次日超额 +${ss.backtest?.nextDayEdgePp}pp/胜率 ${ss.backtest?.nextDayWinRate}%，只做次日）：`);
      for (const r of ss.rows.slice(0, 6)) {
        lines.push(`  ${r.name} ${r.price ?? "?"}｜游资净买 ${(r.hotNetWan / 10000).toFixed(2)}亿`);
      }
      lines.push("（观察名单，未经判决转正，不建仓）");
    }
  } catch {
    // 没扫就没这段
  }
  // 启动前兆观察名单（2026-11-18）：资金+量能+位置+题材 四条件，未验证。
  try {
    const es = JSON.parse(await readFile(join(process.cwd(), "data", "early-signals.json"), "utf8")) as {
      matched?: number;
      rows?: { name: string; code: string; price: number; why: string }[];
    };
    if (es.rows?.length) {
      lines.push("──────────────────");
      lines.push(`启动前兆观察（${es.matched} 只命中，前 5，⚠未经回测验证非建议）：`);
      for (const r of es.rows.slice(0, 5)) lines.push(`  ${r.name} ${r.price}｜${r.why}`);
    }
  } catch {
    // 没扫就没这段
  }
  lines.push("──────────────────");
  lines.push(`D-RESUME 预登记实验（design/RESUME-DOWN-SHAPES）：攒满 12 笔/变体走 Welch 判决。`);
  lines.push("本推送是实验进度，不是买入建议。");

  const { sendPushPlus } = await import("@/lib/market/push");
  const sent = await sendPushPlus(
    `解冻实验进度 ${since} 起${anyPosition ? " · 有持仓" : ""}`,
    lines.join("\n"),
    "txt",
  );
  console.log(sent ? `[resume-progress] 已推送` : "[resume-progress] 推送未发出");
}

await main();
