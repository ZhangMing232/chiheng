/**
 * 这个文件是干什么的：
 * 前瞻回验里「选股日已过、今天正是买入日、但还没收盘结算」的那一段。
 *
 * 为什么不能直接写进落档文件：
 * /huiyan 的第一条规矩是「落档之后不许改」。11-11 收盘挑的那 3 只，文件里就是
 * 11-11 当时看到的价，那是凭据。今天开盘买入价是**后来发生的另一件事**，
 * 所以另存一份 data/history/forecast/live/<落档日>.json，只读衍生、不回写落档。
 *
 * 它解决的洞（2026-11-12 补）：
 * 原来结算只在「T+1 已收盘」时做（forecast.ts 的 verify），于是从 9:30 开盘到
 * 15:00 收盘这 5 个半小时里，页面上一期显示的是「买入 — / 待定 / 待结算」——
 * 明明开盘就该买了，价也早就有了，页面却说不知道。这就是用户看到的
 * 「11-11 挑出来、今天要买，为什么没显示」。
 *
 * 数据来源：腾讯日 K（非复权），盘中最后一根就是今天的实时棒（o 是今日开盘，
 * 开盘价一旦开出就不再变），所以买入价可以直接读。现价/最高/最低是盘中值，会变，
 * 所以每次跑都覆盖同一个文件，页面标「截至 HH:MM」。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/forecast-live.ts
 * 输出：data/history/forecast/live/<落档日>.json
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

const OUT = "data/history/forecast";
const LIVE = join(OUT, "live");
const GTIMG_LOOKBACK = 30;
const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
  Referer: "https://gu.qq.com/",
};

type Bar = { date: string; o: number; c: number; h: number; l: number; v: number };
type Period = {
  date: string;
  nextDate: string | null;
  picks: { code: string; name: string; rule: string }[];
  summary?: { n: number } | null;
};
type LiveRow = {
  code: string;
  name: string;
  rule: string;
  buyPrice: number | null;
  last: number | null;
  high: number | null;
  low: number | null;
  /** 相对开盘买入价的涨跌（页面直接显示，不再自己算，避免口径漂移） */
  pctFromBuy: number | null;
  /** 涨停价（按 T 日收盘 + 板块限幅算），一字板判定要用 */
  limitUpPrice: number | null;
  /** 能不能买到：false = 一字涨停，开盘挂单排不进；true = 能；null = 还没开盘 */
  buyFilled: boolean | null;
  /** 为什么买不进 / 为什么要打折看，页面直接显示 */
  fillNote: string | null;
};
export type LiveFile = {
  date: string;
  nextDate: string | null;
  asOf: string;
  /** 今天这根棒是否已收盘（收盘后就是真结算，页面会切回结算口径） */
  final: boolean;
  rows: LiveRow[];
};

async function fetchBars(code: string): Promise<Bar[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${code},day,,,${GTIMG_LOOKBACK}`;
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: Record<string, { day?: string[][] }> };
    const out: Bar[] = [];
    for (const r of body.data?.[code]?.day ?? []) {
      if (!Array.isArray(r) || r.length < 6) continue;
      const o = Number(r[1]);
      const c = Number(r[2]);
      const h = Number(r[3]);
      const l = Number(r[4]);
      const v = Number(r[5]);
      if (![o, c, h, l].every(Number.isFinite)) continue;
      out.push({ date: r[0], o, c, h, l, v: Number.isFinite(v) ? v : 0 });
    }
    return out;
  } catch {
    return [];
  }
}

/** 交易日是否已收盘：15:00 之后（含集合竞价收盘）算收盘。 */
/**
 * 交易所**真实**涨跌幅（算涨跌停价用）：主板 10%、创业板/科创板 20%、北交所 30%。
 * 别拿 limitPct() 那个 0.095/0.195/0.295——那是「判定涨停」用的近似阈值
 * （留了余量防止四舍五入漏判），拿来算限价会把 25.66 算成 25.55。
 * ST 股实际是 5%，但代码里看不出 ST，这里不吃这一口，遇到 ST 会判偏松。
 */
function limitRatio(code: string): number {
  const bare = code.replace(/^(sh|sz|bj)/, "");
  if (code.startsWith("bj")) return 0.3;
  if (bare.startsWith("300") || bare.startsWith("301") || bare.startsWith("688") || bare.startsWith("689")) return 0.2;
  return 0.1;
}

function isClosedNow(): boolean {
  const now = new Date();
  const hm = now.getHours() * 60 + now.getMinutes();
  return hm >= 15 * 60;
}

async function main() {
  const files = (await readdir(OUT).catch(() => [] as string[])).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  const periods: Period[] = [];
  for (const f of files.sort()) {
    try {
      periods.push(JSON.parse(await readFile(join(OUT, f), "utf8")) as Period);
    } catch {
      // 读不出来的跳过，不拿坏文件冒充数据
    }
  }

  // 只看还没结算的期：已结算的期走结算口径，这里再写一份只会让两个数打架。
  const pending = periods.filter((p) => !(p.summary && p.summary.n > 0));
  if (pending.length === 0) {
    console.log("[forecast-live] 没有待结算的期");
    return;
  }

  await mkdir(LIVE, { recursive: true });
  const closed = isClosedNow();

  for (const p of pending) {
    const rows: LiveRow[] = [];
    let nextDate: string | null = p.nextDate ?? null;

    for (const pick of p.picks) {
      const bars = await fetchBars(pick.code);
      const i = bars.findIndex((b) => b.date === p.date);
      const nx = i >= 0 ? bars[i + 1] : undefined;
      if (nx && !nextDate) nextDate = nx.date;
      const usable = nx && nx.o > 0 ? nx : null;
      const prevClose = i >= 0 ? bars[i].c : null;
      const upPrice = prevClose != null ? Math.round(prevClose * (1 + limitRatio(pick.code)) * 100) / 100 : null;
      // 一字涨停：开盘就在涨停价，而且全天最低也是涨停价——没有低于涨停价的成交，挂单排不进。
      // 开盘涨停但盘中开过板（最低 < 涨停价）算买得到，但成交价低于开盘价，得标出来。
      let buyFilled: boolean | null = null;
      let fillNote: string | null = null;
      if (usable && upPrice != null) {
        if (usable.o >= upPrice - 0.005) {
          if (usable.l >= upPrice - 0.005) {
            buyFilled = false;
            fillNote = `${upPrice.toFixed(2)} 一字涨停，开盘挂单排不进（全天最低就是涨停价）`;
          } else {
            buyFilled = true;
            fillNote = `开盘涨停后开板（最低 ${usable.l.toFixed(2)}），成交价低于开盘价`;
          }
        } else {
          buyFilled = true;
        }
      }
      rows.push({
        code: pick.code,
        name: pick.name,
        rule: pick.rule,
        buyPrice: usable ? usable.o : null,
        last: usable ? usable.c : null,
        high: usable ? usable.h : null,
        low: usable ? usable.l : null,
        pctFromBuy: usable && usable.o > 0 ? usable.c / usable.o - 1 : null,
        limitUpPrice: upPrice,
        buyFilled,
        fillNote,
      });
    }

    // 一只都没拿到买入价（T+1 还没开盘 / 接口挂了）就写 nextDate=null，页面继续显示「待定」。
    const anyBuy = rows.some((r) => r.buyPrice != null);
    const payload: LiveFile = {
      date: p.date,
      nextDate: anyBuy ? nextDate : null,
      asOf: new Date().toISOString(),
      final: closed && anyBuy,
      rows,
    };
    await writeFile(join(LIVE, `${p.date}.json`), JSON.stringify(payload, null, 2));
    const bought = rows.filter((r) => r.buyPrice != null).length;
    console.log(
      `[forecast-live] ${p.date} → ${payload.nextDate ?? "待定"}｜已开盘 ${bought}/${rows.length} 只` +
        (payload.final ? "｜已收盘" : ""),
    );
  }
}

await main();
