#!/usr/bin/env python3
"""
赤轨日线 K 线抓取（baostock，零鉴权）。

为什么单独一个脚本（不复用 fetch-pe-history.py）：
那个脚本抓的是**估值序列**（close/peTTM/pbMRQ/turn，不复权），字段和这里不同。
技术指标要的是 **OHLC 四价 + 成交量**，而且必须**前复权**——除权跳空会把
MACD/KDJ/BOLL 全扭曲（一次 10 送 10，价格腰斩，指标全线假信号）。

复权口径：baostock adjustflag "2" = 前复权（以最新价为基准往前调）。
  注意与 MEMORY 记的「结算用不复权、回测用 qfq」区分：这里是技术指标，
  它要的是「价格序列连续」，前复权才对。

用法：
  python3 scripts/fetch-kline.py sh600519           # 单只，最近 120 根
  python3 scripts/fetch-kline.py sh600519 sz000001  # 多只
  python3 scripts/fetch-kline.py --all              # 全市场（慢，限速）

产物：data/backtest/klines/<code>.json
  {"code": ..., "fetchedAt": ..., "adjust": "qfq", "rows": [{"date","open","high","low","close","volume"}]}

需要 baostock（纯 wheel，任何 python 都能装）：
  /Users/zhangweimin/.workbuddy/binaries/python/envs/default/bin/python
"""

import json
import os
import sys
import time

import baostock as bs

OUT_DIR = "data/backtest/klines"
N_BARS = 120  # 抓最近 120 根（指标要 ≥30 根，留足余量）


def bs_code(code: str) -> str:
    return f"{code[:2]}.{code[2:]}" if len(code) == 8 and code[:2] in ("sh", "sz") else code


def fetch_one(code: str) -> list:
    c = bs_code(code)
    rs = bs.query_history_k_data_plus(
        c,
        "date,open,high,low,close,volume",
        frequency="d",
        adjustflag="2",  # 前复权
    )
    rows = []
    while rs.next():
        row = rs.get_row_data()
        if not row[0]:
            continue  # 停牌日 baostock 也给行，但可能空——只收有日期的
        rows.append(
            {
                "date": row[0],
                "open": float(row[1]) if row[1] else None,
                "high": float(row[2]) if row[2] else None,
                "low": float(row[3]) if row[3] else None,
                "close": float(row[4]) if row[4] else None,
                "volume": float(row[5]) if row[5] else None,
            }
        )
    return rows[-N_BARS:] if len(rows) > N_BARS else rows


def main():
    args = [a for a in sys.argv[1:] if a != "--all"]
    want_all = "--all" in sys.argv
    if not args and not want_all:
        print("用法：python3 scripts/fetch-kline.py sh600519 [sz000001 ...]  或  --all")
        sys.exit(1)

    codes = args
    if want_all:
        with open("data/backtest/fundamentals.json", encoding="utf-8") as f:
            codes = list(json.load(f).get("byCode", {}).keys())

    os.makedirs(OUT_DIR, exist_ok=True)
    bs.login()
    try:
        for i, code in enumerate(codes, 1):
            rows = fetch_one(code)
            out = {"code": code, "fetchedAt": time.strftime("%Y-%m-%d"), "adjust": "qfq", "rows": rows}
            with open(os.path.join(OUT_DIR, f"{code}.json"), "w", encoding="utf-8") as f:
                json.dump(out, f, ensure_ascii=False)
            if i % 100 == 0:
                print(f"  {i}/{len(codes)} 只", flush=True)
                time.sleep(0.5)  # 免费接口限速，礼貌一点
    finally:
        bs.logout()
    print(f"完成：{len(codes)} 只 → {OUT_DIR}/")


if __name__ == "__main__":
    main()
