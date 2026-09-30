/**
 * 这个文件是干什么的：
 * 把账本算成一份成绩单：五套策略分别赚了多少、胜率多少、跑没跑赢沪深300，
 * 以及离「可以上真钱」那道门槛还差多少。
 *
 * 你需要知道的：
 * 收盘之后补记的那几天不算数（dayReliable），它们不是盘中真打到价买进去的。
 * 沪深300 是拿「这一天的入场点位到 8 个交易日后的点位」比的，是个近似，
 * 因为每一笔的持有天数并不一样长。看趋势够用，别当精算。
 * 只算已经卖出的（闭环），还没卖的不进胜率。
 */

import { ROUND_TRIP_COST, dayReliable, netReturn } from "../src/lib/market/journal-book.ts";
import { listUserIds, readUserBook, OWNER_ID } from "../src/lib/market/book-file.ts";
import { isTradingDay, shanghaiDate } from "../src/lib/market/session.ts";
import { DEFAULT_RULES } from "../src/lib/market/rules.ts";
import { STYLES } from "../src/lib/market/strategies.ts";

type Trade = {
  id: string;
  code: string;
  name: string;
  entry: number;
  stop?: number;
  target?: number;
  style?: string;
  exit: number | null;
  exitDate: string | null;
};

type Day = {
  date: string;
  savedAt: number;
  signalTime: string;
  status?: "provisional" | "locked";
  indexEntry: number | null;
  indexExit: number | null;
  trades: Trade[];
};

/** 两个日期之间隔了几个交易日（不含头、含尾）。 */
function sessionsBetween(from: string, to: string): number {
  const start = new Date(`${from}T12:00:00+08:00`).getTime();
  const end = new Date(`${to}T12:00:00+08:00`).getTime();
  if (!(end > start)) return 0;
  let n = 0;
  for (let t = start + 86_400_000; t <= end; t += 86_400_000) {
    if (isTradingDay(shanghaiDate(t))) n += 1;
  }
  return n;
}

const pad = (s: string, n: number) => s + " ".repeat(Math.max(0, n - [...s].reduce((w, ch) => w + (ch.charCodeAt(0) > 255 ? 2 : 1), 0)));
const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(2)}%`);

async function main() {
  const ids = await listUserIds();
  const userId = process.argv[2] && ids.includes(process.argv[2]) ? process.argv[2] : OWNER_ID;
  const book = await readUserBook<Day>(userId);

  const all = book.days;
  const usable = all.filter((day) => dayReliable(day));
  const skipped = all.filter((day) => !dayReliable(day));

  console.log(`\n账本 ${userId}，共 ${all.length} 天，其中 ${usable.length} 天可用于统计`);
  if (skipped.length > 0) {
    console.log(`跳过（收盘后补记，不算数）：${skipped.map((d) => `${d.date} ${d.signalTime}`).join("、")}`);
  }
  console.log(`手续费一来一回 ${(ROUND_TRIP_COST * 100).toFixed(3)}%，已折进每笔收益\n`);

  const rows: {
    style: string;
    name: string;
    open: number;
    closed: number;
    wins: number;
    winRate: number | null;
    avgRet: number | null;
    totalRet: number | null;
    avgHold: number | null;
    excess: number | null;
  }[] = [];

  for (const style of STYLES) {
    const trades = usable.flatMap((day) => day.trades.filter((t) => t.style === style.id).map((t) => ({ day, trade: t })));
    const closedTrades = trades.filter(({ trade }) => trade.exit != null && trade.entry > 0);
    const rets = closedTrades.map(({ trade }) => netReturn(trade.entry, trade.exit!)).filter((r): r is number => r != null);

    // 超额收益：这一笔的收益，减去同期沪深300的涨幅
    const excesses: number[] = [];
    for (const { day, trade } of closedTrades) {
      const r = netReturn(trade.entry, trade.exit!);
      if (r == null) continue;
      const bench = day.indexEntry && day.indexExit ? day.indexExit / day.indexEntry - 1 : null;
      if (bench == null) continue;
      excesses.push(r - bench);
    }
    const holds = closedTrades
      .filter(({ day, trade }) => trade.exitDate != null && day.date != null)
      .map(({ day, trade }) => sessionsBetween(day.date, trade.exitDate!));

    const mean = (xs: number[]) => (xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length);
    rows.push({
      style: style.id,
      name: style.name,
      open: trades.filter(({ trade }) => trade.exit == null).length,
      closed: rets.length,
      wins: rets.filter((r) => r > 0).length,
      winRate: rets.length === 0 ? null : rets.filter((r) => r > 0).length / rets.length,
      avgRet: mean(rets),
      totalRet: rets.length === 0 ? null : rets.reduce((a, b) => a + b, 0),
      avgHold: mean(holds),
      excess: mean(excesses),
    });
  }

  const heldAll = all.flatMap((day) => day.trades).filter((t) => t.exit == null).length;
  console.log(`说明：表里只算能用的那天。账上一共还拿着 ${heldAll} 只（含被跳过的那几天的）。\n`);

  const headers = ["策略", "未平仓", "闭环", "胜率", "平均收益", "累计收益", "平均持有", "超额/300"];
  console.log(pad(headers[0], 12) + pad(headers[1], 8) + pad(headers[2], 8) + pad(headers[3], 10) + pad(headers[4], 12) + pad(headers[5], 12) + pad(headers[6], 10) + headers[7]);
  console.log("-".repeat(84));
  for (const r of rows) {
    console.log(
      pad(r.name, 12) +
        pad(String(r.open), 8) +
        pad(String(r.closed), 8) +
        pad(r.winRate == null ? "—" : `${(r.winRate * 100).toFixed(0)}% (${r.wins}/${r.closed})`, 10) +
        pad(pct(r.avgRet), 12) +
        pad(pct(r.totalRet), 12) +
        pad(r.avgHold == null ? "—" : `${r.avgHold.toFixed(1)}天`, 10) +
        pct(r.excess),
    );
  }

  // 离上真钱那道门槛还差多少
  const closedAll = usable.flatMap((day) => day.trades).filter((t) => t.exit != null && t.entry > 0);
  const comparable = usable.filter((d) => d.indexEntry != null && d.indexExit != null);
  console.log("\n离上真钱的门槛：");
  console.log(`  交易日记录      ${usable.length} / ${DEFAULT_RULES.minDays}`);
  console.log(`  完整闭环        ${closedAll.length} 笔（门槛 ${DEFAULT_RULES.minClosed}）`);
  console.log(`  可比沪深300的天 ${comparable.length} 天`);
  console.log(`  止损 ${DEFAULT_RULES.chgMax}%，连亏 ${DEFAULT_RULES.maxLosingStreak} 笔停手，回撤 ${DEFAULT_RULES.maxDrawdownPct}% 停手`);
  const enough = usable.length >= DEFAULT_RULES.minDays && closedAll.length >= DEFAULT_RULES.minClosed;
  console.log(`  结论：${enough ? "样本够了，可以谈跑赢没有" : "样本还远远不够，现在任何胜率都只是噪声"}`);
  if (closedAll.length < 30) {
    console.log("  提醒：闭环少于 30 笔时，胜率的误差范围是正负十几个百分点，看不出差别。");
  }
  console.log("");
}

await main();
