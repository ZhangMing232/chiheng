#!/usr/bin/env python3
"""
赤轨 PE/PB 历史序列抓取（baostock，零鉴权）。

为什么加它：2026-10-12 做「个股研判」页时发现，赤轨给得出 PE 的**绝对值**，
给不出「这个 PE 在它自己历史上排第几」——缺历史序列。同一句「19 倍」，
在历史 90 分位和历史 10 分位完全是两回事。
Vibe-Research 的 `fetch_pe_history.py` 用的也是 baostock 这一个源（零鉴权、
支持 PE_TTM/PB/PS/PCF + 换手 + 停牌 + ST），这条路是被验证过的。

用法（必须用装了 baostock 的那个隔离环境，见 docs 里的说明）:
    scripts/fetch-pe-history.py --code 600519 --years 5
    scripts/fetch-pe-history.py --code 300308 --years 3 --out data/fundamentals

产出 JSON 字段见 write_out()，赤轨侧由 src/lib/market/pe-history.ts 读。

已知的坑（都在这个版本的实测里遇到或移植自 Vibe 的注记）：
1. baostock **不支持北交所**（bj 开头），索要即报错，不是返回空。
2. `tradestatus` 是字符串：1 = 正常交易，0 = 停牌。算历史分位必须剔除停牌日，
   否则停牌那天的估值（沿用停牌前）会被重复计入，把分位算歪。
3. SDK 翻页**失败时不抛异常**，`rs.next()` 只返回 False —
   单页上限 2000 行，所以 5 年日线（约 1220 行）安全，但更长区间要留意
   （移植自 Vibe `sources/baostock_src.py` 的 bs_paging_error 注记）。
4. 数据**T+1 才更新**：当天收盘后要等次日才拉得到当天。
5. SDK 登录是全进程共享的，本脚本用完立即 logout。
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date, timedelta
from pathlib import Path

FIELDS = "date,code,close,peTTM,pbMRQ,psTTM,pcfNcfTTM,turn,tradestatus,isST"


def die(msg: str) -> "None":
    print(f"[fetch-pe-history] {msg}", file=sys.stderr)
    sys.exit(1)


def bs_code(code: str) -> str:
    """六位代码 -> baostock 的 sh.600519 / sz.000001 形式。北交所明确拒绝。"""
    digits = "".join(ch for ch in code if ch.isdigit())
    if len(digits) != 6:
        die(f"代码要是六位数字，收到的是 {code!r}")
    if digits[0] in "48" and digits.startswith(("4", "8")):
        die(f"{digits} 是北交所标的，baostock 不支持这一档（它只有沪深）")
    if digits[0] == "6":
        return f"sh.{digits}"
    if digits[0] in "03":
        return f"sz.{digits}"
    die(f"认不出 {digits} 属于哪个交易所")


def main() -> None:
    ap = argparse.ArgumentParser(description="拉 PE/PB 历史序列（baostock）")
    ap.add_argument("--code", required=True, help="六位代码，例如 600519")
    ap.add_argument("--years", type=int, default=5, help="回看几年，默认 5")
    ap.add_argument("--out", default="data/fundamentals", help="输出目录")
    args = ap.parse_args()

    try:
        import baostock as bs
    except ModuleNotFoundError:
        die("没有 baostock。装法见 scripts/README 或 docs 里的隔离环境命令")

    symbol = bs_code(args.code)
    end = date.today()
    start = end - timedelta(days=365 * args.years + 10)

    login = bs.login()
    if login.error_code != "0":
        die(f"登录失败：{login.error_code} {login.error_msg}")
    try:
        rs = bs.query_history_k_data_plus(
            symbol, FIELDS,
            start_date=start.isoformat(), end_date=end.isoformat(),
            frequency="d", adjustflag="3",  # 3 = 不复权，和 close 同口径
        )
        if rs.error_code != "0":
            die(f"查询失败：{rs.error_code} {rs.error_msg}")
        rows = []
        while rs.next():
            rows.append(dict(zip(rs.fields, rs.get_row_data())))
    finally:
        bs.logout()

    if not rows:
        die(f"{symbol} 一条都没拉到，可能代码有误或这只票刚上市")

    # 停牌日剔除：那天的估值是沿用停牌前的，重复计入会把分位算歪（坑 2）
    traded = [r for r in rows if r.get("tradestatus") == "1"]
    write_out(args.out, args.code, symbol, rows, traded, start, end)


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def write_out(out_dir: str, code: str, symbol: str, rows, traded, start, end) -> None:
    """落盘。列故意保持原始字段名（peTTM / pbMRQ），换算和统计交给赤轨侧做。

    为什么不在这里算分位：Vibe 的分工是对的——**取数层零派生计算**，
    分位由 calc 层对着 raw 算。这样就知道任一个数字是怎么从哪一列来的。
    """
    series = [
        {
            "date": r["date"],
            "close": to_float(r["close"]),
            "peTTM": to_float(r["peTTM"]),
            "pbMRQ": to_float(r["pbMRQ"]),
            "psTTM": to_float(r["psTTM"]),
            "turn": to_float(r["turn"]),
            "isST": r["isST"] == "1",
        }
        for r in traded
    ]
    payload = {
        "code": code,
        "symbol": symbol,
        "source": "baostock",
        "adjust": "none",
        "fetchedAt": date.today().isoformat(),
        "window": {"from": start.isoformat(), "to": end.isoformat()},
        "counts": {"raw": len(rows), "traded": len(traded), "halted": len(rows) - len(traded)},
        "series": series,
    }
    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"pe-{code}.json"
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[fetch-pe-history] {target} 已写入：{len(traded)} 个交易日（原始 {len(rows)} 行，剔除停牌 {len(rows) - len(traded)} 天）")
    if series:
        print(f"  最新 {series[-1]['date']}: PE_TTM {series[-1]['peTTM']}, PB {series[-1]['pbMRQ']}")


if __name__ == "__main__":
    main()
