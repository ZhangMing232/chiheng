/**
 * 这个文件是干什么的：
 * tushare HTTP 客户端。赤轨的第一个基本面数据源——以前 26 个因子全部建立在
 * OHLCV 上，财报维度（ROE/扣非同比/负债率）接进来后，6 关检验第一次能审
 * 「公司质量」类的假设。
 *
 * 你需要知道的：
 * 1. token 放 data/tushare-config.json（{"token": "..."}），不进 git、不出服务端。
 *    和 push-config.json 同一取舍。
 * 2. tushare 是标准 HTTP API：POST http://api.tushare.pro 一个端点，body 里
 *    带 api_name / token / params / fields——不需要 Python，Node 直连。
 * 3. 限频：相邻调用间隔 MIN_INTERVAL_MS（官方按积分限速，宁慢勿封）。积分不够
 *    时接口返回明确的「积分」错误码，把 msg 原样抛给调用方，不吞。
 * 4. 响应约定：{code: 0, data: [{...}]} 是成功；code != 0 抛错带 msg。
 *    「没数据」（如某季度无记录）返回空数组，不是错误。
 * 5. server-only：fetch 和 fs 都在这一层，纯逻辑（如 PIT 对齐）在 fundamentals.ts。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

const API_URL = "http://api.tushare.pro";
const MIN_INTERVAL_MS = 400;

/** 读 token；没配返回 null。 */
export async function readTushareToken(): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(join(process.cwd(), "data", "tushare-config.json"), "utf8"));
    return typeof parsed.token === "string" && parsed.token.trim() ? parsed.token.trim() : null;
  } catch {
    return null;
  }
}

let lastCallAt = 0;

async function throttle(): Promise<void> {
  const wait = MIN_INTERVAL_MS - (Date.now() - lastCallAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCallAt = Date.now();
}

/**
 * 调一次 tushare。fields 给 null 返回全部字段（列名以官方文档为准）。
 * 成功返回行数组；任何 HTTP/接口错误抛 Error（msg 原文带出来）。
 */
export async function callTushare(apiName: string, params: Record<string, string>, fields: string | null = null): Promise<Record<string, unknown>[]> {
  const token = await readTushareToken();
  if (!token) throw new Error("data/tushare-config.json 没配 token");
  await throttle();
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ api_name: apiName, token, params, fields: fields ?? "" }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`tushare HTTP ${res.status}`);
  const body = (await res.json().catch(() => null)) as { code?: number; msg?: string | null; data?: Record<string, unknown>[][] } | null;
  if (!body) throw new Error("tushare 返回不是 JSON");
  if (body.code !== 0) throw new Error(`tushare ${apiName} 失败（code ${body.code}）：${body.msg ?? "无 msg"}`);
  // data 形状：[ [字段名...], [行1...], [行2...] ]——第一行是表头
  const data = body.data;
  if (!data || data.length < 1) return [];
  const [header, ...rows] = data as [unknown, ...unknown[]];
  const keys = header as string[];
  return (rows as unknown[][]).map((row) => Object.fromEntries(keys.map((h, i) => [h, row[i]])));
}
