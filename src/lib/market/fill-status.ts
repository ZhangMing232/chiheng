/**
 * 这个文件是干什么的：
 * 前瞻回验「今天到底能不能买到」的四态判定（纯函数，零 IO，直接单测）。
 *
 * 为什么单独抽出来（2026-11-16 修）：
 * 原来只有三态 buyFilled: true / false / null，而 null 被页面固定读成「待开盘」——
 * 结果今天天普股份（605255）停牌、拿不到今日 K 线 bar，buyPrice=null、buyFilled=null，
 * 14:03 的页面上就显示成「待开盘」。这不是数据错，是把两种完全不同的情况塞进了
 * 同一个 null，违反本仓「读不到要给 missing 原因，不许拿空冒充」的纪律。
 *
 * 四态：
 * - `filled`     买到了（有开盘价，非一字板）
 * - `unfillable` 买不到：一字涨停开盘，挂单排不进
 * - `suspended`  停牌：有快照但全天成交量为 0（有量才是真在交易）
 * - `pending`    还没开盘（9:30 前，K 线本就没有今日 bar，正常）
 * - `missing`    数据缺失：已开盘但既没 K 线也没有效快照，要带 why（异常，不是「还没到」）
 */

/** 一个标的当天的原始证据。全为 null 表示连快照都没拿到。 */
export type DayEvidence = {
  /** 今日 K 线 bar（有 o/h/l/c）。停牌日没有这根 bar。 */
  bar: { o: number; c: number; h: number; l: number } | null;
  /** 实时快照的成交量（股）。东财/腾讯快照字段，停牌为 0。 */
  snapshotVolume: number | null;
  /** 现在是否已过开盘时间（9:30）。由调用方传，保持纯函数不讲时钟。 */
  afterOpen: boolean;
  /** 收盘后（15:00 之后）：此时没 bar 就是真缺失，不再是「还没到」。 */
  afterClose: boolean;
  /** 涨停价（按 T 日收盘 + 板块限幅算）。拿不到昨收时为 null。 */
  limitUpPrice: number | null;
};

export type FilledStatus = "filled" | "unfillable" | "suspended" | "pending" | "missing";

export type FillVerdict = {
  status: FilledStatus;
  /** 页面直接显示的一句话（中文，能说清「为什么」）。 */
  note: string | null;
};

/** 页面/接口用的 buyFilled 三值：true 能买、false 不能买、null 还没开盘。保留兼容。 */
export function buyFilledOf(status: FilledStatus): boolean | null {
  if (status === "filled") return true;
  if (status === "unfillable" || status === "suspended") return false;
  return null; // pending / missing 都还不知道
}

/**
 * 判定今天这只票能不能买到。
 * 顺序很重要：先看有没有 bar（有量）→ 再看快照量判停牌 → 再看时间窗判 pending/missing。
 */
export function judgeFill(e: DayEvidence): FillVerdict {
  const { bar, snapshotVolume, afterOpen, afterClose, limitUpPrice } = e;

  // ① 有今日 bar：正常交易，判一字板
  if (bar && bar.o > 0) {
    if (limitUpPrice != null && bar.o >= limitUpPrice - 0.005) {
      if (bar.l >= limitUpPrice - 0.005) {
        return { status: "unfillable", note: `${limitUpPrice.toFixed(2)} 一字涨停，开盘挂单排不进（全天最低就是涨停价）` };
      }
      return { status: "filled", note: `开盘涨停后开板（最低 ${bar.l.toFixed(2)}），成交价低于开盘价` };
    }
    return { status: "filled", note: null };
  }

  // ② 没有 bar 但有快照：成交量 0 = 停牌（这是今天天普股份的情形）
  if (snapshotVolume != null) {
    if (snapshotVolume === 0) {
      return { status: "suspended", note: "今日停牌（全天成交量为 0），买不进也卖不出" };
    }
    // 有成交量却没有日 K bar：接口延迟或数据源异常，不是停牌
    return { status: "missing", note: "快照有成交但拿不到日 K 线（数据源异常，稍后重试）" };
  }

  // ③ 什么都没拿到：按时间窗分「还没到」和「真缺失」
  if (!afterOpen && !afterClose) {
    return { status: "pending", note: null };
  }
  return { status: "missing", note: "已开盘但拿不到行情（K 线和快照都没数据，查数据源）" };
}

/** 状态 → 页面文案（页面直接用，避免各处各写一套）。 */
export const FILL_STATUS_LABEL: Record<FilledStatus, string> = {
  filled: "成交",
  unfillable: "一字板·买不进",
  suspended: "停牌·买不进",
  pending: "待开盘",
  missing: "数据缺失",
};

/** 状态 → 色调档（today/huiyan 的 statusTone 共用）。 */
export function fillStatusTone(status: FilledStatus): "ok" | "no" | "wait" {
  if (status === "filled") return "ok";
  if (status === "unfillable" || status === "suspended" || status === "missing") return "no";
  return "wait";
}
