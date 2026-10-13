/**
 * 这个文件是干什么的：
 * 板块页的视图层——把 D6 分类索引和 D5 月度序列合成「一行一个板块」的表。
 *
 * 你需要知道的：
 * 1. **这张表不联网**。板块清单和月度序列都来自落盘缓存（fetch-industry*.mjs），
 *    所以页面加载不会因为接口挂了打不开——代价是数字不是实时的，
 *    页面上必须写清数据日期（`updatedAt`）。
 * 2. **没有月度数据的板块照样列出**，相关列留 null。缺数据和「这个月资金持平」
 *    是两件事，不许用 0 填（月度模块里就把这条钉死了，这儿沿用）。
 * 3. 排序只在有值的行之间排，缺值的永远沉底，不参与比较。
 * 4. 纯函数，不碰 fs。
 */

import type { IndustryIndex } from "./industry.ts";
import { recentMonths, thermometer, type IndustryMonth, type Thermometer, type ThermometerDirection } from "./industry-monthly.ts";

export type BoardRow = {
  code: string;
  name: string;
  /** 板块里的票只数 */
  members: number;
  /** 最新一个完整月（null = 一个完整月都没有） */
  latestMonth: string | null;
  /** 最新完整月的涨跌（%） */
  chgPct: number | null;
  /** 最新完整月的主力净流入（元） */
  mainNet: number | null;
  direction: ThermometerDirection;
  /** 方向读数的依据（「3 个完整月：月涨 2 / 月跌 1…」）。必须上屏，见下。 */
  basis: string;
  /** 完整月个数（不足 3 个给不出方向读数） */
  completeMonths: number;
};

export type BoardTable = {
  rows: BoardRow[];
  /** 分类索引的数据日期 */
  indexDate: string | null;
  /** 月度序列的数据日期 */
  monthlyDate: string | null;
  gaps: string[];
};

/** 板块代码 → 月度序列。落盘文件的形状。 */
export type MonthlyBook = { updatedAt?: string; boards?: Record<string, { name?: string; months?: IndustryMonth[] }> };

export function boardTable(index: IndustryIndex | null, monthly: MonthlyBook | null): BoardTable {
  const gaps: string[] = [];
  if (!index) {
    gaps.push("行业分类没抓过（跑 scripts/fetch-industry.mjs），板块列表出不来");
    return { rows: [], indexDate: null, monthlyDate: monthly?.updatedAt ?? null, gaps };
  }
  if (!monthly || !monthly.boards || Object.keys(monthly.boards).length === 0) {
    gaps.push("板块月度数据没抓过（跑 scripts/fetch-industry-monthly.mjs），列表里只有分类，没有温度");
  }
  const book = monthly?.boards ?? {};
  const rows: BoardRow[] = index.boards.map((board) => {
    const months = book[board.code]?.months ?? [];
    const complete = recentMonths(months, 3);
    const latest = complete[complete.length - 1] ?? null;
    // 方向读的是**近 3 个完整月**，而旁边那列是**最新一个月**。两者可以相反
    // （白银 2026-09 跌了近两成，近三个月仍是净流入为主 → 升温）。所以依据必须
    // 一起给，否则读者会以为这两列自相矛盾。
    const thermo = thermometer(months, 3);
    return {
      code: board.code,
      name: board.name,
      members: board.members.length,
      latestMonth: latest?.month ?? null,
      chgPct: latest?.chgPct ?? null,
      mainNet: latest?.mainNet ?? null,
      direction: thermo.direction,
      basis: thermo.basis,
      completeMonths: complete.length,
    };
  });
  if (rows.length > 0 && rows.every((r) => r.latestMonth == null)) {
    gaps.push("所有板块都没有完整月份，月度列全空（抓数脚本跑了吗？）");
  }
  return { rows, indexDate: index.updatedAt, monthlyDate: monthly?.updatedAt ?? null, gaps };
}

export type SortKey = "chg" | "net" | "members" | "name";

/**
 * 排序。缺值的行永远沉底——拿 null 当 0 参与比较，会让「没数据」混进「跌得最惨」那一头。
 */
export function sortBoards(rows: readonly BoardRow[], by: SortKey, desc = true): BoardRow[] {
  const out = [...rows];
  const miss = (r: BoardRow) => (by === "chg" ? r.chgPct == null : by === "net" ? r.mainNet == null : false);
  out.sort((a, b) => {
    const ma = miss(a);
    const mb = miss(b);
    if (ma !== mb) return ma ? 1 : -1;
    let d: number;
    if (by === "name") d = a.name.localeCompare(b.name, "zh");
    else if (by === "members") d = a.members - b.members;
    else if (by === "net") d = (a.mainNet ?? 0) - (b.mainNet ?? 0);
    else d = (a.chgPct ?? 0) - (b.chgPct ?? 0);
    return desc ? -d : d;
  });
  return out;
}

/** 按名字/代码搜板块。空串返回全部。 */
export function searchBoards(rows: readonly BoardRow[], q: string): BoardRow[] {
  const key = q.trim().toLowerCase();
  if (!key) return [...rows];
  return rows.filter((r) => r.name.toLowerCase().includes(key) || r.code.toLowerCase().includes(key));
}

export type BoardDetail = {
  code: string;
  name: string;
  months: IndustryMonth[];
  /** 最近 3 个完整月的方向读数 */
  thermo: Thermometer;
  members: string[];
  monthlyDate: string | null;
  gaps: string[];
};

/** 单个板块的详情：月度序列 + 方向读数 + 成分股 id。 */
export function boardDetail(index: IndustryIndex | null, monthly: MonthlyBook | null, code: string, window = 12): BoardDetail | null {
  const board = index?.boards.find((b) => b.code === code) ?? null;
  const hit = monthly?.boards?.[code];
  if (!board && !hit) return null;
  const months = (hit?.months ?? []).slice(-window);
  const gaps: string[] = [];
  if (!board) gaps.push("这个板块不在分类索引里（可能索引是旧抓的）");
  if (!hit) gaps.push("这个板块的月度数据没抓过");
  else if (months.length === 0) gaps.push("这个板块没有月度数据");
  return {
    code,
    name: board?.name ?? hit?.name ?? code,
    months,
    thermo: thermometer(hit?.months ?? [], 3),
    members: board?.members ?? [],
    monthlyDate: monthly?.updatedAt ?? null,
    gaps,
  };
}
