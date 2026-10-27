/**
 * 这个文件是干什么的：
 * 把东财历史的龙虎榜按天拉下来，落盘到 data/risk/hotmoney/YYYY-MM-DD.json。
 * 数据源和热路径 loadHotMoney() 完全一样（东财 datacenter），只是不做缓存、不限 TTL。
 *
 * 你需要知道的：
 * 东财龙虎榜数据可能只保留近期几个月——超过历史范围的日期会返回空数据。
 * 渐进式：文件已存在就跳过（中断后继续）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";

const BASE = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const HEADERS = { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/" };

type Raw = Record<string, unknown>;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

async function pull(report: string, date: string): Promise<Raw[]> {
  const filter = encodeURIComponent(`(TRADE_DATE='${date}')`);
  const url =
    `${BASE}?columns=SECURITY_CODE,OPERATEDEPT_NAME,NET&pageSize=500&pageNumber=1` +
    `&reportName=${report}&filter=${filter}&sortColumns=NET&sortTypes=-1&source=WEB&client=WEB`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
  if (!res.ok) return [];
  const body = (await res.json()) as { result?: { data?: Raw[] } };
  return Array.isArray(body.result?.data) ? body.result.data : [];
}

async function namesOf(date: string): Promise<Map<string, string>> {
  const filter = encodeURIComponent(`(TRADE_DATE='${date}')`);
  const url =
    `${BASE}?columns=SECURITY_CODE,SECURITY_NAME_ABBR&pageSize=500&pageNumber=1` +
    `&reportName=RPT_DAILYBILLBOARD_DETAILSNEW&filter=${filter}&source=WEB&client=WEB`;
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12_000) });
  const map = new Map<string, string>();
  if (!res.ok) return map;
  const body = (await res.json()) as { result?: { data?: Raw[] } };
  for (const row of body.result?.data ?? []) {
    const code = String(row.SECURITY_CODE ?? "");
    const name = String(row.SECURITY_NAME_ABBR ?? "").trim();
    if (code && name) map.set(code, name);
  }
  return map;
}

function labelOf(name: string): string | null {
  if (name.includes("沪股通") || name.includes("深股通")) return null;
  if (name.includes("机构")) return "机构";
  if (name.includes("拉萨")) return "拉萨天团";
  const alias = name
    .replace(/股份有限公司/g, "")
    .replace(/有限责任公司/g, "")
    .replace(/证券营业部/g, "")
    .replace(/证券分公司/g, "分公司")
    .trim();
  if (alias.includes("江苏路") && name.includes("国泰")) return "章盟主";
  if (alias.includes("彩虹北路")) return "章盟主";
  if (alias.includes("绍兴") && (name.includes("银河") || name.includes("浙商"))) return "赵老哥";
  if (alias.includes("兴业") && alias.includes("陕西")) return "方新侠";
  if (alias.includes("宛平南路") || alias.includes("茅台路") || alias.includes("红宝石路") || alias.includes("沧海路")) return "炒股养家";
  if (alias.includes("溧阳路")) return "孙哥";
  if (alias.includes("桑田路")) return "宁波桑田路";
  if (alias.includes("欢乐海岸")) return "欢乐海岸";
  if (alias.includes("荣超") || (alias.includes("华泰") && alias.includes("益田路"))) return "华泰荣超";
  if (alias.includes("华泰") && alias.includes("总部")) return "华泰总部";
  if (alias.includes("温州")) return "温州帮";
  return alias.slice(-8);
}

async function fetchHotMoney(date: string): Promise<{
  date: string;
  seats: { name: string; netWan: number; stocks: { name: string; netWan: number }[] }[];
}> {
  const [buys, sells, names] = await Promise.all([
    pull("RPT_BILLBOARD_DAILYDETAILSBUY", date),
    pull("RPT_BILLBOARD_DAILYDETAILSSELL", date),
    namesOf(date),
  ]);
  const seatMap = new Map<string, { net: number; stocks: Map<string, number> }>();
  for (const row of [...buys, ...sells]) {
    const rawName = String(row.OPERATEDEPT_NAME ?? "").trim();
    const label = rawName ? labelOf(rawName) : null;
    const code = String(row.SECURITY_CODE ?? "");
    const net = num(row.NET) / 10_000;
    if (!label || !code || net === 0) continue;
    const seat = seatMap.get(label) ?? { net: 0, stocks: new Map() };
    seat.net += net;
    seat.stocks.set(code, (seat.stocks.get(code) ?? 0) + net);
    seatMap.set(label, seat);
  }
  const seats = [...seatMap.entries()]
    .map(([name, seat]) => ({
      name,
      netWan: seat.net,
      stocks: [...seat.stocks.entries()]
        .map(([code, netWan]) => ({ name: names.get(code) ?? code, netWan }))
        .sort((a, b) => Math.abs(b.netWan) - Math.abs(a.netWan)),
    }))
    .sort((a, b) => Math.abs(b.netWan) - Math.abs(a.netWan));
  return { date, seats };
}

async function main() {
  const OUT = "data/risk/hotmoney";
  await mkdir(OUT, { recursive: true });
  // 已有数据点的日期清单一目了然，用于断点跳过
  const existing = new Set<string>();
  for await (const entry of await import("node:fs/promises").then((f) => f.readdir(OUT))) {
    if (entry.endsWith(".json")) existing.add(entry.slice(0, 10));
  }

  const today = new Date();
  const cursor = new Date("2025-01-01"); // 龙虎榜历史回测不需要太久，2025 年初开始就行
  let fast = 0;
  while (cursor <= today) {
    const date = cursor.toISOString().slice(0, 10);
    cursor.setDate(cursor.getDate() + 1);
    if (existing.has(date) || cursor.getDay() === 0 || cursor.getDay() === 6) continue;
    try {
      const book = await fetchHotMoney(date);
      await writeFile(`${OUT}/${date}.json`, JSON.stringify({ date, seats: book.seats, fetchedAt: new Date().toISOString() }, null, 2));
      console.log(`[hotmoney] ${date} OK ${book.seats.length}席位`);
      fast += 1;
    } catch (err) {
      console.error(`[hotmoney] ${date} ERROR`, String(err).slice(0, 120));
    }
    // 日期跑不跑都缓，控制频率
    await new Promise((r) => setTimeout(r, 800));
    if (fast >= 5) {
      // 每 5 天多歇一会
      await new Promise((r) => setTimeout(r, 3000));
      fast = 0;
    }
  }
  console.log("[hotmoney] 全部完成");
}

main();