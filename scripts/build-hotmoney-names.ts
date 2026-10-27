/**
 * build-hotmoney-names.ts
 *
 * 扫描 data/risk/hotmoney/ 下所有 JSON 文件，收集个股 name，通过 namesOf API
 * 反查股票代码，构建 name→code 离线缓存。
 *
 * 运行：node --experimental-strip-types --import ./scripts/alias.mjs scripts/build-hotmoney-names.ts
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { namesOf } from "@/lib/market/hotmoney";

const HOTMONEY_DIR = join(import.meta.dirname!, "..", "data", "risk", "hotmoney");
const OUTPUT_FILE = join(import.meta.dirname!, "..", "data", "risk", "hotmoney-names.json");
const SAVE_EVERY = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface HotStock { name: string; netWan: number; }
interface HotSeat { name: string; netWan: number; stocks: HotStock[]; }
interface HotBook { date: string; seats: HotSeat[]; fetchedAt?: string; }

function loadCache(): Map<string, string> {
  const map = new Map<string, string>();
  if (existsSync(OUTPUT_FILE)) {
    try {
      const raw = JSON.parse(readFileSync(OUTPUT_FILE, "utf-8")) as Record<string, string>;
      for (const [name, code] of Object.entries(raw)) {
        map.set(name, code);
      }
      console.log(`  从缓存恢复 ${map.size} 条已有映射`);
    } catch { /* 忽略损坏的缓存 */ }
  }
  return map;
}

function saveCache(map: Map<string, string>): void {
  const obj: Record<string, string> = {};
  for (const [name, code] of [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "zh"))) {
    obj[name] = code;
  }
  writeFileSync(OUTPUT_FILE, JSON.stringify(obj, null, 2), "utf-8");
  console.log(`  ✓ 已保存 ${map.size} 条映射`);
}

async function main(): Promise<void> {
  console.log("=== build-hotmoney-names ===\n");

  // 1. 扫描所有 JSON 文件
  const files = readdirSync(HOTMONEY_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  console.log(`扫描到 ${files.length} 个 hotmoney JSON 文件\n`);

  // 2. 收集每个文件里的 date 和个股 name
  //    date → 当天 JSON 里出现的 name 集合（只收集还没有 code 的）
  const dateNames = new Map<string, Set<string>>();
  let totalNames = 0;

  for (const file of files) {
    const path = join(HOTMONEY_DIR, file);
    let book: HotBook;
    try {
      book = JSON.parse(readFileSync(path, "utf-8")) as HotBook;
    } catch {
      continue;
    }
    if (!book.date || !Array.isArray(book.seats)) continue;

    let names = dateNames.get(book.date);
    if (!names) {
      names = new Set<string>();
      dateNames.set(book.date, names);
    }
    for (const seat of book.seats) {
      for (const stock of seat.stocks) {
        if (stock.name) {
          names.add(stock.name);
          totalNames++;
        }
      }
    }
  }

  const uniqueDates = [...dateNames.keys()].sort();
  const uniqueNames = new Set([...dateNames.values()].flatMap((s) => [...s]));
  console.log(`共 ${uniqueDates.length} 个交易日，${uniqueNames.size} 个去重股票名\n`);

  // 3. 加载已有缓存，过滤掉已解析的 name
  const cache = loadCache();
  for (const name of cache.keys()) {
    for (const [, names] of dateNames) {
      names.delete(name);
    }
  }
  // 清理空日期的 keys
  for (const [date, names] of dateNames) {
    if (names.size === 0) dateNames.delete(date);
  }

  const remainingDates = [...dateNames.keys()].sort();
  const remainingNames = new Set([...dateNames.values()].flatMap((s) => [...s]));
  console.log(`还需查询 ${remainingDates.length} 个日期，${remainingNames.size} 个未知股票名\n`);

  if (remainingDates.length === 0) {
    console.log("所有名称已有缓存，无需查询。");
    return;
  }

  // 4. 逐日期查询 namesOf，反查 name→code
  let batchCount = 0;
  let successDates = 0;
  let failDates = 0;
  let newMappings = 0;

  for (const date of remainingDates) {
    const wantedNames = dateNames.get(date)!;
    process.stdout.write(`[${successDates + failDates + 1}/${remainingDates.length}] ${date} 查询中... `);

    let codeToName: Map<string, string>;
    try {
      codeToName = await namesOf(date);
    } catch (err) {
      console.log(`失败: ${String(err).slice(0, 80)}`);
      failDates++;
      continue;
    }

    if (codeToName.size === 0) {
      console.log(`无数据`);
      failDates++;
      continue;
    }

    // 反向映射：name → code（去后缀空格）
    const nameToCode = new Map<string, string>();
    for (const [code, name] of codeToName) {
      const clean = name.trim();
      if (clean) nameToCode.set(clean, code);
    }

    let matched = 0;
    for (const name of wantedNames) {
      const code = nameToCode.get(name);
      if (code) {
        cache.set(name, code);
        matched++;
        newMappings++;
      }
    }

    console.log(`${matched}/${wantedNames.size} 匹配`);
    successDates++;

    batchCount++;
    if (batchCount % SAVE_EVERY === 0) {
      saveCache(cache);
    }

    await sleep(500);
  }

  // 5. 最终保存
  saveCache(cache);

  console.log(`\n=== 完成 ===`);
  console.log(`成功日期: ${successDates}`);
  console.log(`失败日期: ${failDates}`);
  console.log(`新增映射: ${newMappings}`);
  console.log(`缓存总数: ${cache.size}`);

  // 6. 报告未匹配的名称
  const unmatched: string[] = [];
  for (const [, names] of dateNames) {
    for (const name of names) {
      if (!cache.has(name)) unmatched.push(name);
    }
  }
  if (unmatched.length > 0) {
    console.log(`\n⚠ 无法匹配 ${unmatched.length} 个名称: ${unmatched.slice(0, 20).join(", ")}${unmatched.length > 20 ? "..." : ""}`);
  }
}

main().catch((err) => {
  console.error("脚本异常:", err);
  process.exit(1);
});