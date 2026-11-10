/**
 * 收盘后全量刷新 K 线缓存（data/backtest/kline/<id>.json）。
 *
 * 为什么单独一个脚本：generate-signals.ts 只**读**缓存不刷，而缓存只在回测运行时
 * 被懒刷新、且每天 15:00 的 AI 进化回测只抽样 BT_SAMPLE=300 只。于是缓存停在
 * 「上一次有人手动跑全池回测」的那天，导致当天信号用前一天的收盘价算出来——等于漏一天信号。
 *
 * 本脚本在 15:10（收盘 10 分钟后，日线已落定）把全市场 K 线补齐到最新交易日，
 * 让 15:30 的 generate-signals 读到的是当天收盘。
 *
 * ── 2026-11-10 改走快照批量接口（修 501 限流）────────────────────────
 * 旧实现逐只打 fqkline（web.ifzq.gtimg.cn）拉 800 根：2645 只请求，腾讯 WAF 按
 * IP 限流，实测跑到 ~1600 只就 501，剩下 1016 只冻结在旧日期。快照接口
 * web.sqt.gtimg.cn/utf8/q= 支持一只请求带 60 只、一次给全「今开/今高/今低/现价/
 * 成交量/昨收」，2645 只 ≈ 45 个请求，不受限。当天日线 = 快照现价（收盘后跑）。
 *
 * 复权口径：qfq 的「最新一根」= 不复权实际价（前复权以最新价为基准）。所以直接用
 * 快照的不复权 bar 当最新一根，和缓存里的 qfq 史天然衔接；只有「当天除权」的票会
 * 在接缝处留一天假跳（约 1-2%，量很小），靠 昨收 对不上缓存末收 记到 stderr 审计。
 *
 * 用法：
 *   node --experimental-strip-types --import ./scripts/alias.mjs scripts/refresh-kline.ts
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";

const DATA = process.env.CHIHENG_DATA_DIR ?? "data";
const KLINE = `${DATA}/backtest/kline`;
/** 快照批量：一次请求带多少只。60 只/请求，2645 只 ≈ 45 个请求。 */
const BATCH = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Row = { date: string; o: number; c: number; h: number; l: number; v: number };

const UA = "Mozilla/5.0";

/** 从腾讯快照的 88 字段里取当日 bar。字段口径（0 起）：3=现价 4=昨收 5=今开 33=最高 34=最低 36=成交量(手)。 */
function parseSnapshotLine(line: string): { date: string; o: number; h: number; l: number; c: number; v: number; prevClose: number } | null {
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  const f = line.slice(eq + 1).replace(/"/g, "").split("~");
  if (f.length < 37) return null;
  const ts = f[30] ?? "";
  if (!/^\d{14}$/.test(ts)) return null;
  const date = `${ts.slice(0, 4)}-${ts.slice(4, 6)}-${ts.slice(6, 8)}`;
  const o = Number(f[5]);
  const h = Number(f[33]);
  const l = Number(f[34]);
  const c = Number(f[3]);
  const v = Number(f[36]);
  const prevClose = Number(f[4]);
  if (![o, h, l, c].every(Number.isFinite) || c <= 0) return null;
  return { date, o, h, l, c, v: Number.isFinite(v) ? v : 0, prevClose };
}

/** 一次拉一批快照，返回 id → bar。 */
async function fetchSnapshotBatch(ids: string[]): Promise<Map<string, { date: string; o: number; h: number; l: number; c: number; v: number; prevClose: number }>> {
  const out = new Map();
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const url = `https://web.sqt.gtimg.cn/utf8/q=${chunk.join(",")}`;
    let text = "";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const buf = await (await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) })).arrayBuffer();
        // 接口路径带 /utf8/，返回就是 UTF-8；用 gbk 会把中文名解坏，名字乱码字节里
        // 偶尔含 `~`，把字段切分打乱 → 约 15% 的票 parse 失败被漏掉。
        text = new TextDecoder("utf-8").decode(buf);
        break;
      } catch {
        await sleep(500 * (attempt + 1));
      }
    }
    if (!text) continue;
    for (const line of text.split(";")) {
      const m = line.match(/v_([a-z]{2}\d{6})="(.*)"/);
      if (!m) continue;
      const bar = parseSnapshotLine(`${m[1]}=${m[2]}`);
      if (bar) out.set(m[1], bar);
    }
    await sleep(120); // 批间轻间隔，避免触发限流
  }
  return out;
}

async function main() {
  console.log("K 线刷新（快照批量）开始...\n");

  // 1. 全市场股票列表（和 generate-signals 同源）
  const ids: string[] = [];
  for (let page = 1; page <= 30 && ids.length < 5000; page += 1) {
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs_a`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
      if (!res.ok) break;
      const list = (await res.json()) as { symbol?: string }[];
      if (list.length === 0) break;
      for (const row of list) {
        const s = row.symbol ?? "";
        if (/^(sh|sz)\d{6}$/.test(s)) ids.push(s);
      }
    } catch {
      break;
    }
  }
  console.log(`股票池：${ids.length} 只`);

  // 2. 快照批量拉当日 bar
  const bars = await fetchSnapshotBatch(ids);
  console.log(`快照命中：${bars.size} 只`);
  if (bars.size === 0) {
    console.error("快照一只都没拿到，中止（不覆盖缓存）");
    process.exit(1);
  }

  // 3. 追加到缓存
  await mkdir(KLINE, { recursive: true });
  let appended = 0;
  let upToDate = 0;
  let noCache = 0;
  let volumeUnitFixed = 0;

  for (const id of ids) {
    const bar = bars.get(id);
    if (!bar) continue;
    let existing: Row[] = [];
    try {
      const raw = JSON.parse(await readFile(`${KLINE}/${id}.json`, "utf8"));
      if (Array.isArray(raw)) existing = raw;
    } catch {
      existing = [];
    }
    if (existing.length === 0) {
      noCache += 1;
      continue; // 无缓存：不造半截史，交给回测懒拉全史
    }
    const last = existing[existing.length - 1]!;

    // 量单位：快照 36 对科创板是「股」、其余是「手」；fqkline 缓存一律「手」
    // （科创板 1 手=1 股，但 fqkline 与快照口径差 100 倍，实测 688xxx 比值恒 100）。
    // 用确定性规则，不用「今日量 vs 末量」的比值——缓存陈旧时自然放量会被误判成单位错。
    const isStar = id.startsWith("sh688") || id.startsWith("sh689");
    const v = isStar ? bar.v / 100 : bar.v;

    if (last.date < bar.date) {
      existing.push({ date: bar.date, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v });
      await writeFile(`${KLINE}/${id}.json`, JSON.stringify(existing));
      appended += 1;
      continue;
    }

    // 已是最新交易日：若上一轮（旧脚本或本脚本第一版）把今天这根的量单位改错了，就地纠正。
    // 判据：今天的量不在同一量级（差 >2 倍）就是错单位。
    if (last.date === bar.date) {
      const correct = isStar ? bar.v / 100 : bar.v;
      if (correct > 0 && (last.v === 0 || Math.abs(last.v / correct - 1) > 1)) {
        existing[existing.length - 1] = { date: bar.date, o: bar.o, h: bar.h, l: bar.l, c: bar.c, v: correct };
        await writeFile(`${KLINE}/${id}.json`, JSON.stringify(existing));
        volumeUnitFixed += 1;
      } else {
        upToDate += 1;
      }
      continue;
    }

    upToDate += 1;
  }

  console.log(`\n刷新完成：追加 ${appended} 只，已最新 ${upToDate} 只，无缓存跳过 ${noCache} 只，量单位纠正 ${volumeUnitFixed} 只`);
}

main().catch((e) => {
  console.error("K 线刷新失败:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
