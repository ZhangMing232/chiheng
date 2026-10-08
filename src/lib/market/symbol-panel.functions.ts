/**
 * 这个文件是干什么的：
 * 个股抽屉的数据聚合层。抽屉要同时显示「行情 / 所属策略 / 相关消息 / 资金流」，
 * 这四路分别落在四个不同的模块里，各自有各自的缓存和失败方式。
 *
 * 你需要知道的：
 * 1. **每一路独立降级，绝不整块失败**。这是照抄 `getServerJournal` 的纪律（它的
 *    `why` 必带回去，注释里写了原因：早期 catch 里直接返空账本，页面回退到浏览器
 *    本地空账，曾导致「账本全是 0」的假象）。在这里，行情拿到了但账本没登录，
 *    应该显示行情 + 提示「登录后能看到这笔持仓」，而不是整个抽屉空掉。
 * 2. **拿不到就是 null，不是 0**。主力净流入拿不到是 null（不知道），
 *    0 会被读成「一分钱没进」（知道了，是 0）。这个区别在钱的场景下是要命的。
 * 3. 行情走 `loadUniverse(false)`——复用它自己的落盘缓存，成本≈0。抽屉刷新频率很低，
 *    不值得为它单独拉一只票的行情。
 */

import { createServerFn } from "@tanstack/react-start";
import { loadUniverse } from "@/lib/market/quotes.functions";
import { loadStockArticles, type StockArticle } from "@/lib/market/news";
import { loadFlow } from "@/lib/market/flow";
import { readUserBook } from "@/lib/market/book-file";
import { readRules } from "@/lib/market/rules-file";
import { shanghaiDate } from "@/lib/market/session";
import { tradeState } from "@/lib/market/positions";
import { STYLES } from "@/lib/market/strategies";
import { netReturn } from "@/lib/market/journal-book";
import { DEFAULT_RULES } from "@/lib/market/rules";
import type { Quote } from "@/lib/market/types";
import type { PaperDay } from "@/lib/paper";

export type SymbolBook = {
  /** 持有它的那一笔（同一只票多笔时取最近一笔建仓的） */
  trade: {
    day: string;
    entry: number;
    stop: number | null;
    target: number | null;
    exit: number | null;
    exitDate: string | null;
    state: string;
    ret: number | null;
  } | null;
  style: string | null;
  styleName: string;
  /** 同一只票在别的策略里也记过——换过策略的票要看出来 */
  alsoIn: string[];
};

export type SymbolPanelData = {
  quote: Quote | null;
  book: SymbolBook | null;
  articles: StockArticle[];
  /** 这只票的主力净流入，万元。null = 拿不到（当前数据源没有这个字段） */
  inflow: number | null;
  /** 在个股资金榜里的名次，null = 今天没进榜 */
  inflowRank: number | null;
  /** 全市场主力净流入（沪深加总），万元，用来对照这只票占比多少 */
  marketInflow: number | null;
  /** 行情快照的时间，界面上标「数据多久前」 */
  asOf: number | null;
  /** 哪一路降级了。要显示出来，不能让人对着空白猜。 */
  why: string | null;
};

/** 账本里这只票的全部成交，按日倒序。 */
function tradesOf(days: PaperDay[], id: string) {
  const hits: { day: string; signalTime: string; trade: PaperDay["trades"][number] }[] = [];
  for (const day of days) {
    for (const trade of day.trades) {
      if (trade.id === id) hits.push({ day: day.date, signalTime: day.signalTime ?? "", trade });
    }
  }
  return hits.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** 给页面用的个股抽屉数据。四路并行，任一路缺失不影响其余。 */
export const getSymbolPanel = createServerFn({ method: "GET" })
  .validator((data: unknown) => {
    if (typeof data !== "object" || data === null || !("id" in data)) throw new Error("无效的股票代码");
    const id = (data as { id?: unknown }).id;
    if (typeof id !== "string") throw new Error("无效的股票代码");
    if (!/^(sh|sz|bj)\d{6}$/.test(id)) throw new Error("无效的股票代码");
    return { id };
  })
  .handler(async ({ data }): Promise<SymbolPanelData> => {
    const id = data.id;
    const why: string[] = [];

    const [universe, flow, rules] = await Promise.all([
      loadUniverse(false).catch(() => null),
      loadFlow().catch(() => null),
      readRules().catch(() => null),
    ]);
    const quote = universe?.quotes.find((q) => q.id === id) ?? null;
    if (!quote) why.push("这只票不在当前行情快照里，价格可能不是最新的");
    if (!rules) why.push("读不到风控规则，状态只能算到「持有」这一档");

    // 账本要登录态，失败只影响这一路
    let book: SymbolBook | null = null;
    try {
      const { requireUserId } = await import("@/lib/auth/verify.server");
      const userId = await requireUserId();
      const { days } = await readUserBook<PaperDay>(userId);
      const hits = tradesOf(days, id);
      if (hits.length > 0) {
        const { day, trade } = hits[0];
        const live = universe?.quotes.find((q) => q.id === id) ?? null;
        const today = shanghaiDate();
        book = {
          trade: {
            day,
            entry: trade.entry,
            stop: trade.stop ?? null,
            target: trade.target ?? null,
            exit: trade.exit ?? null,
            exitDate: trade.exitDate ?? null,
            // state 走持仓页那一份 tradeState —— 两处各写一份迟早对不上
            state: tradeState(
              { exit: trade.exit ?? null, entry: trade.entry, stop: trade.stop, target: trade.target },
              day,
              live,
              today,
              rules ?? DEFAULT_RULES,
            ),
            ret: trade.exit != null ? netReturn(trade.entry, trade.exit) : live ? netReturn(trade.entry, live.price) : null,
          },
          style: trade.style ?? null,
          styleName: STYLES.find((s) => s.id === trade.style)?.name ?? "未标注策略",
          alsoIn: hits
            .map((h) => h.trade.style)
            .filter((s): s is NonNullable<typeof s> => !!s && s !== trade.style)
            .map((s) => STYLES.find((x) => x.id === s)?.name ?? s),
        };
      }
    } catch {
      // 未登录或账本读不到。这一路留空，界面显示「登录后能看到这笔持仓」
      why.push("登录后能看到这笔持仓");
    }

    const articles = await loadStockArticles(id).catch(() => {
      why.push("这只票的消息暂时取不到");
      return [] as StockArticle[];
    });

    // 资金流：榜里没有就是「今天没进榜」，不是「零流入」。
    // 新浪源根本没有主力资金字段（data-status 里写明它缺 d5/d20/d60 和量比，inflow 同样是 0），
    // 这时要显式说「数据源没有这个字段」，不能显示 0.00 万让人以为一分没进。
    let inflow: number | null = quote && typeof quote.inflow === "number" && quote.inflow !== 0 ? quote.inflow : null;
    let inflowRank: number | null = null;
    if (flow) {
      const all = [...flow.stocksIn, ...flow.stocksOut];
      const at = all.findIndex((row) => row.id === id);
      if (at >= 0) {
        inflowRank = at + 1;
        inflow = all[at].inflow;
      }
    }
    if (inflow == null) {
      why.push(
        universe?.source === "sina"
          ? "当前是新浪源，没有主力资金字段"
          : "这只票今天没进个股资金榜（不等于零流入）",
      );
    }

    return {
      quote,
      book,
      articles,
      inflow,
      inflowRank,
      marketInflow: flow ? flow.market.reduce((sum, part) => sum + part.main, 0) : null,
      asOf: universe?.asOf ?? null,
      why: why.length > 0 ? why.join("；") : null,
    };
  });