/**
 * 生成每日候选信号清单（15:30 收盘后由 home-server 跑）。
 *
 * 2026-11-10 重写。原来这里是「精简复制」的三套策略函数（放量突破 / 突破·早期版 /
 * 启动前期）——全是研究判死、实盘亏钱的家族（累计 −235% / −31.5%），而唯一在
 * 赚钱的低估值反而不在推送管道里：**每天推给用户的「可跟信号」是亏钱家族的票**。
 * 现在改走正式选股代码 `watchList`（strategies.ts，和选股页同一条实现），
 * 只扫现役家族（ACTIVE_STYLES），候选自带止损/目标——用户要的「什么价位买什么」
 * 就是这份东西，不再让推送和赚钱的名单各走各的。
 *
 * 输出 data/signals/candidates.json：
 *   { date, count, signals: [{ id, code, name, strategy, buyPrice, score, reason, stop?, target? }] }
 *   stop/target 是新增字段，老消费者（review-auction / 信号页）兼容。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { watchList, ACTIVE_STYLES, STYLES } from "@/lib/market/strategies";
import { DEFAULT_RULES } from "@/lib/market/rules";
import { DEFAULT_PREFS, matchPrefs } from "@/lib/market/prefs";
import type { Quote } from "@/lib/market/types";

const DATA = process.env.CHIHENG_DATA_DIR ?? "data";

type Signal = {
  id: string;
  code: string;
  name: string;
  strategy: string;
  buyPrice: number;
  score: number;
  reason: string;
  stop?: number;
  target?: number;
};

async function main() {
  console.log(`信号生成：现役家族（${ACTIVE_STYLES.join("、")}）正式选股代码扫描…\n`);
  const raw = JSON.parse(await readFile(`${DATA}/universe-cache.json`, "utf8")) as {
    at: number;
    payload: { quotes: Quote[] };
  };
  const quotes = raw.payload.quotes;
  console.log(`股票池：${quotes.length} 只（行情快照 ${new Date(raw.at).toLocaleTimeString("zh-CN", { hour12: false })}）`);

  const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10);
  const signals: Signal[] = [];
  for (const style of ACTIVE_STYLES) {
    const rows = watchList(quotes, style, DEFAULT_RULES, (q) => matchPrefs(q, DEFAULT_PREFS));
    const label = STYLES.find((s) => s.id === style)?.name ?? style;
    for (const r of rows) {
      signals.push({
        id: r.quote.id,
        code: r.quote.code ?? r.quote.id.slice(2),
        name: r.quote.name ?? "",
        strategy: label,
        buyPrice: +r.buy.toFixed(2),
        score: +r.score.toFixed(1),
        reason: (r.reasons ?? []).join("，").slice(0, 60),
        stop: r.stop != null ? +r.stop.toFixed(2) : undefined,
        target: r.sell != null ? +r.sell.toFixed(2) : undefined,
      });
    }
    console.log(`${label}：${rows.length} 条候选`);
  }

  await mkdir(`${DATA}/signals`, { recursive: true });
  await writeFile(
    `${DATA}/signals/candidates.json`,
    JSON.stringify({ date: today, count: signals.length, signals }, null, 2),
  );
  console.log(`\n候选信号 ${signals.length} 条 → ${DATA}/signals/candidates.json`);
  for (const s of signals.slice(0, 15)) {
    console.log(`  ${s.code} ${s.name} | ${s.strategy} | 挂${s.buyPrice} | 止损${s.stop ?? "—"} 目标${s.target ?? "—"}`);
  }
}

await main();
