/**
 * 这个文件是干什么的：
 * 拉**东财三级行业分类**（D6），写成 data/backtest/industry.json。
 *
 * 为什么是东财不是申万：2026-10-13 探过源，申万官网的分类/成分股接口全 404
 * （akshare 那条 institute-sw/.../details/ 路径已下线），只剩指数行情接口。
 * 东财三级行业（m:90+t:2，496 个板块）粒度到「印制电路板」「白酒Ⅱ」，
 * 成分股能反查，和赤轨现有板块体系同源。代价：东财分类是东财自己编的，
 * 不是业界标准口径——报告里写行业归属要带来源，别当申万说。
 *
 * 已知的硬约束（别当 bug 修）：
 * 1. **东财有风控**：串行 + 每次间隔 ≥1.2s，别开并发，否则封 IP。
 *    496 个板块全量约 10 分钟，先跑 --limit 20 看一眼。
 * 2. 一只票可能命中多个板块（东财口径有嵌套），索引里记进 duplicates，不静默取第一个。
 * 3. 解析全在 src/lib/market/industry.ts（有单测），这个脚本只负责拉和存。
 *
 * 跑法：
 *   node scripts/fetch-industry.mjs --limit 20     # 先验证
 *   node scripts/fetch-industry.mjs                # 全量
 */

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildIndustryIndex, parseBoardMembers, parseIndustryBoards } from "../src/lib/market/industry.ts";

const here = new URL("..", import.meta.url).pathname;
const OUT = join(here, "data", "backtest", "industry.json");
const UA = "Mozilla/5.0";
const GAP_MS = 1300;
const limitArg = process.argv.indexOf("--limit");
const LIMIT = limitArg >= 0 ? Number(process.argv[limitArg + 1]) : 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  const res = await fetch(url, {
    headers: { "user-agent": UA, referer: "https://quote.eastmoney.com/" },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  try {
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * 板块清单要分页拉：**pz 设 500 也只回 100 条**（东财的硬限制，实测）。
 * 认这个事实，按页循环到拿满为止，不要指望一次拉全。
 */
async function boardList() {
  const all = [];
  const problems = [];
  for (let page = 1; page <= 10; page += 1) {
    const body = await get(
      "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2&fid=f3".replace("pn=1", `pn=${page}`) +
        "&fs=m:90+t:2&fields=f12,f13,f14,f3,f20,f104,f105",
    );
    const { boards, gaps } = parseIndustryBoards(body);
    problems.push(...gaps.map((g) => g.reason));
    if (boards.length === 0) break;
    all.push(...boards);
    if (boards.length < 100) break;
    await sleep(GAP_MS);
  }
  return { all, problems };
}

/**
 * 板块成分股也要分页拉：**和板块清单一样，pz 设 500 也只回 100 条**。
 * 实测「食品饮料」「有色金属」这种大板块都被截在 100 只，结果是
 * ① 大盘板块的票对不上（覆盖不全）；② 层级包含关系判断失真（白酒Ⅲ 明明是
 * 食品饮料的子集，因为父集被截断而判成「交叉」），剪枝大面积失效。
 */
async function boardMembers(board) {
  const members = [];
  let gap = null;
  for (let page = 1; page <= 20; page += 1) {
    const body = await get(
      "https://push2.eastmoney.com/api/qt/clist/get" +
        `?pn=${page}&pz=500&po=1&np=1&fltt=2&invt=2&fid=f3&fs=b:${board.code}&fields=f12,f13,f14`,
    );
    const { members: page_members, gap: pageGap } = parseBoardMembers(body, board);
    if (page_members.length === 0) break;
    for (const id of page_members) if (!members.includes(id)) members.push(id);
    if (pageGap) gap = pageGap;
    if (page_members.length < 100) break;
    await sleep(GAP_MS);
  }
  return { members, gap };
}

async function main() {
  const { all, problems: listProblems } = await boardList();
  const { boards, gaps } = { boards: all, gaps: listProblems.map((reason) => ({ reason })) };
  if (boards.length === 0) {
    console.error("板块清单没解析出来，不写了：", gaps.map((g) => g.reason).join("；"));
    process.exit(1);
  }
  const targets = LIMIT > 0 ? boards.slice(0, LIMIT) : boards;
  console.log(`板块 ${boards.length} 个，本次拉 ${targets.length} 个（间隔 ${GAP_MS}ms 串行）`);

  const out = [];
  const problems = [];
  for (let i = 0; i < targets.length; i += 1) {
    const board = targets[i];
    const { members, gap } = await boardMembers(board);
    if (gap) problems.push(gap);
    if (members.length > 0) out.push({ code: board.code, name: board.name, members });
    if ((i + 1) % 25 === 0 || i + 1 === targets.length) console.log(`  ${i + 1}/${targets.length} ${board.name}`);
    await sleep(GAP_MS);
  }

  const index = buildIndustryIndex(
    out,
    new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10),
  );
  await mkdir(join(here, "data", "backtest"), { recursive: true });
  const tmp = `${OUT}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  await writeFile(tmp, JSON.stringify(index), "utf-8");
  await rename(tmp, OUT);

  console.log(`\n写好了 ${OUT}`);
  console.log(`  板块 ${index.boards.length} 个，覆盖个股 ${index.symbols} 只`);
  console.log(`  剪枝后仍多归属（不在同一条链上）${index.ambiguous.length} 只`);
  if (index.ambiguous.length > 0) {
    const first = index.ambiguous[0];
    console.log(`    例：${first.id} → ${first.boards.join(" / ")}`);
  }
  if (problems.length > 0) console.log(`  ${problems.length} 个板块有问题：${problems.slice(0, 5).join("；")}`);
  if (LIMIT > 0) console.log("  这是 --limit 抽样，全量请去掉 --limit 重跑");
}

main().catch((error) => {
  console.error("抓行业分类失败：", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
