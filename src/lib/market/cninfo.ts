/**
 * 这个文件是干什么的：
 * 巨潮资讯网（cninfo.com.cn）公告接口。**证监会指定的法定披露平台**。
 *
 * 你需要知道的（这几条全是实测出来的，不是照抄文档）：
 *
 * 1. **`stock` 参数必须是 `代码,orgId`，只给代码会返回 `announcements: null`。**
 *    这是最容易踩的坑——接口不报错，只是静默返回空，看不出来是参数错了。
 *
 * 2. **orgId 只能查，不能拼。** 实测三种格式：
 *      000001 平安银行 → `gssz0000001`（gssz+代码）
 *      600519 贵州茅台 → `gssh0600519`（gssh+代码）
 *      002475 立讯精密 → `9900014448`（纯数字，不规律）
 *    所以必须走 `topSearch` 查，然后缓存。一只票查一次就够，缓存常驻内存。
 *
 * 3. **返回不一定是 JSON。** 触发防爬时会回一段 HTML，此时 `announcements` 为 null。
 *    这里检测响应体开头是不是 `{`，不是就当失败——不能拿 HTML 去 JSON.parse，
 *    那会抛一个看不懂的错，而不是「巨潮没给数据」。
 *
 * 4. `announcementTime` 是**毫秒时间戳**，不是日期字符串。
 *
 * 5. `adjunctUrl` 是相对路径（如 `finalpage/2026-08-15/1225475868.PDF`），
 *    要拼上 `http://static.cninfo.com.cn/` 才是能打开的 PDF 原文。
 *
 * 6. `column` 参数（szse/sse）**可以不传**，不传时返回条数更多（含两市）。
 */

/**
 * ⚠️ 浏览器兼容（2026-10-25，同类坑第三次）：
 * 顶层 import node:https 会被 vite 转成空壳桩顶层解构，模块一求值就抛
 * 「Module externalized」→ hydration 跑不了 → 整站按钮失灵（页面能看、点不动）。
 * 本文件经 news.ts（studio 路由链）进客户端闭包，https 必须函数内动态
 * import（postForm 因此改成 async——它本来就返回 Promise，调用方无感）。
 */

/** 巨潮的 orgId：同代码不同档期格式不一样，只能查出来缓存住。 */
const orgIdCache = new Map<string, string | null>();

export type CninfoAnnouncement = {
  /** 巨潮的公告 id，同一条公告的唯一标识。 */
  id: string;
  code: string;
  name: string;
  title: string;
  /** 披露日期，YYYY-MM-DD。 */
  time: string;
  /** PDF 原文链接（static.cninfo.com.cn）。 */
  url: string;
  /** 附件大小，KB。巨潮给的是整数，拿不到记 0 不瞎编。 */
  sizeKb: number;
};

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const DISCLOSURE_REFERER = "https://www.cninfo.com.cn/new/disclosure";

/** POST 表单。失败一律 reject，由调用方决定降级——这里不吞异常。 */
async function postForm(url: string, body: string, referer = DISCLOSURE_REFERER): Promise<string> {
  const https = await import("node:https");
  return new Promise((resolve, reject) => {
    const payload = Buffer.from(body, "utf8");
    const req = https.request(
      url,
      {
        method: "POST",
        timeout: 12_000,
        headers: {
          "user-agent": UA,
          referer,
          "x-requested-with": "XMLHttpRequest",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "content-length": payload.length,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk as Buffer));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      },
    );
    req.on("timeout", () => req.destroy(new Error("巨潮超时")));
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** 六位代码 → 巨潮的 orgId。查不到记 null（缓存住，别反复查一个查不到的）。 */
export async function lookupOrgId(code: string): Promise<string | null> {
  if (!/^\d{6}$/.test(code)) return null;
  const cached = orgIdCache.get(code);
  if (cached !== undefined) return cached;
  try {
    const raw = await postForm(
      "https://www.cninfo.com.cn/new/information/topSearch/query",
      `keyWord=${code}&maxNum=5`,
    );
    const trimmed = raw.trim();
    if (!trimmed.startsWith("[")) return (orgIdCache.set(code, null), null);
    const rows = JSON.parse(trimmed) as { code?: string; orgId?: string }[];
    const hit = rows.find((row) => row.code === code && row.orgId) ?? rows[0];
    const orgId = hit?.orgId ?? null;
    orgIdCache.set(code, orgId);
    return orgId;
  } catch {
    // 查不到不缓存失败：下次换个时点可能就通了，缓存 null 等于永久放弃这只票
    return null;
  }
}

/**
 * 毫秒时间戳 → YYYY-MM-DD。非法值返回空串，不编一个日期出来。
 *
 * **必须加 8 小时再取 UTC**：巨潮的 `announcementTime` 是北京时间的零点
 * （实测 1786723200000 = 2026-08-15 00:00 CST），而 `toISOString()` 出的是 UTC，
 * 直接切会退 8 小时变成 2026-08-14——**整批公告的日期都会错一天**。
 * 这个坑是测试抓出来的，不是看出来的。
 */
export function dayOf(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

/** 相对路径 → PDF 原文链接。巨潮给的是 `finalpage/2026-08-15/xxx.PDF`，要拼域名。 */
export function pdfUrlOf(adjunctUrl: string | undefined | null): string {
  const path = (adjunctUrl ?? "").trim();
  if (!path) return "";
  return `http://static.cninfo.com.cn/${path}`;
}

type RawAnn = {
  secCode?: string;
  secName?: string;
  announcementId?: string | number;
  announcementTitle?: string;
  announcementTime?: number;
  adjunctUrl?: string;
  adjunctSize?: number;
};

/**
 * 拉一只票最近的公告。**失败返回空数组，绝不抛错**——
 * 调用方（news.ts）拿它当首选源，空了就降级到东财，不能让巨潮挂了把整块消息带崩。
 */
export async function loadCninfoAnnouncements(code: string, limit = 8): Promise<CninfoAnnouncement[]> {
  if (!/^\d{6}$/.test(code)) return [];
  const orgId = await lookupOrgId(code);
  if (!orgId) return [];
  try {
    const body = new URLSearchParams({
      pageNum: "1",
      pageSize: String(Math.min(Math.max(limit, 1), 30)),
      tabName: "fulltext",
      stock: `${code},${orgId}`,
      sortName: "time",
      sortType: "desc",
      isHLtitle: "true",
    }).toString();
    const raw = await postForm("https://www.cninfo.com.cn/new/hisAnnouncement/query", body);
    const trimmed = raw.trim();
    // 防爬兜底会回 HTML，不是 JSON。这里必须挡住，否则下面的 parse 会抛个看不懂的错。
    if (!trimmed.startsWith("{")) return [];
    const parsed = JSON.parse(trimmed) as { announcements?: RawAnn[] | null };
    return (parsed.announcements ?? []).flatMap((item) => {
      const title = (item.announcementTitle ?? "").trim();
      const id = item.announcementId != null ? String(item.announcementId) : "";
      if (!title || !id) return [];
      return [
        {
          id,
          code: item.secCode ?? code,
          name: item.secName ?? "",
          title,
          time: typeof item.announcementTime === "number" ? dayOf(item.announcementTime) : "",
          url: pdfUrlOf(item.adjunctUrl),
          sizeKb: typeof item.adjunctSize === "number" ? item.adjunctSize : 0,
        },
      ];
    });
  } catch {
    return [];
  }
}
