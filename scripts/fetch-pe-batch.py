#!/usr/bin/env python3
"""全池历史 PE/PB 日序列批量抓取（baostock）。

为什么要有它：`value`（低估值）是线上唯一在跑的策略，也是唯一从没被回测
验证过的。回测侧缺的是「每只票每个交易日的 PE_TTM / PB / 市值」日序列，
`data/backtest/cap.json` 只是**当前市值快照**——拿今天的快照回填到过去
是前视数据，账会全虚高，所以绝不能那么干。

单只逻辑照 `scripts/fetch-pe-history.py`（同一个源、同样的停牌剔除），
这边只加：全池枚举、多进程、断点续传、失败留档。

用法：
    python3 scripts/fetch-pe-batch.py                 # 默认 4 并发，抓 2 年
    python3 scripts/fetch-pe-batch.py --workers 6 --years 3
    python3 scripts/fetch-pe-batch.py --limit 50      # 只抓前 50 只（冒烟用）
    python3 scripts/fetch-pe-batch.py --force          # 已有文件也重抓

输入股票池：data/backtest/kline/*.json（回测实际用的那批，不含北交所）。
输出：data/backtest/pe-history/pe-<六位代码>.json，一行失败一条到 pe-failures.jsonl。

已知约束（同 fetch-pe-history.py 头注）：
1. baostock 不支持北交所，4/8 开头直接跳过。
2. `tradestatus` 字符串，只留 "1"（正常交易）；停牌日的估值是沿用前值，
   重复计入会把分位算歪。
3. 数据 T+1 更新，今天只能拿到昨天收盘。
4. 每个 worker 独立 login/logout——SDK 登录是进程内全局的，不能跨进程共用。
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
KLINE_DIR = ROOT / "data" / "backtest" / "kline"
OUT_DIR = ROOT / "data" / "backtest" / "pe-history"
FIELDS = "date,code,close,peTTM,pbMRQ,psTTM,pcfNcfTTM,turn,tradestatus,isST"


def code_of(stem: str) -> str | None:
    digits = "".join(ch for ch in stem if ch.isdigit())
    if len(digits) != 6:
        return None
    # 北交所：老代码 4/8 开头，2025 起新股改用 920 段。baostock 全都不支持，
    # 索要即报错或返回空——静默留着会污染全池分母，宁可明确排除。
    if digits[0] in "48" or digits.startswith("920"):
        return None
    return digits


def to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def fetch_once(args) -> tuple[str, str, str]:
    code, years, force = args
    out_dir = OUT_DIR
    target = out_dir / f"pe-{code}.json"
    if target.exists() and not force:
        try:
            cached = json.loads(target.read_text(encoding="utf-8"))
            if cached.get("series"):
                return code, "skip", ""
        except (OSError, ValueError):
            pass  # 坏文件当没抓过，重来

    try:
        import baostock as bs
    except ModuleNotFoundError:
        return code, "fail", "缺 baostock：python3 -m pip install baostock"

    symbol = ("sh." if code[0] == "6" else "sz.") + code
    end = date.today()
    start = end - timedelta(days=365 * years + 10)
    login = bs.login()
    if login.error_code != "0":
        return code, "fail", f"登录失败 {login.error_code} {login.error_msg}"
    try:
        rs = bs.query_history_k_data_plus(
            symbol, FIELDS,
            start_date=start.isoformat(), end_date=end.isoformat(),
            frequency="d", adjustflag="3",  # 不复权，和 close 同口径
        )
        if rs.error_code != "0":
            return code, "fail", f"查询失败 {rs.error_code} {rs.error_msg}"
        rows = []
        while rs.next():
            rows.append(dict(zip(rs.fields, rs.get_row_data())))
    finally:
        bs.logout()

    traded = [r for r in rows if r.get("tradestatus") == "1"]
    if not traded:
        return code, "fail", "一条都没拉到（代码有误 / 刚上市 / 长期停牌）"
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
    target.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    return code, "ok", series[-1]["date"]


def fetch_one(args) -> tuple[str, str, str]:
    """多进程下 baostock 偶发「用户未登录」（登录是进程内全局状态，高频并发会打架）。
    只针对登录类失败重试，别的失败重试也是白费。实测 4 并发不重试漏 8/60，
    加这层后归零。"""
    code = args[0]
    for attempt in range(3):
        got = fetch_once(args)
        _, status, detail = got
        if status == "ok" or status == "skip":
            return got
        if "未登录" not in detail and "登录失败" not in detail and "logout" not in detail:
            return got
        time.sleep(0.4 * (attempt + 1))
    return code, "fail", f"{detail}（登录类失败，重试 3 次仍不行）"


def main() -> None:
    ap = argparse.ArgumentParser()
    # 实测 4 并发会让 baostock 的登录状态在多进程间打架（漏 8/60，重试后仍漏 1/60 且更慢）；
    # 2 并发 15 只 12 秒全成功。默认取稳的那一档。
    ap.add_argument("--workers", type=int, default=2)
    ap.add_argument("--years", type=int, default=2, help="回看几年；回测窗口 250 交易日，2 年够")
    ap.add_argument("--limit", type=int, default=0, help="只抓前 N 只，冒烟用")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args()

    codes = []
    for f in sorted(KLINE_DIR.glob("*.json")):
        c = code_of(f.stem)
        if c:
            codes.append(c)
    if args.limit:
        codes = codes[: args.limit]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print(f"[pe-batch] 股票池 {len(codes)} 只，{args.workers} 并发，{args.years} 年 → {OUT_DIR}", flush=True)

    ok = skip = fail = 0
    failures = []
    t0 = time.time()
    jobs = [(c, args.years, args.force) for c in codes]
    with ProcessPoolExecutor(max_workers=args.workers) as pool:
        futs = {pool.submit(fetch_one, j): j[0] for j in jobs}
        for n, fut in enumerate(as_completed(futs), 1):
            code, status, detail = fut.result()
            if status == "ok":
                ok += 1
            elif status == "skip":
                skip += 1
            else:
                fail += 1
                failures.append({"code": code, "why": detail})
            if n % 100 == 0 or n == len(codes):
                elapsed = time.time() - t0
                print(f"[pe-batch] {n}/{len(codes)}  ok={ok} skip={skip} fail={fail}  {elapsed:.0f}s", flush=True)

    if failures:
        with (OUT_DIR / "pe-failures.jsonl").open("a", encoding="utf-8") as f:
            for row in failures:
                f.write(json.dumps({**row, "at": date.today().isoformat()}, ensure_ascii=False) + "\n")
    print(f"[pe-batch] 完成 ok={ok} skip={skip} fail={fail}，用时 {time.time() - t0:.0f}s", flush=True)
    if failures:
        print(f"[pe-batch] 失败明细前 5 条：{failures[:5]}", flush=True)
    sys.exit(0 if fail == 0 else 1)


if __name__ == "__main__":
    main()
