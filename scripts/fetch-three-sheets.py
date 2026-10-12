#!/usr/bin/env python3
"""
赤轨三表 + 杜邦抓取（baostock，零鉴权）。

为什么走 baostock 不走 akshare：
akshare 依赖 py_mini_racer，而它的 macOS wheel 只有 x86_64（Intel），本机是 arm64，
真装是死结（详见 design/GAP-REPORT.md）。baostock 是纯 wheel、零鉴权、实测可用，
且它给的三表字段比东财业绩报表**更全**——能补上两个东财给不了的字段：
  liabilityToAsset（资产负债率，东财 debt 恒 null）
  CFOToNP（经营现金流/净利润，财报拆解「利润质量」检查的原料）
外加杜邦全套（dupontROE / 周转 / 权益乘数 / 净利率）。

PIT 纪律（和 fundamentals.json 一致，命脉）：
  只收 pubDate（公告日期）非空的行。没有披露日期的记录宁可丢，不能用报告期猜；
  按报告期对齐 = 前视。

用法：
  python3 scripts/fetch-three-sheets.py sh600519 sz000001   # 抓指定几只，最近 8 季
  python3 scripts/fetch-three-sheets.py --all                # 全市场（慢，baostock 有限速）

需要 baostock：pip install baostock（纯 wheel，无 C 依赖，任何 python 都能装）。
用隔离环境：/Users/zhangweimin/.workbuddy/binaries/python/envs/default/bin/python
"""

import json
import sys
import time
from datetime import date

import baostock as bs

OUT = "data/backtest/financials.json"
QUARTERS = 8  # 抓最近 8 个报告期


def quarters_back(n):
    """最近 n 个报告期，返回 [(year, quarter), ...]，最新的在前。"""
    out = []
    y, m = date.today().year, date.today().month
    q = (m - 1) // 3 + 1
    for _ in range(n):
        out.append((y, q))
        q -= 1
        if q == 0:
            q = 4
            y -= 1
    return out


def to_float(v):
    try:
        return float(v) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def bs_code(code):
    """baostock 要 sh.600519 这种带点的格式，外部传的是 sh600519。"""
    return f"{code[:2]}.{code[2:]}" if len(code) == 8 and code[:2] in ("sh", "sz") else code


def fetch(code, periods):
    """抓一只票的三表+杜邦，合并成按报告期对齐的行。只留 pubDate 非空的行（PIT）。"""
    c = bs_code(code)
    merged = {}
    for year, quarter in periods:
        for kind, fn in (
            ("profit", bs.query_profit_data),
            ("dupont", bs.query_dupont_data),
            ("balance", bs.query_balance_data),
            ("cashflow", bs.query_cash_flow_data),
        ):
            rs = fn(code=c, year=year, quarter=quarter)
            while rs.next():
                row = rs.get_row_data()
                d = dict(zip(rs.fields, row))
                if not d.get("pubDate"):
                    continue  # PIT：没公告日期的一律不收
                key = d["statDate"]
                rec = merged.setdefault(key, {"pubDate": d["pubDate"], "statDate": key})
                if kind == "profit":
                    rec.update(
                        roe=to_float(d.get("roeAvg")),
                        npMargin=to_float(d.get("npMargin")),
                        gpMargin=to_float(d.get("gpMargin")),
                        netProfit=to_float(d.get("netProfit")),
                        epsTTM=to_float(d.get("epsTTM")),
                        revenue=to_float(d.get("MBRevenue")),
                    )
                elif kind == "balance":
                    rec.update(
                        debt=to_float(d.get("liabilityToAsset")),
                        currentRatio=to_float(d.get("currentRatio")),
                        quickRatio=to_float(d.get("quickRatio")),
                    )
                elif kind == "cashflow":
                    rec.update(cfoToNp=to_float(d.get("CFOToNP")), cfoToOr=to_float(d.get("CFOToOR")))
                elif kind == "dupont":
                    rec.update(
                        dupontROE=to_float(d.get("dupontROE")),
                        assetTurn=to_float(d.get("dupontAssetTurn")),
                        assetToEquity=to_float(d.get("dupontAssetStoEquity")),
                        nitogr=to_float(d.get("dupontNitogr")),
                    )
    rows = sorted(merged.values(), key=lambda r: r["pubDate"])
    return rows


def main():
    args = [a for a in sys.argv[1:] if a != "--all"]
    want_all = "--all" in sys.argv
    if not args and not want_all:
        print("用法：python3 scripts/fetch-three-sheets.py sh600519 [sz000001 ...]  或  --all")
        sys.exit(1)

    codes = args
    if want_all:
        # 全市场代码从已有 fundamentals.json 的 byCode 取（那批是东财全市场业绩报表）
        with open("data/backtest/fundamentals.json", encoding="utf-8") as f:
            codes = list(json.load(f).get("byCode", {}).keys())

    bs.login()
    periods = quarters_back(QUARTERS)
    by_code = {}
    try:
        for i, code in enumerate(codes, 1):
            rows = fetch(code, periods)
            if rows:
                by_code[code] = rows
            if i % 50 == 0:
                print(f"  {i}/{len(codes)} 只 · 已收 {len(by_code)} 只有数据", flush=True)
                time.sleep(0.5)  # baostock 免费接口限速，礼貌一点
    finally:
        bs.logout()

    with open(OUT, "w", encoding="utf-8") as f:
        json.dump({"fetchedAt": date.today().isoformat(), "byCode": by_code}, f, ensure_ascii=False)
    print(f"完成：{len(by_code)} 只票 → {OUT}")


if __name__ == "__main__":
    main()
