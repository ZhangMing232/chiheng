#!/usr/bin/env python3
"""
赤轨日线 K 线回填（baostock，零鉴权）—— 替代被限流的腾讯接口。

背景：scripts/refresh-kline.ts 走腾讯 web.ifzq.gtimg.cn，批量抓会被 501/限流，
无法把全市场补到 800 根。baostock 是项目已有的 pe-history 数据源（同样前复权），
不限流，单股一次返回全部历史（~2800 根），适合做全量回填。

产物：直接写回回测引擎读的缓存 data/backtest/kline/<id>.json，格式与
scripts/backtest.ts 的 fetchKline 完全一致（{date,o,c,h,l,v}，v 单位为手）。
baostock 的 volume 字段是「股」，引擎按「手」算成交额，所以 /100。

只补 < KLINE_DAYS 根的票（已经 800 根的是之前腾讯预热好的，不动），
把 baostock 请求量压到最低，避开 baostock 的每日额度上限。

用法：
  python3 scripts/backfill-kline-baostock.py            # 补全部 <800 根的
  python3 scripts/backfill-kline-baostock.py sh600519 sz000001   # 只补这几只
"""
import json
import os
import sys
import time

import baostock as bs

OUT = "data/backtest/kline"
KLINE_DAYS = int(os.environ.get("BT_KLINE_DAYS", "800"))


def bs_code(code: str) -> str:
    # sh600519 -> sh.600519
    return f"{code[:2]}.{code[2:]}" if len(code) == 8 and code[:2] in ("sh", "sz") else code


def fetch_one(code: str) -> list:
    c = bs_code(code)
    rs = bs.query_history_k_data_plus(
        c, "date,open,high,low,close,volume", frequency="d", adjustflag="2"  # 前复权
    )
    rows = []
    while rs.next():
        r = rs.get_row_data()
        if not r[0]:
            continue
        try:
            o, h, l, c, v = float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[5])
        except (TypeError, ValueError):
            continue
        if not (o and h and l and c):
            continue
        rows.append(
            {
                "date": r[0],
                "o": round(o, 4),
                "c": round(c, 4),
                "h": round(h, 4),
                "l": round(l, 4),
                "v": int(round(v / 100)),  # 股 -> 手
            }
        )
    return rows


def main():
    if len(sys.argv) > 1:
        codes = sys.argv[1:]
    else:
        codes = [f[:-5] for f in os.listdir(OUT) if f.endswith(".json")]

    # 只补不够长的：已有的 800 根不动
    def need(code: str) -> bool:
        p = os.path.join(OUT, f"{code}.json")
        if not os.path.exists(p):
            return True
        try:
            return len(json.load(open(p))) < KLINE_DAYS
        except Exception:
            return True

    todo = [c for c in codes if need(c)]
    print(f"待补 {len(todo)}/{len(codes)} 只（目标 ≥{KLINE_DAYS} 根）", flush=True)

    bs.login()
    done = 0
    try:
        for i, code in enumerate(todo, 1):
            rows = fetch_one(code)
            if rows:
                json.dump(rows, open(os.path.join(OUT, f"{code}.json"), "w"))
            if i % 200 == 0:
                print(f"  {i}/{len(todo)} 只", flush=True)
                time.sleep(0.5)  # 礼貌限速
            done = i
    finally:
        bs.logout()
    print(f"完成：回填 {done} 只 → {OUT}/")


if __name__ == "__main__":
    main()
