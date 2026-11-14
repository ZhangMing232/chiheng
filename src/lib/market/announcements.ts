/**
 * 这个文件是干什么的：
 * 巨潮全市场事件流（data/announcements/<date>.json）——按事件关键词搜全市场
 * 当日公告，落盘给监管异动雷达和绝望底仓复核做事件过滤。每天收盘后拉一次
 * （stamp 去重），是巨潮个股快讯（cninfo.ts）之外的「全市场视角」。
 *
 * 你需要知道的：
 * 1. **这是第一档合规源**：巨潮是证监会指定的法定披露平台，一天一次请求，
 *    频率上完全无压力。
 * 2. 事件类目用标题关键词匹配（问询函/减持/业绩预告变更/立案/质押平仓）——
 *    巨潮的 category 代码体系复杂且含公告子类太杂，关键词法简单可靠；
 *    标题就是给散户看的一句话，分类不会错到哪去。
 * 3. `loadEventStream(date)` 是纯读盘；采集在 scripts/fetch-announcements.ts。
 * 4. node API 函数内动态 import（浏览器兼容铁律）。
 */

const fsApi = () => import("node:fs/promises");
const posixJoin = (...parts: string[]): string => parts.join("/");

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data");
}

/** 事件类目。关键词按标题匹配（巨潮标题 <em> 高亮标签先剥掉）。 */
export const EVENT_CATEGORIES: { key: string; label: string; keywords: string[] }[] = [
  { key: "inquiry", label: "问询/关注函", keywords: ["问询函", "关注函", "监管工作函"] },
  { key: "reduction", label: "减持", keywords: ["减持计划", "减持股份", "被动减持"] },
  { key: "forecast", label: "业绩预告", keywords: ["业绩预告", "业绩预告更正", "业绩快报"] },
  { key: "investigation", label: "立案/处罚", keywords: ["立案", "行政处罚", "警示函"] },
  { key: "pledge", label: "质押/平仓", keywords: ["质押", "平仓"] },
];

/** 一条全市场公告事件。 */
export type MarketAnnouncement = {
  id: string;
  code: string;
  name: string;
  title: string;
  /** 发布日期 YYYY-MM-DD。 */
  date: string;
  url: string;
  /** 命中的类目 key（一条公告可能命中多个，取第一个匹配）。 */
  category: string;
};

/** 一天的全市场事件账。 */
export type AnnouncementEventBook = {
  date: string;
  fetchedAt: string;
  events: MarketAnnouncement[];
};

/** 剥巨潮标题里的 <em> 高亮标签。 */
export function stripEm(title: string): string {
  return title.replace(/<\/?em>/g, "");
}

/** 标题 → 类目 key。命中多个取 EVENT_CATEGORIES 里最靠前的（顺序即重要性）。 */
export function categoryOf(title: string): string | null {
  for (const cat of EVENT_CATEGORIES) {
    if (cat.keywords.some((kw) => title.includes(kw))) return cat.key;
  }
  return null;
}

/** 采集：拉全市场当日公告（翻几页），按类目过滤后落盘。 */
export async function fetchEventStream(date: string, opts: { pages?: number; pageSize?: number } = {}): Promise<AnnouncementEventBook> {
  const pages = opts.pages ?? 3;
  const pageSize = opts.pageSize ?? 100;
  const seen = new Set<string>();
  const raws: { id: string; code: string; name: string; title: string; date: string; url: string }[] = [];
  for (let page = 1; page <= pages; page++) {
    const url =
      `https://www.cninfo.com.cn/new/fulltextSearch/full?searchkey=${encodeURIComponent("公告")}` +
      `&sdate=${date}&edate=${date}&isfulltext=false&sortName=pubtime&sortType=desc&pageNum=${page}&pageSize=${pageSize}`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Referer: "https://www.cninfo.com.cn/new/fulltextSearch",
        "X-Requested-With": "XMLHttpRequest",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) continue;
    const text = (await res.text()).trim();
    if (!text.startsWith("{")) continue; // 防爬回 HTML，同 cninfo.ts 的坑
    const parsed = JSON.parse(text) as {
      announcements?: { announcementId?: string; secCode?: string; secName?: string; announcementTitle?: string; announcementTime?: number; adjunctUrl?: string }[] | null;
      totalRecordNum?: number;
    };
    for (const item of parsed.announcements ?? []) {
      const id = item.announcementId != null ? String(item.announcementId) : "";
      const title = stripEm(item.announcementTitle ?? "");
      const code = item.secCode ?? "";
      if (!id || !code || seen.has(id)) continue;
      seen.add(id);
      raws.push({
        id,
        code,
        name: item.secName ?? "",
        title,
        date: typeof item.announcementTime === "number" ? new Date(item.announcementTime).toISOString().slice(0, 10) : date,
        url: item.adjunctUrl ? `http://static.cninfo.com.cn/${item.adjunctUrl}` : "",
      });
    }
  }
  const events: MarketAnnouncement[] = raws.flatMap((r) => {
    const category = categoryOf(r.title);
    if (!category) return [];
    return [{ ...r, category }];
  });
  const book: AnnouncementEventBook = { date, fetchedAt: new Date().toISOString(), events };
  await saveEventStream(book);
  return book;
}

/** 落盘路径：data/announcements/<date>.json。 */
export function eventPath(date: string): string {
  return posixJoin(dataDir(), "announcements", `${date}.json`);
}

async function saveEventStream(book: AnnouncementEventBook): Promise<void> {
  const { mkdir, writeFile } = await fsApi();
  await mkdir(posixJoin(dataDir(), "announcements"), { recursive: true });
  await writeFile(eventPath(book.date), JSON.stringify(book, null, 2));
}

/** 纯读盘：没有就空账（不编）。 */
export async function loadEventStream(date: string): Promise<AnnouncementEventBook | null> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(eventPath(date), "utf8")) as { date?: string; fetchedAt?: string; events?: unknown };
    if (Array.isArray(parsed.events)) {
      return { date: parsed.date ?? date, fetchedAt: parsed.fetchedAt ?? "", events: parsed.events as MarketAnnouncement[] };
    }
  } catch {
    // 没有事件账 = 还没采集过，正常。
  }
  return null;
}
