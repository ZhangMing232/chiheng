/**
 * 生成每日候选信号清单（15:30 收盘后由 home-server 跑）。
 *
 * 2026-11-10 重写。原来这里是「精简复制」的三套策略函数（放量突破 / 突破·早期版 /
 * 启动前期）——全是研究判死、实盘亏钱的家族（累计 −235% / −31.5%），而唯一在
 * 赚钱的低估值反而不在推送管道里：**每天推给用户的「可跟信号」是亏钱家族的票**。
 * 现在改走正式选股代码 `watchList`（strategies.ts，和选股页同一条实现），
 * 只扫现役家族（ACTIVE_STYLES），候选自带止损/目标——用户要的「什么价位买什么」
 * 就是这份东西，不再让推送和赚钱的名单各走各的。
 * 2026-11-09 晚加短线腿（热点·题材补涨，见下方 themeLaggardSignals）：原来只有
 * 中长线家族，早盘推送永远没有短线（用户点名「每天早上也要看到短线的推送」）。
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
import { LEG_HOLD_DAYS, type Leg } from "./lib/signal-legs.ts";

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
  /** 腿：short 短线（题材补涨）/ long 中长线（低估值）。推送分两腿靠它。 */
  leg?: Leg;
  /** 什么时候走：第 N 个交易日收盘卖出（买入日算第 1 日）。口径见 scripts/lib/signal-legs.ts。 */
  holdDays?: number;
};

// ── 短线腿：热点·题材补涨（2026-11-09 晚，用户「每天早上也要看到短线的推送」）────
// 原来候选文件只装中长线家族，短线根本不在早盘管道里——早上推不到是必然。
// 口径一字不改地复用回测登记版（scripts/backtest.ts 的 themeLaggard，判决见
// design/DECISIONS.md、战报 report-220335）：题材已烧（所属真题材板当日 ≥3 只
// 涨停）· 还没动（近 20 日 <5%）· 不追已涨停 · 昨收限价买 · −8% / +10% · 持 5 天。
// 阈值全部沿用登记值（预登记纪律），只做两件产品化的事：每个题材最多 2 只防刷屏、
// 总量 10。判决本身是「补涨 +0.06% 无优势」——这腿是浪里名单，小仓试错。
type ConceptsFile = { boards: { code: string; name: string; members: string[] }[] };
const TAG_BOARD = /(热股|高换手|高振幅|多板|涨停|跌停|首亏|预增|预亏|重仓|减仓|增仓|融资|股通|QFII|亏损|题材股|破净|高价|低价|百元|次新|AH|同股)/;

async function themeLaggardSignals(quotes: Quote[]): Promise<Signal[]> {
  let concepts: ConceptsFile;
  try {
    concepts = JSON.parse(await readFile(`${DATA}/backtest/concepts.json`, "utf8"));
  } catch {
    console.log("概念板数据缺失（data/backtest/concepts.json），短线腿今天没有名单");
    return [];
  }
  const byId = new Map(quotes.map((q) => [q.id, q]));
  const limitPct = (q: Quote) => (q.st ? 5 : q.board === "kcb" || q.board === "cyb" ? 20 : q.board === "bj" ? 30 : 10);
  const limitUpNow = (q: Quote) => q.chg != null && q.chg >= limitPct(q) - 0.15;

  // 真题材板：成员 10~800、剔统计标签板（口径同 theme-heat.ts / backtest buildThemeHeatMap）
  const boards = concepts.boards.filter((b) => b.members.length >= 10 && b.members.length <= 800 && !TAG_BOARD.test(b.name));

  // 板内当日涨停家数：按每只自己的涨跌停幅度算（lim−0.15），不用 9.7 近似
  const boardHot = new Map<string, number>();
  for (const b of boards) {
    let n = 0;
    for (const id of b.members) {
      const q = byId.get(id);
      if (q && limitUpNow(q)) n += 1;
    }
    boardHot.set(b.code, n);
  }

  // 每票归属最热的「已烧」板（≥3 只涨停，登记阈值）
  const hottest = new Map<string, { theme: string; hot: number }>();
  for (const b of boards) {
    const hot = boardHot.get(b.code) ?? 0;
    if (hot < 3) continue;
    for (const id of b.members) {
      const cur = hottest.get(id);
      if (!cur || hot > cur.hot) hottest.set(id, { theme: b.name, hot });
    }
  }

  const rows: { s: Signal; theme: string; amount: number }[] = [];
  for (const [id, { theme, hot }] of hottest) {
    const q = byId.get(id);
    if (!q || q.st || q.chg == null) continue;
    if (q.board === "hk" || q.board === "us") continue;
    if (q.price < 4 || q.amount < 3000) continue;
    if (limitUpNow(q)) continue; // 已涨停的不追——追板/连板是项目最强反向（t=−10.2）
    if (q.d20 == null || q.d20 >= 5) continue; // 还没动
    const buy = +(q.price / (1 + q.chg / 100)).toFixed(2); // 昨收限价
    rows.push({
      s: {
        id,
        code: q.code,
        name: q.name,
        strategy: "热点·题材补涨",
        leg: "short",
        holdDays: LEG_HOLD_DAYS.short,
        buyPrice: buy,
        score: hot,
        reason: `${theme} 涨停 ${hot} 只，近20日 ${q.d20.toFixed(1)}% 未启动`,
        stop: +(buy * 0.92).toFixed(2),
        target: +(buy * 1.1).toFixed(2),
      },
      theme,
      amount: q.amount,
    });
  }
  rows.sort((a, b) => b.s.score - a.s.score || b.amount - a.amount);
  const perTheme = new Map<string, number>();
  const out: Signal[] = [];
  for (const r of rows) {
    const n = perTheme.get(r.theme) ?? 0;
    if (n >= 2) continue;
    perTheme.set(r.theme, n + 1);
    out.push(r.s);
    if (out.length >= 10) break;
  }
  return out;
}

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
        leg: "long",
        holdDays: LEG_HOLD_DAYS.long,
        buyPrice: +r.buy.toFixed(2),
        score: +r.score.toFixed(1),
        reason: (r.reasons ?? []).join("，").slice(0, 60),
        stop: r.stop != null ? +r.stop.toFixed(2) : undefined,
        target: r.sell != null ? +r.sell.toFixed(2) : undefined,
      });
    }
    console.log(`${label}：${rows.length} 条候选`);
  }

  const shortRows = await themeLaggardSignals(quotes);
  signals.push(...shortRows);
  console.log(`热点·题材补涨（短线腿）：${shortRows.length} 条候选`);

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
