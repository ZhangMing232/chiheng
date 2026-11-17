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
import { judgeFill, buyFilledOf, type FilledStatus } from "../src/lib/market/fill-status.ts";
import { boardLimitRatio } from "../src/lib/market/model.ts";

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
  /** 能不能买到：false = 一字涨停或停牌，true = 能，null = 还没开盘/数据缺失（兼容旧字段） */
  buyFilled: boolean | null;
  /** 五态细分（2026-11-16 加）：filled/unfillable/suspended/pending/missing。
   *  停牌不再冒充「待开盘」——见 fill-status.ts 的说明。 */
  status: FilledStatus;
  /** 为什么买不进 / 为什么要打折看 / 为什么没数据，页面直接显示 */
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

/** 实时快照的成交量（股）。停牌日为 0——这是判停牌的硬证据。
 *  腾讯快照格式：v_sh605255="1~名称~代码~现价~昨收~今开~成交量(手)~..." 第 7 个字段是成交量（手）。
 *  拿不到/格式变了返回 null（不编 0，0 有特定含义=停牌）。 */
async function fetchSnapshotVolume(code: string): Promise<number | null> {
  try {
    const res = await fetch(`https://web.sqt.gtimg.cn/utf8/q=${code}`, {
      headers: HEADERS,
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    const text = await res.text();
    const m = text.match(/="([^"]*)"/);
    if (!m) return null;
    const fields = m[1].split("~");
    if (fields.length < 7) return null;
    const lots = Number(fields[6]);
    return Number.isFinite(lots) ? lots * 100 : null; // 手 → 股
  } catch {
    return null;
  }
}

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
/** 是否已过开盘时间（9:30）。纯时间判断，供 judgeFill 用。 */
function isAfterOpenNow(): boolean {
  const now = new Date();
  const hm = now.getHours() * 60 + now.getMinutes();
  return hm >= 9 * 60 + 30;
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
      // 2026-11-17 统一：boardLimitRatio（ST 5% 按名字识别），删本地 limitRatio。
      const upPrice = prevClose != null ? Math.round(prevClose * (1 + (boardLimitRatio(pick.code, pick.name) ?? 0.1)) * 100) / 100 : null;
      // 没有今日 bar 时才需要查快照判停牌（有 bar 就是在正常交易，省一次请求）。
      const snapshotVolume = usable ? null : await fetchSnapshotVolume(pick.code);
      // 五态判定统一走纯函数（2026-11-16）：停牌不再被当成「待开盘」。
      const verdict = judgeFill({
        bar: usable ? { o: usable.o, c: usable.c, h: usable.h, l: usable.l } : null,
        snapshotVolume,
        afterOpen: isAfterOpenNow(),
        afterClose: closed,
        limitUpPrice: upPrice,
      });
      const buyFilled = buyFilledOf(verdict.status);
      const fillNote = verdict.note;
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
        status: verdict.status,
        fillNote,
      });
    }

    // anyBuy 口径（2026-11-16 修）：只要有一只拿到买入价，或某只已判停牌/一字板
    // （都是「今天已有明确结论」），就算已开盘——不能因为停牌股没买价就把整期打回「待定」。
    const anyBuy = rows.some((r) => r.buyPrice != null || r.status === "suspended" || r.status === "unfillable");
    const payload: LiveFile = {
      date: p.date,
      nextDate: anyBuy ? nextDate : null,
      asOf: new Date().toISOString(),
      final: closed && anyBuy,
      rows,
    };
    await writeFile(join(LIVE, `${p.date}.json`), JSON.stringify(payload, null, 2));
    const bought = rows.filter((r) => r.buyPrice != null).length;
    const suspended = rows.filter((r) => r.status === "suspended").length;
    const missing = rows.filter((r) => r.status === "missing").length;
    console.log(
      `[forecast-live] ${p.date} → ${payload.nextDate ?? "待定"}｜已开盘 ${bought}/${rows.length} 只` +
        (suspended ? `｜停牌 ${suspended}` : "") +
        (missing ? `｜数据缺失 ${missing}` : "") +
        (payload.final ? "｜已收盘" : ""),
    );
  }
}

await main();
