export type HotStock = { name: string; netWan: number };

export type HotSeat = {
  name: string;
  netWan: number;
  stocks: HotStock[];
};

export type HotBook = {
  date: string;
  seats: HotSeat[];
};

type Raw = Record<string, unknown>;

const TTL_MS = 5 * 60_000;
let cache: { at: number; book: HotBook } | null = null;

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function shortSeat(name: string): string {
  return name
    .replace(/股份有限公司/g, "")
    .replace(/有限责任公司/g, "")
    .replace(/证券营业部/g, "")
    .replace(/证券分公司/g, "分公司")
    .trim();
}

const CITIES =
  "北京|上海|深圳|广州|南京|杭州|宁波|成都|厦门|西安|苏州|武汉|长沙|合肥|福州|济南|青岛|大连|沈阳|重庆|天津|佛山|东莞|无锡|嘉兴|金华|台州|泉州|郑州|昆明|海口|南宁|贵阳|兰州|浙江|江苏|广东|福建|山东|四川|陕西|湖北|湖南|西北";

function tidy(label: string): string {
  return label
    .replace(/^(中信建投|中信证券|中信|华泰证券|华泰|招商证券|招商|国泰海通|国泰君安|中国银河|银河|光大证券|光大|广发证券|广发|申万宏源|申万|海通证券|海通|东方财富|兴业证券|兴业|东兴证券|东兴|国盛证券|国盛|财通证券|财通|南京证券|平安证券|平安|东吴证券|东吴|长江证券|长江|方正证券|方正)/, "")
    .replace(/^有限公司|^股份/, "");
}

function placeOf(name: string): string {
  if (name.includes("试验区")) return "自贸区";
  const cityStreet = name.match(new RegExp(`(${CITIES})([\\u4e00-\\u9fa5]{1,6}(?:路|街|大道|巷|里))`));
  if (cityStreet) return tidy(cityStreet[1] + cityStreet[2]);
  const streets = [...name.matchAll(/[\u4e00-\u9fa5]{2,8}(?:路|街|大道|巷|里)/g)].map((item) => tidy(item[0])).filter((item) => item && !item.includes("公司"));
  if (streets.length) return streets[streets.length - 1];
  const branch = name.match(new RegExp(`(${CITIES})(?:[\\u4e00-\\u9fa5]{0,6})分公司`));
  if (branch) return tidy(branch[0].replace(/证券/g, ""));
  return tidy(shortSeat(name).replace(/证券/g, "")).slice(-8);
}

function labelOf(name: string): string | null {
  if (name.includes("沪股通") || name.includes("深股通")) return null;
  if (name.includes("机构")) return "机构";
  if (name.includes("拉萨")) return "拉萨天团";
  if (name.includes("江苏路") && name.includes("国泰")) return "章盟主";
  if (name.includes("彩虹北路")) return "章盟主";
  if (name.includes("南京太平南路")) return "作手新一";
  if (name.includes("绍兴") && (name.includes("银河") || name.includes("浙商"))) return "赵老哥";
  if (name.includes("兴业") && name.includes("陕西")) return "方新侠";
  if (name.includes("宛平南路") || name.includes("茅台路") || name.includes("红宝石路") || name.includes("沧海路")) return "炒股养家";
  if (name.includes("溧阳路")) return "孙哥";
  if (name.includes("桑田路")) return "宁波桑田路";
  if (name.includes("欢乐海岸")) return "欢乐海岸";
  if (name.includes("荣超") || (name.includes("华泰") && name.includes("益田路"))) return "华泰荣超";
  if (name.includes("华泰") && name.includes("总部")) return "华泰总部";
  if (name.includes("温州")) return "温州帮";
  return placeOf(name);
}

async function pull(report: string, date: string): Promise<Raw[]> {
  const filter = encodeURIComponent(`(TRADE_DATE='${date}')`);
  const url =
    "https://datacenter-web.eastmoney.com/api/data/v1/get?columns=SECURITY_CODE,OPERATEDEPT_NAME,NET" +
    `&pageSize=500&pageNumber=1&reportName=${report}&filter=${filter}&sortColumns=NET&sortTypes=-1&source=WEB&client=WEB`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/stock/lhb.html" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as { result?: { data?: Raw[] } };
  return Array.isArray(body.result?.data) ? body.result.data : [];
}

async function namesOf(date: string): Promise<Map<string, string>> {
  const filter = encodeURIComponent(`(TRADE_DATE='${date}')`);
  const url =
    "https://datacenter-web.eastmoney.com/api/data/v1/get?columns=SECURITY_CODE,SECURITY_NAME_ABBR" +
    `&pageSize=500&pageNumber=1&reportName=RPT_DAILYBILLBOARD_DETAILSNEW&filter=${filter}&source=WEB&client=WEB`;
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/" },
    signal: AbortSignal.timeout(12_000),
  });
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

async function latestDate(): Promise<string> {
  const url =
    "https://datacenter-web.eastmoney.com/api/data/v1/get?columns=TRADE_DATE&pageSize=1&pageNumber=1" +
    "&reportName=RPT_BILLBOARD_DAILYDETAILSBUY&sortColumns=TRADE_DATE&sortTypes=-1&source=WEB&client=WEB";
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://data.eastmoney.com/" },
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) return "";
  const body = (await res.json()) as { result?: { data?: { TRADE_DATE?: string }[] } };
  return String(body.result?.data?.[0]?.TRADE_DATE ?? "").slice(0, 10);
}

/** 龙虎榜按席位汇总。常见别名只标对得上营业部的。金额是万元。收盘后才有。 */
export async function loadHotMoney(): Promise<HotBook> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.book;
  const date = await latestDate();
  if (!date) return { date: "", seats: [] };
  const [buys, sells, names] = await Promise.all([
    pull("RPT_BILLBOARD_DAILYDETAILSBUY", date),
    pull("RPT_BILLBOARD_DAILYDETAILSSELL", date),
    namesOf(date),
  ]);
  const seats = new Map<string, { net: number; stocks: Map<string, number> }>();
  for (const row of [...buys, ...sells]) {
    const rawName = String(row.OPERATEDEPT_NAME ?? "").trim();
    const label = rawName ? labelOf(rawName) : null;
    const code = String(row.SECURITY_CODE ?? "");
    const net = num(row.NET) / 10_000;
    if (!label || !code || net === 0) continue;
    const seat = seats.get(label) ?? { net: 0, stocks: new Map() };
    seat.net += net;
    seat.stocks.set(code, (seat.stocks.get(code) ?? 0) + net);
    seats.set(label, seat);
  }
  const ranked = [...seats.entries()].map(([name, seat]) => ({
    name,
    netWan: seat.net,
    stocks: [...seat.stocks.entries()]
      .map(([code, netWan]) => ({ name: names.get(code) ?? code, netWan }))
      .sort((a, b) => Math.abs(b.netWan) - Math.abs(a.netWan))
      .slice(0, 12),
  }));
  const pinned = new Set(["机构", "拉萨天团"]);
  const rest = ranked.filter((seat) => !pinned.has(seat.name)).sort((a, b) => Math.abs(b.netWan) - Math.abs(a.netWan)).slice(0, 18);
  const tail = ranked.filter((seat) => pinned.has(seat.name));
  const book = { date, seats: [...rest, ...tail] };
  cache = { at: Date.now(), book };
  return book;
}
