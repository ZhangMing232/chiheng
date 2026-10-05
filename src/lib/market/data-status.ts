/**
 * 这个文件是干什么的：
 * 判断一份行情快照「有没有问题、问题出在哪」，并把要告诉用户的话组织成固定结构。
 *
 * 你需要知道的：
 * 2026-10-05 下午主源降级，页面只显示「这套策略现在没有符合的股票」，看着像当天
 * 没机会，实际是数据源缺字段。那三小时是靠翻日志定位的。
 *
 * 修法不是加一句话，是把「为什么 / 影响 / 什么时候恢复」做成硬结构：
 * 少写一条，这块提示就退回到"说了等于没说"，而 typecheck 不会报、页面也不会崩。
 * 所以规矩定在这里，并且由 data-status.test.ts 钉住。
 *
 * 纯逻辑放 .ts 而不是 .tsx，是为了能自动测——测试跑在 node --experimental-strip-types 上，
 * 它不转译 JSX，组件文件里的函数 import 不进来。
 */
import { snapshotAge } from "@/lib/market/format";
import type { Universe } from "@/lib/market/types";

const SOURCE_LABEL: Record<string, string> = {
  tencent: "腾讯",
  sina: "新浪财经",
  eastmoney: "东方财富",
};

/** 一条要说清的事。三个问题缺一条就不算说完。 */
export type Notice = {
  /** 徽标上的那两个字，比如「降级」「过期」。 */
  label: string;
  tone: "warn" | "info";
  /** 为什么这样。 */
  why: string;
  /** 这会影响到什么：看的人得知道今天哪几套策略不工作。 */
  impact: string;
  /** 什么时候会自己好；不会自己好的要说清要做什么。 */
  recovery: string;
};

/** 数据源的名字，给「腾讯 · 3 分钟前」用。 */
export function sourceLabel(source: Universe["source"]): string {
  const key = source ?? "";
  return SOURCE_LABEL[key] ?? (key || "未知来源");
}

/**
 * 把一份行情快照翻译成「要说清的事」。没有就返回 null——数据正常时页面不该啰嗦。
 */
export function noticeOf(universe: Universe | null | undefined, now = Date.now()): Notice | null {
  if (!universe || universe.quotes.length === 0) return null;
  if (universe.source === "sina") {
    return {
      label: "降级",
      tone: "warn",
      why: "主源腾讯没拉下来，换到了新浪财经。新浪那份名单没有近 5/20/60 日涨幅，量比也是 0。",
      impact: "放量突破和中期反转今天不会出票——不是选不出票，是这几套硬性要这些字段。低估值和次日补涨照常。",
      recovery: "腾讯源恢复后下一次刷新会自动切回来，不用做任何事。",
    };
  }
  if (universe.stale) {
    return {
      label: "过期",
      tone: "warn",
      why: `拉不到新的行情，用的是 ${snapshotAge(now - universe.asOf)}那份旧数据。`,
      impact: "页面上的现价和涨跌幅都不是当下的价，选股和止损判断都可能偏。",
      recovery: "点下面「重新拉一次」；一直拉不到就等网络或行情源恢复。",
    };
  }
  if (universe.partial) {
    return {
      label: "残缺",
      tone: "warn",
      why: "这次只拉到一部分股票，不是全市场。",
      impact: "排名会偏——排在后面的票可能根本没进来过。",
      recovery: "点下面「重新拉一次」；一直残缺说明行情源在限流，等一会儿。",
    };
  }
  return null;
}

/**
 * 账本拿不到时要说的事。
 *
 * 跟 noticeOf 同一个道理：拿不到就明说，别让页面摆一个全零的账本。
 * 之前 catch 里直接返回空数组，页面回退去显示浏览器本地那份账（本机是空的），
 * 于是「当前持有 0 只」「累计收益 —」，看着像数据丢了——其实服务端账本好好地在那儿。
 * 这个函数把那三句话说清楚，页面挂在顶上的徽标上。
 */
export function accountNotice(personal: boolean, why: string | null | undefined): Notice | null {
  if (personal) return null;
  return {
    label: "空账本",
    tone: "warn",
    why: `服务端账本没读到（${why || "原因不明"}）。这台机器上只登录过一次，本机浏览器里那份是空的。`,
    impact: "下面所有持仓、盈亏、胜率、交易日记录全是 0——那是「没读到」，不是「真的一笔没有」。选股和行情不受影响。",
    recovery: "服务端账本一直在这台电脑上（data/books）。重新登录就能看到；在此之前别照着 0 做判断。",
  };
}
