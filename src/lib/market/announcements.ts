/**
 * 这个文件是干什么的：
 * 巨潮全市场事件流（data/announcements/<date>.json）——按事件类目分别搜全市场
 * 当日公告，落盘供监管异动雷达/绝望底仓复核做事件过滤。巨潮个股快讯（cninfo.ts）
 * 之外的「全市场视角」。
 *
 * 你需要知道的（2026-11-15 全仓复检修正，每条都是实测踩过的坑）：
 * 1. **第一档合规源**：巨潮是证监会指定披露平台；按类目各查一次、翻完所有页，
 *    一天几页串行请求，频率无压力。
 * 2. **时区**：`announcementTime` 是北京时间毫秒，必须 +8h 再取 UTC 日期，
 *    否则整批错一天（cninfo.ts 的 dayOf 口径、registry.ts 登记的老坑）。
 * 3. **覆盖率**：不能只用 `searchkey=公告`（实测当日 800 条/8 页，且问询函
 *    标题多不含「公告」二字）。改为按事件类目各自的 query 查、按 totalpages
 *    翻完，再合并去重。
 * 4. **负向过滤**：「不减持」「解除质押」「业绩说明会」等反向/中性公告不算事件。
 * 5. 原子落盘（tmp + rename）、JSON.parse 容错、loadEventStream 校验结构。
 * 6. node API 函数内动态 import（浏览器兼容铁律）。
 */

const fsApi = () => import("node:fs/promises");
const posixJoin = (...parts: string[]): string => parts.join("/");

function dataDir(): string {
  return process.env.CHIHENG_DATA_DIR ?? posixJoin(process.cwd(), "data");
}

/**
 * 事件类目。
 * - `query`：发给巨潮 fulltextSearch 的 searchkey（按类目分别查，覆盖率远高于泛搜「公告」）。
 * - `keywords`：标题匹配用（命中任一即归入该类）。
 * - `negative`：命中即排除（反向/中性公告，如「不减持」「解除质押」）。
 * 顺序即优先级：一条标题命中多类时取最靠前的类。
 */
export const EVENT_CATEGORIES: { key: string; label: string; query: string; keywords: string[]; negative: string[] }[] = [
  { key: "inquiry", label: "问询/关注函", query: "问询函", keywords: ["问询函", "关注函", "监管工作函"], negative: [] },
  { key: "reduction", label: "减持", query: "减持", keywords: ["减持计划", "减持股份", "被动减持"], negative: ["不减持", "终止减持"] },
  { key: "forecast", label: "业绩预告", query: "业绩预告", keywords: ["业绩预告", "业绩快报"], negative: ["业绩说明会", "业绩说明会预告"] },
  { key: "investigation", label: "立案/处罚", query: "立案", keywords: ["立案", "行政处罚", "警示函"], negative: [] },
  { key: "pledge", label: "质押/平仓", query: "质押", keywords: ["质押", "平仓"], negative: ["解除质押", "质押解除"] },
];

/** 一条全市场公告事件。 */
export type MarketAnnouncement = {
  id: string;
  code: string;
  name: string;
  title: string;
  /** 发布日期 YYYY-MM-DD（北京时间，已修正 +8h）。 */
  date: string;
  url: string;
  /** 命中的类目 key。 */
  category: string;
};

/** 一天的全市场事件账。 */
export type AnnouncementEventBook = {
  date: string;
  fetchedAt: string;
  events: MarketAnnouncement[];
  /** 本次采集各 query 扫到的原始条数（覆盖率可观测）。 */
  scanned: Record<string, number>;
};

/** 剥巨潮标题里的任意 HTML 标签 + 解码常见实体（标题会被 <em> 逐词切开）。 */
export function stripEm(title: string): string {
  return title
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

/** 北京时间毫秒 → YYYY-MM-DD（+8h 再取 UTC，和 cninfo.ts:dayOf 同一口径）。 */
export function dayOfBeijingMs(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 标题 → 类目 key。命中负向词的部分先从标题里剔除再匹配，
 *  这样「部分股份质押及解除质押」仍算质押，而纯「解除质押」不算；
 *  「不减持承诺」同理不算减持。命中多个取最靠前的类。 */
export function categoryOf(title: string): string | null {
  const clean = stripEm(title);
  for (const cat of EVENT_CATEGORIES) {
    let probe = clean;
    // 长负向词先剔，避免「业绩说明会预告」被短词切碎。
    for (const neg of [...cat.negative].sort((a, b) => b.length - a.length)) {
      probe = probe.split(neg).join("");
    }
    if (cat.keywords.some((kw) => probe.includes(kw))) return cat.key;
  }
  return null;
}

type RawAnn = {
  announcementId?: string;
  secCode?: string;
  secName?: string;
  announcementTitle?: string;
  announcementTime?: number;
  adjunctUrl?: string;
};

/** 一次 fulltextSearch 查询的返回值。防爬会回 HTML，必须检测响应体开头。 */
async function queryPage(keyword: string, date: string, page: number, pageSize: number): Promise<{ rows: RawAnn[]; totalPages: number } | null> {
  const url =
    `https://www.cninfo.com.cn/new/fulltextSearch/full?searchkey=${encodeURIComponent(keyword)}` +
    `&sdate=${date}&edate=${date}&isfulltext=false&sortName=pubtime&sortType=desc&pageNum=${page}&pageSize=${pageSize}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": "Mozilla/5.0",
      Referer: "https://www.cninfo.com.cn/new/fulltextSearch",
      "X-Requested-With": "XMLHttpRequest",
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return null;
  const text = (await res.text()).trim();
  if (!text.startsWith("{")) return null; // 防爬 HTML
  try {
    const parsed = JSON.parse(text) as {
      announcements?: RawAnn[] | null;
      totalpages?: number;
      totalPage?: number;
    };
    const totalPages = Number(parsed.totalpages ?? parsed.totalPage ?? 1);
    return { rows: Array.isArray(parsed.announcements) ? parsed.announcements : [], totalPages: Number.isFinite(totalPages) ? totalPages : 1 };
  } catch {
    return null; // 截断/混入非 JSON，不抛给上层
  }
}

/**
 * 采集：按事件类目分别查询、翻完所有页（maxPages 兜底防失控）、合并去重、
 * 分类过滤、原子落盘。
 */
export async function fetchEventStream(date: string, opts: { maxPages?: number; pageSize?: number } = {}): Promise<AnnouncementEventBook> {
  const maxPages = opts.maxPages ?? 10;
  const pageSize = opts.pageSize ?? 100;
  const seen = new Set<string>();
  const raws: { id: string; code: string; name: string; title: string; date: string; url: string }[] = [];
  const scanned: Record<string, number> = {};

  for (const cat of EVENT_CATEGORIES) {
    let count = 0;
    for (let page = 1; page <= maxPages; page++) {
      const got = await queryPage(cat.query, date, page, pageSize);
      if (!got) break;
      count += got.rows.length;
      for (const item of got.rows) {
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
          date: typeof item.announcementTime === "number" ? dayOfBeijingMs(item.announcementTime) : date,
          url: item.adjunctUrl ? `http://static.cninfo.com.cn/${item.adjunctUrl}` : "",
        });
      }
      if (page >= got.totalPages) break;
    }
    scanned[cat.key] = count;
  }

  const events: MarketAnnouncement[] = raws.flatMap((r) => {
    const category = categoryOf(r.title);
    if (!category) return [];
    return [{ ...r, category }];
  });
  const book: AnnouncementEventBook = { date, fetchedAt: new Date().toISOString(), events, scanned };
  await saveEventStream(book);
  return book;
}

/** 落盘路径：data/announcements/<date>.json。 */
export function eventPath(date: string): string {
  return posixJoin(dataDir(), "announcements", `${date}.json`);
}

/** 原子落盘：先写 .tmp 再 rename，杜绝半截 JSON 被当成「已采集」。 */
async function saveEventStream(book: AnnouncementEventBook): Promise<void> {
  const { mkdir, writeFile, rename } = await fsApi();
  const dir = posixJoin(dataDir(), "announcements");
  await mkdir(dir, { recursive: true });
  const target = eventPath(book.date);
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(book, null, 2));
  await rename(tmp, target);
}

/** 纯读盘：没有/损坏/结构不对都返回 null（不编账）。 */
export async function loadEventStream(date: string): Promise<AnnouncementEventBook | null> {
  try {
    const { readFile } = await fsApi();
    const parsed = JSON.parse(await readFile(eventPath(date), "utf8")) as { date?: string; fetchedAt?: string; events?: unknown; scanned?: unknown };
    if (Array.isArray(parsed.events)) {
      return {
        date: parsed.date ?? date,
        fetchedAt: parsed.fetchedAt ?? "",
        events: parsed.events as MarketAnnouncement[],
        scanned: (parsed.scanned && typeof parsed.scanned === "object" ? parsed.scanned : {}) as Record<string, number>,
      };
    }
  } catch {
    // 没有事件账 / 半截 JSON = 还没采集过，正常。
  }
  return null;
}
