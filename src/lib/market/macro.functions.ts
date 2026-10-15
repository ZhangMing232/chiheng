/**
 * 这个文件是干什么的：
 * 中债收益率曲线的服务端接口（/review 每日复盘用）。
 *
 * 接口来自 a-stock-data SKILL V3.10.2 §11.3（中央结算公司官方，零鉴权）。
 *
 * 你需要知道的：
 * 1. **官网单次查询超过 1 年会静默返回 0 行**——所以窗口固定 180 天，
 *    不给参数（要更长就得自己切片，那是回测的事，不是日频页面的事）。
 * 2. **它不公布债券市场交易日历**，也没有总条数，所以「某天没数据」分不清是节假日
 *    还是接口坏了。这里不报错，只报**数据截至哪天**，页面自己标。
 * 3. 缓存 6 小时：国债收益率一天只变一次（每交易日收盘后更新），6 小时内重复
 *    拉是浪费。TTL 走 fetch-policy，不在代码里写死。
 * 4. **拿不到就给 null**，页面显示「宏观数据没拿到」，不显示全 0。
 */

import { createServerFn } from "@tanstack/react-start";
import { parseYieldCurve, snapshotOf, type MacroSnapshot, type YieldPoint } from "./macro.ts";
import { ttlOf } from "@/lib/market/fetch-policy";

const CHINABOND_URL = "https://yield.chinabond.com.cn/cbweb-pbc-web/pbc/historyQuery";
/** 官网超过 1 年静默返回 0 行，180 天留足余量。 */
const WINDOW_DAYS = 180;

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

export type MacroPayload = {
  snapshot: MacroSnapshot | null;
  /** 最近 N 个交易日，画曲线用 */
  points: YieldPoint[];
  /** 数据截至哪天（官网不给"今天"这个保证） */
  asOf: string | null;
  why: string | null;
};

async function fetchCurve(): Promise<string> {
  const url = new URL(CHINABOND_URL);
  url.search = new URLSearchParams({
    startDate: isoDaysAgo(WINDOW_DAYS),
    endDate: new Date().toISOString().slice(0, 10),
    gjqx: "0",
    qxId: "hzsylqx", // 国债收益率曲线
    locale: "cn_ZH",
  }).toString();
  const res = await fetch(url, {
    headers: { "user-agent": "Mozilla/5.0", referer: "https://yield.chinabond.com.cn/" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`中债 HTTP ${res.status}`);
  return await res.text();
}

export const getMacro = createServerFn({ method: "GET" }).handler(async (): Promise<MacroPayload> => {
  try {
    const html = await fetchCurve();
    const { points, bad } = parseYieldCurve(html);
    if (points.length === 0) {
      return {
        snapshot: null,
        points: [],
        asOf: null,
        why: bad > 0 ? `中债返回了 ${bad} 行但没有一行认得出来，接口格式可能变了` : "中债没返回数据",
      };
    }
    // 画曲线只给最近 60 个交易日，够看形状了
    const tail = points.slice(-60);
    const snapshot = snapshotOf(points);
    return { snapshot, points: tail, asOf: snapshot?.date ?? null, why: null };
  } catch (error) {
    // 拿不到就说拿不到——页面显示「宏观数据没拿到」，不编数
    return {
      snapshot: null,
      points: [],
      asOf: null,
      why: `中债没拉到：${error instanceof Error ? error.message : String(error)}`,
    };
  }
});

/** 缓存有效期：国债收益率每交易日收盘后更新，6 小时足够。 */
export const MACRO_TTL_MS = ttlOf("kline") * 2;