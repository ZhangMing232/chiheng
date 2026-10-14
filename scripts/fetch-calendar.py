#!/usr/bin/env python3
"""
这个文件是干什么的：
拉交易日历（baostock query_trade_dates），写成 data/backtest/calendar.json，
给日历页算「持仓哪天到期」用。

为什么要它：账本里的持仓记的是「买入日 + 持有 N 个交易日」，要算它在哪一天
到期，必须知道哪些天是交易日——**未来**的交易日。K 线只有过去的日期，推不出来。

已知的坑：
- baostock 的 is_trading_day 是字符串 '1'/'0'，不是布尔。
- 它能给到未来（实测拉 2026-12-31 有数据），但**法定节假日以国务院通知为准**，
  baostock 的远期日期是推算值，等通知出来会有偏差——页面要写清这一点。

跑法：python3 scripts/fetch-calendar.py
"""

import json
import os
from datetime import datetime, timedelta

import baostock as bs

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(HERE, "data", "backtest", "calendar.json")

# 往前留一个月（算已持仓的到期日要用），往后拉满一年
DAYS_BACK = 40
DAYS_AHEAD = 400
# 分段长度：一次要太长会被截断（实测 440 天只回 119 天）
SEGMENT = 90


def main() -> None:
    today = datetime.now()
    start = (today - timedelta(days=DAYS_BACK)).strftime("%Y-%m-%d")
    end = (today + timedelta(days=DAYS_AHEAD)).strftime("%Y-%m-%d")

    lg = bs.login()
    if lg.error_code != "0":
        raise SystemExit(f"baostock 登录失败：{lg.error_msg}")

    # 一次别要太长的区间：**baostock 会把返回条数截断**（实测要 440 天只回 119 天，
    # 和东财那个 pz 限制一个德性）。按 SEGMENT 天一段分段拉再合并。
    trading: list[str] = []
    all_days: list[str] = []
    cursor = today - timedelta(days=DAYS_BACK)
    stop = today + timedelta(days=DAYS_AHEAD)
    while cursor <= stop:
        seg_end = min(cursor + timedelta(days=SEGMENT), stop)
        rs = bs.query_trade_dates(
            start_date=cursor.strftime("%Y-%m-%d"), end_date=seg_end.strftime("%Y-%m-%d")
        )
        if rs.error_code != "0":
            bs.logout()
            raise SystemExit(f"拉交易日历失败（{cursor.strftime('%Y-%m-%d')} 起）：{rs.error_msg}")
        while rs.error_code == "0" and rs.next():
            row = rs.get_row_data()
            all_days.append(row[0])
            # is_trading_day 是字符串 '1'/'0'，不是布尔
            if row[1] == "1":
                trading.append(row[0])
        cursor = seg_end + timedelta(days=1)

    bs.logout()
    all_days = sorted(set(all_days))
    trading = sorted(set(trading))

    # range 记**实际拿到的**范围，不是请求的范围：baostock 的交易日历只给到当年
    # 12-31（实测要 2027-11 也只回到 2026-12-31）。跨年的到期日算不出来时页面要
    # 写缺口，不能拿 12-31 冒充。
    payload = {
        "fetchedAt": today.strftime("%Y-%m-%d"),
        "range": [all_days[0], all_days[-1]] if all_days else [start, end],
        "requested": [start, end],
        "tradingDays": trading,
        "days": all_days,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    tmp = f"{OUT}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False)
    os.replace(tmp, OUT)
    print(f"写好了 {OUT}")
    print(f"  实际拿到 {payload['range'][0]} ~ {payload['range'][1]}：共 {len(all_days)} 天，交易日 {len(trading)} 天")
    if payload["range"][1] < end:
        print(f"  ⚠️ 要到了 {end}，但只给到 {payload['range'][1]}——baostock 的交易日历只到当年年底，跨年的日期拿不到")


if __name__ == "__main__":
    main()
