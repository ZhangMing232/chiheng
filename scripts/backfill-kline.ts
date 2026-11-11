/**
 * K 线回补——把缺失的股票日线补齐（非复权接口，fqkline 被 WAF 挡只能用这个）。
 *
 * 用非复权 day 接口（web.ifzq.gtimg.cn/appstock/app/kline/kline），约 300 天，
 * 覆盖监管异动/题材轮动的 5 日窗口足够。注意：非复权 vs 缓存里的 qfq 有除权日差异，
 * 但短窗口（5日）动量计算可忽略。
 *
 * 用法：node --experimental-strip-types --import ./scripts/alias.mjs scripts/backfill-kline.ts [id...]
 *   不给 id 就自动补「涨停池里缺失」的票。
 */

import { readFile, writeFile } from "node:fs/promises";
import { existsSync as ex } from "node:fs";

const UA = "Mozilla/5.0";
const KLINE = "data/backtest/kline";

async function fetchDay(id: string): Promise<{ date: string; o: number; c: number; h: number; l: number; v: number }[]> {
  const url = `https://web.ifzq.gtimg.cn/appstock/app/kline/kline?param=${id},day,,,300`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) return [];
  const body = (await res.json()) as { data?: Record<string, { day?: string[][] }> };
  const rows = body.data?.[id]?.day ?? [];
  return rows
    .filter((r) => Array.isArray(r) && r.length >= 6)
    .map((r) => ({ date: r[0], o: Number(r[1]), c: Number(r[2]), h: Number(r[3]), l: Number(r[4]), v: Number(r[5]) }));
}

async function main() {
  let ids: string[] = process.argv.slice(2);
  if (ids.length === 0) {
    // 默认：universe 里所有缺 K 线缓存的票（不只涨停池）
    const uni = JSON.parse(await readFile("data/universe-cache.json", "utf8")) as { payload?: { quotes?: { id: string }[] } };
    ids = (uni.payload?.quotes ?? []).map((q) => q.id).filter((id) => id && !ex(`${KLINE}/${id}.json`));
  }
  ids = ids.filter((id) => !ex(`${KLINE}/${id}.json`));
  console.log(`回补 ${ids.length} 只缺失 K 线...`);

  let ok = 0;
  for (const id of ids) {
    const rows = await fetchDay(id);
    if (rows.length > 0) {
      await writeFile(`${KLINE}/${id}.json`, JSON.stringify(rows, null, 0));
      ok += 1;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  console.log(`回补完成：${ok}/${ids.length}`);
}

main().catch((e) => {
  console.error("回补失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
