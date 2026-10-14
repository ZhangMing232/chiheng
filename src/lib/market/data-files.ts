/**
 * 这个文件是干什么的：
 * 本机数据文件的新鲜度盘点——设置页「数据新鲜度」那一块的逻辑。
 *
 * 为什么要有它：赤轨的数据散在 `data/` 下十几份（行情快照、流通市值、财报、
 * 行业分类、行业月度、交易日历、回测记录…），每份的更新节奏还不一样
 * （行情 5 分钟、财报 45 天）。没有一处能一眼看完，就只能等页面出怪事时去翻日志。
 * 这里把「有哪些、多大、多旧、该不该重抓」摆成一张表。
 *
 * 你需要知道的：
 * 1. **文件不存在 ≠ 过期**。没跑过抓取脚本的新文件显示「没抓过」，不显示「0 天前」。
 *    这两件事的原因不同，混成一句「数据缺失」会让人查错方向。
 * 2. TTL 从 `fetch-policy.ts` 查（单一来源）。这里不重写一遍数字。
 * 3. 纯函数：`freshnessOf(facts, now)` 只吃事实（{path, size, mtime}），不碰 fs。
 *    事实收集在最外层（settings.functions.ts），测试拿构造的事实直接测判据。
 */

import { ttlOf } from "./fetch-policy.ts";

/** 一份文件的原始事实。mtime 为 null = 没这个文件。 */
export type FileFact = {
  path: string;
  /** 给人看的名字 */
  label: string;
  /** 这个文件多久算新鲜（缓存键）；null = 不看新鲜度（记账心跳那种） */
  ttlKey: Parameters<typeof ttlOf>[0] | null;
  /** 怎么补（命令）。文件没抓过时显示这个 */
  refresh: string;
  /** 是否必须有（false = 有就赚，没有也能用） */
  required: boolean;
};

export type Freshness = {
  label: string;
  sizeKb: number | null;
  /** 文件最后修改时间（ms）；null = 没这个文件 */
  mtime: number | null;
  /** 距离过期还有多久（ms）；null = 没文件或不看新鲜度 */
  ageMs: number | null;
  state: "ok" | "stale" | "missing" | "na";
  /** 人话说明。页面直接显示它，不要自己再编一句 */
  note: string;
  refresh: string;
  required: boolean;
};

/** 本机要盯着的文件清单。顺序就是页面显示顺序（按重要程度排）。 */
export const DATA_FILES: FileFact[] = [
  {
    path: "data/universe-cache.json",
    label: "行情快照（全市场）",
    ttlKey: "universe",
    refresh: "服务自己维护（每 60 秒拉一次）",
    required: true,
  },
  {
    path: "data/recorder.json",
    label: "记账心跳",
    ttlKey: null,
    refresh: "服务自己维护（记账进程每分钟写）",
    required: true,
  },
  {
    path: "data/backtest/cap.json",
    label: "流通市值快照",
    ttlKey: "cap",
    refresh: "node scripts/build-floatcap.mjs（不联网，读本地行情缓存）",
    required: true,
  },
  {
    path: "data/backtest/fundamentals.json",
    label: "财报基本面库",
    ttlKey: "fundamentals",
    refresh: "python3 scripts/fetch-fundamentals.py",
    required: false,
  },
  {
    path: "data/backtest/industry.json",
    label: "行业分类（东财三级）",
    ttlKey: "industry",
    refresh: "node --experimental-strip-types --import ./scripts/alias.mjs scripts/fetch-industry.mjs",
    required: false,
  },
  {
    path: "data/backtest/industry-monthly.json",
    label: "行业月度温度计",
    ttlKey: "industryMonthly",
    refresh: "node --experimental-strip-types --import ./scripts/alias.mjs scripts/fetch-industry-monthly.mjs",
    required: false,
  },
  {
    path: "data/backtest/calendar.json",
    label: "交易日历",
    ttlKey: null,
    refresh: "python3 scripts/fetch-calendar.py",
    required: false,
  },
  {
    path: "data/backtest/runs.jsonl",
    label: "回测运行记录",
    ttlKey: null,
    refresh: "node --experimental-strip-types --import ./scripts/alias.mjs scripts/backtest.ts",
    required: false,
  },
  {
    path: "data/notes.json",
    label: "笔记",
    ttlKey: null,
    refresh: "在笔记页写一条就有了",
    required: false,
  },
];

export type Facts = Record<string, { size: number; mtime: number } | null>;

/** 判一份文件的新鲜度。事实表按 path 索引，缺的当「没这个文件」。 */
export function freshnessOf(fact: FileFact, facts: Facts, now = Date.now()): Freshness {
  const hit = facts[fact.path] ?? null;
  const base = { label: fact.label, refresh: fact.refresh, required: fact.required };
  if (!hit) {
    return {
      ...base,
      sizeKb: null,
      mtime: null,
      ageMs: null,
      state: "missing",
      note: fact.required ? "没这个文件——页面有些地方会开不了" : "没抓过（不影响其它页面）",
    };
  }
  const ageMs = Math.max(0, now - hit.mtime);
  const sizeKb = Math.round(hit.size / 1024);
  if (fact.ttlKey == null) {
    return { ...base, sizeKb, mtime: hit.mtime, ageMs, state: "na", note: `${humanAge(ageMs)}前更新` };
  }
  const ttl = ttlOf(fact.ttlKey);
  const state: Freshness["state"] = ageMs < ttl ? "ok" : "stale";
  return {
    ...base,
    sizeKb,
    mtime: hit.mtime,
    ageMs,
    state,
    note: state === "ok" ? `${humanAge(ageMs)}前更新，还新鲜` : `${humanAge(ageMs)}前更新，已过新鲜期（${humanAge(ttl)}）`,
  };
}

/** 全清单判一遍。 */
export function allFreshness(facts: Facts, now = Date.now()): Freshness[] {
  return DATA_FILES.map((f) => freshnessOf(f, facts, now));
}

/** 哪些必须有的东西没有。这些是真问题，别和「过期」混为一谈。 */
export function missingRequired(rows: readonly Freshness[]): Freshness[] {
  return rows.filter((r) => r.required && r.state === "missing");
}

function humanAge(ms: number): string {
  const min = ms / 60_000;
  if (min < 1) return "不到 1 分钟";
  if (min < 60) return `${Math.floor(min)} 分钟`;
  const hour = min / 60;
  if (hour < 24) return `${Math.floor(hour)} 小时`;
  const day = hour / 24;
  if (day < 30) return `${Math.floor(day)} 天`;
  return `${Math.floor(day / 30)} 个月`;
}
