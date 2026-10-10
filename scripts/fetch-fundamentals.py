#!/usr/bin/env python3
"""
赤轨财报基本面抓取（akshare 东财业绩报表版）。

为什么有这个文件：
tushare 的 fina_indicator 需要 2000 积分，当前账号积分不足（全部接口 40203），
所以先用 akshare 的东财业绩报表接口（stock_yjbb_em，免费、无需 token）抓同样的
字段，落盘成和 tushare 版完全相同的 data/backtest/fundamentals.json ——
src/lib/market/fundamentals.ts 的类型和 pitValue PIT 对齐逻辑两边通用。

字段口径（东财业绩报表，按报告期全市场批量）：
  roe   = 净资产收益率(%)            → f_roe 因子
  dtYoy = 净利润-同比增长(%)         → f_dtyoy 因子
  gm    = 销售毛利率(%)              → f_gm 因子
  debt  = 资产负债率(%)              → 东财这个接口没有，恒为 null；
                                        将来账号积分够了可切回 fetch-fundamentals.ts
                                        （tushare 版）补这个字段

PIT 纪律（和 tushare 版一致，命脉）：
  只收「最新公告日期」非空的行——没有披露日期的记录宁可丢，不能用报告期猜，
  按报告期对齐 = 前视，回测收益全虚高。

用法：
  python3 scripts/fetch-fundamentals.py           # 抓最近 8 个季度
  python3 scripts/fetch-fundamentals.py 12        # 抓最近 12 个季度

需要 akshare：pip install akshare（东财接口实测约 135s/季度、23 页，
偶发 ChunkedEncodingError，脚本自带整季度级重试）。
"""

import json
import sys
import time
from datetime import date
from pathlib import Path

try:
    import akshare as ak
except ImportError:
    sys.exit("缺 akshare：pip install akshare 后再跑")

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "backtest" / "fundamentals.json"

# 季度末日：Q1=0331 / Q2=0630 / Q3=0930 / Q4=1231——和 fundamentals.ts 的
# recentQuarters 同一套口径，写错一天东财就查空。
END = ["0331", "0630", "0930", "1231"]
RETRIES = 4


def recent_quarters(n: int) -> list[str]:
    today = date.today()
    y, q = today.year, (today.month - 1) // 3
    out = []
    for _ in range(n):
        out.append(f"{y}{END[q]}")
        q -= 1
        if q < 0:
            q, y = 3, y - 1
    return out


def to_code(raw: str) -> str:
    """东财 6 位代码 → 赤轨的 sh600519/sz000001/bj920000 格式。"""
    c = str(raw).zfill(6)
    if c.startswith(("60", "68", "11", "13")):
        return "sh" + c
    if c.startswith(("00", "30", "15", "16")):
        return "sz" + c
    return "bj" + c


def num(v):
    """NaN/空 → None（赤轨约定：null = 不知道，绝不拿 0 冒充）。"""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    import math
    return None if math.isnan(f) else round(f, 4)


def fetch_period(period: str) -> dict[str, dict]:
    """抓一个报告期，返回 {赤轨code: {ann, roe, dtYoy, gm, debt}}。"""
    df = ak.stock_yjbb_em(date=period)
    out = {}
    for _, row in df.iterrows():
        ann_raw = row.get("最新公告日期")
        if not ann_raw or str(ann_raw) in ("NaT", "nan", "None"):
            continue  # 没有披露日 = 前视风险，宁可丢
        ann = str(ann_raw).replace("-", "")
        out[to_code(row["股票代码"])] = {
            "ann": ann,
            "roe": num(row.get("净资产收益率")),
            "dtYoy": num(row.get("净利润-同比增长")),
            "gm": num(row.get("销售毛利率")),
            "debt": None,
        }
    return out


def main() -> int:
    n = int(sys.argv[1]) if len(sys.argv) > 1 else 8
    periods = recent_quarters(n)
    if len(sys.argv) > 2:
        # 显式指定报告期（逗号分隔），覆盖默认的「最近 N 季」——一次命令跑不完
        # 8 个季度时（东财接口约 135s/季），可以一季一条命令分批跑。
        periods = [p.strip() for p in sys.argv[2].split(",") if p.strip()]
    # 还没结束的报告期（期末日 > 今天）东财查不到，查了只会空转重试，直接跳过。
    today = date.today().strftime("%Y%m%d")
    periods = [p for p in periods if p <= today]
    if not periods:
        print("没有可抓的报告期（都还没到期末）")
        return 0

    # 增量加载已有结果：断网重跑不用从零再来。
    state = {"fetchedAt": "", "periods": [], "byCode": {}}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text())
            if isinstance(old.get("byCode"), dict):
                state = {"fetchedAt": old.get("fetchedAt", ""), "periods": list(old.get("periods", [])), "byCode": old["byCode"]}
        except Exception as e:
            print(f"[warn] 旧文件解析失败，从头抓：{e}")

    failed = []
    for period in periods:
        t0 = time.time()
        data = None
        for attempt in range(1, RETRIES + 1):
            try:
                data = fetch_period(period)
                break
            except Exception as e:
                print(f"  {period} 第{attempt}次失败：{type(e).__name__}，重试…")
                time.sleep(3 * attempt)
        if data is None:
            failed.append(period)
            continue

        # 按 code 合并：一个票多季度多条记录，同一披露日去重。
        for code, rec in data.items():
            lst = state["byCode"].setdefault(code, [])
            if all(r["ann"] != rec["ann"] for r in lst):
                lst.append(rec)
        for lst in state["byCode"].values():
            lst.sort(key=lambda r: r["ann"])
        if period not in state["periods"]:
            state["periods"].append(period)
        state["fetchedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        tmp = OUT.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False, separators=(",", ":")))
        tmp.replace(OUT)
        print(f"  {period}: {len(data)} 只 · {time.time()-t0:.0f}s · 累计 {len(state['byCode'])} 只")

    print(f"\n完成：{len(state['periods'])} 个报告期，{len(state['byCode'])} 只票 → {OUT}")
    if failed:
        print(f"[warn] 失败报告期（可重跑补齐）：{', '.join(failed)}")
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
