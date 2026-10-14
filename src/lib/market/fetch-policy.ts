/**
 * 这个文件是干什么的：
 * **取数纪律的单一来源**——限速间隔与缓存有效期只在这一张表里，脚本和运行时都来这儿查。
 *
 * 为什么要有它（对标 Vibe-Research 的 data-access SKILL §6「降级原则」）：
 * 这两个数过去写在各自的脚本里，结果同一个源有两个值——`build-flow.mjs` 写
 * 1200ms、`fetch-industry.mjs` 写 1300ms，都是东财，都是我写的，差 100ms 纯属
 * 手滑。更麻烦的是**改的时候只改一处**：哪天东财收紧风控，得把所有脚本翻一遍。
 * 搬进一张表，改一处全部生效，而且这张表能进手册、能进审计。
 *
 * 你需要知道的：
 * 1. **数字来自实测，不是保守估计**。每条都写了谁在什么时候测出这个数够用；
 *    改之前先看那条理由，别凭手感调。
 * 2. **限速是「同一时刻只有一个请求在途」的串行间隔**，不是并发数。东财会封 IP，
 *    并发跑过一次就被挡，所以这里只给间隔不给并发额度——**别拿它去开并发**。
 * 3. TTL 是「这份数据最多能当新的用多久」，过期就该重抓，**不许拿旧值冒充新值**。
 *    不同数据的过期节奏差几个数量级（行情 5 分钟、财报 45 天），别统一成一个数。
 * 4. 纯数据 + 纯函数，零 I/O。会被 60 秒热路径引用，import 不能有副作用。
 */

import type { SourceId } from "./registry.ts";

/** 一个源的限速约定。 */
export type RateLimit = {
  source: SourceId;
  /** 两次请求之间至少隔多久（毫秒）。串行，不是并发额度。 */
  minGapMs: number;
  /** 这个数是怎么来的。改之前先读它。 */
  why: string;
};

/**
 * 各源限速。
 * 没有登记的源 = 没有已知风控，按需请求（但也别开并发去压人家）。
 */
export const RATE_LIMITS: Partial<Record<SourceId, RateLimit>> = {
  tdx: {
    source: "tdx",
    minGapMs: 1000,
    // 一天只该拉一次（盘后包按日发布），正常用法压根碰不到限速。登记它是为了
    // 「补历史」那个场景——`--back N` 会连着拉 N 天，每包 2.7MB，不限速会把
    // 官网当下载器用。1s 是保守值，没有实测依据（官网没有风控记录），
    // 真被封了再收紧。
    why: "无实测风控记录；按「官方源、一天一次」的保守值登记，防的是补历史时的连续拉取",
  },
  eastmoney: {
    source: "eastmoney",
    minGapMs: 1300,
    // 2026-10 实测：串行 1.2s 间隔跑 300 只票的资金流、496 个板块的分类与日线都
    // 没被挡；早先开过并发，立刻 403。1.3s 留一点余量给网络抖动。
    why: "2026-10 实测：串行 1.2s 跑 300 只资金流 / 496 个板块全程无 403；开并发立刻被封",
  },
};

/** 查一个源的限速。没登记的源返回 0（= 不额外等待）。 */
export function rateLimitOf(source: SourceId): RateLimit {
  return RATE_LIMITS[source] ?? { source, minGapMs: 0, why: "这个源没有已知风控，按需请求" };
}

/** 缓存数据的键。 */
export type CacheKey = "universe" | "kline" | "industry" | "industryMonthly" | "cap" | "fundamentals" | "consensus" | "klines" | "tdxDaily";

/** 一份缓存的有效期。 */
export type CachePolicy = {
  key: CacheKey;
  /** 多久之后这份数据不能再当新的用（毫秒）。 */
  ttlMs: number;
  /** 为什么是这个时长。和限速同理，改之前先读。 */
  why: string;
};

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const CACHE_TTL: Record<CacheKey, CachePolicy> = {
  universe: {
    key: "universe",
    ttlMs: 5 * MIN,
    why: "全市场快照，盘中 5 分钟够新；再短就是每分钟去压腾讯接口（WAF 会挡）",
  },
  kline: {
    key: "kline",
    ttlMs: 5 * MIN,
    why: "日线一天才变一次，5 分钟是为了盘中能看到当天这根在长，不是为了省请求",
  },
  klines: {
    key: "klines",
    ttlMs: 12 * HOUR,
    why: "fetch-kline.py 抓的离线日线（前复权），一天抓一次就够；研判页读它做技术指标",
  },
  tdxDaily: {
    key: "tdxDaily",
    ttlMs: 26 * HOUR,
    // 一天一个包，收盘后数小时才发布。26 小时 = 给一夜的余量，第二天拉到新的
    // 之前不算过期；真过期了就是脚本没跑，页面该说「该重抓」而不是显示旧截面。
    why: "盘后包按日发布（当天收盘后数小时），26 小时覆盖一夜余量",
  },
  industry: {
    key: "industry",
    ttlMs: 6 * HOUR,
    why: "行业分类一个月才变一次，6 小时是随手取的宽松值；真要立刻生效就重启服务",
  },
  industryMonthly: {
    key: "industryMonthly",
    ttlMs: 24 * HOUR,
    why: "月度序列按月变，一天一次足够；抓取要 20 分钟，不该频繁重跑",
  },
  cap: {
    key: "cap",
    ttlMs: 7 * DAY,
    why: "流通市值快照，回测算换手率用；7 天是 data-audit 的告警线，超了审计会叫",
  },
  fundamentals: {
    key: "fundamentals",
    ttlMs: 45 * DAY,
    why: "财报按季披露，45 天 ≈ 一个半月覆盖季度内增量；超龄 data-audit 会 warn",
  },
  consensus: {
    key: "consensus",
    ttlMs: 3 * DAY,
    why: "一致预期跟着研报走，几天一批新研报；超过三天再拿旧均值会低估分歧变化",
  },
};

/** 查一份缓存的有效期。 */
export function ttlOf(key: CacheKey): number {
  return CACHE_TTL[key].ttlMs;
}

/**
 * 一份数据是不是还能当新的用。
 * 判据只有一条：**过了 TTL 就是过期**，过期就该重抓，不许拿旧值冒充新值。
 * （对标 Vibe §6：「任何时候都不用旧值冒充新值、不用记忆补数」。）
 */
export function isFresh(fetchedAt: number, key: CacheKey, now = Date.now()): boolean {
  if (!Number.isFinite(fetchedAt) || fetchedAt <= 0) return false;
  return now - fetchedAt < ttlOf(key);
}
