#!/usr/bin/env python3
"""
抓「公告」历史，落盘到 data/backtest/ann/。

为什么需要它（2026-11-05）：
因子注册表里的 `ann_count`（公告密度）**没有数据源**——回测里 metrics() 写死 null，
于是这个因子每轮都是「数据缺失·未测」（t=0），白占一个注册位。本脚本补上这条线。

源：**东方财富的个股公告接口**（np-anotice-stock），按日期区间查。
- 实测：一天约 2000 条公告，page_size 服务端封顶 100 → 22 页/天
  → 全窗口（250 个交易日）约 5500 次请求、半小时上下，**一次性抓完落盘**（不是每天要跑的活）。
- 每条带 codes[0].stock_code（6 位代码）。

⚠️ 为什么不走巨潮：巨潮那个 hisAnnouncement 接口**不接受 seDate**（实测 8 种参数变体
全返回同一天最新数据，total 36 万条 / 12005 页），按天抓只会拿到重复的同一批——
第一版就是这么写错的，抓出来的「一天 12000 条公告」其实全是同一批数据的副本。
东财这个接口日期过滤是对的（实测 2025-10-27 只返回那天的）。

用法：
    python3 scripts/fetch-ann-count.py                    # 抓整个回测窗口
    python3 scripts/fetch-ann-count.py --days 5           # 只抓最近 5 天（试跑）
    python3 scripts/fetch-ann-count.py --from 2025-10-27 --to 2025-11-05
"""

import json
import os
import sys
import time
import urllib.parse
import urllib.request

OUT_DIR = "data/backtest/ann"
PAGE_SIZE = 100  # 服务端封顶 100
SLEEP = 0.25
HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Referer": "https://data.eastmoney.com/notices/",
    "Accept": "application/json",
}
API = "https://np-anotice-stock.eastmoney.com/api/security/ann"


def fetch_page(day, page):
    q = urllib.parse.urlencode({
        "sr": "-1", "page_size": str(PAGE_SIZE), "page_index": str(page),
        "ann_type": "A", "client_source": "web", "f_node": "0", "s_node": "0",
        "begin_time": day, "end_time": day,
    })
    req = urllib.request.Request(f"{API}?{q}", headers=HEADERS)
    raw = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
    data = (json.loads(raw).get("data") or {})
    return data.get("list") or [], int(data.get("total_hits") or 0)


def fetch_day(day):
    """抓一天的全部公告 → {6位代码: 条数}。"""
    counts = {}
    first, total = fetch_page(day, 1)
    if not first:
        return counts, None
    pages = max(1, (total + PAGE_SIZE - 1) // PAGE_SIZE)
    for page in range(1, pages + 1):
        items = first if page == 1 else fetch_page(day, page)[0]
        if not items:
            break
        for it in items:
            codes = it.get("codes") or []
            code = codes[0].get("stock_code") if codes else None
            if code and len(str(code)) == 6:
                counts[str(code)] = counts.get(str(code), 0) + 1
        time.sleep(SLEEP)
    return counts, None


def day_dates(start, end):
    from datetime import date, timedelta
    cur, last, out = date.fromisoformat(start), date.fromisoformat(end), []
    while cur <= last:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def main():
    args = sys.argv[1:]
    days = None
    if "--days" in args:
        days = int(args[args.index("--days") + 1])
    start, end = "2025-10-27", "2026-11-05"
    if "--from" in args:
        start = args[args.index("--from") + 1]
    if "--to" in args:
        end = args[args.index("--to") + 1]
    os.makedirs(OUT_DIR, exist_ok=True)
    dates = day_dates(start, end)
    if days:
        dates = dates[-days:]
    print(f"要抓 {len(dates)} 天（{start} ~ {end}）")
    done = 0
    for i, day in enumerate(dates, 1):
        path = os.path.join(OUT_DIR, f"{day}.json")
        if os.path.exists(path):
            done += 1
            continue
        try:
            counts, err = fetch_day(day)
        except Exception as e:
            print(f"  [{i}/{len(dates)}] {day} 失败：{str(e)[:70]}")
            continue
        if err:
            print(f"  [{i}/{len(dates)}] {day} {err}")
            continue
        json.dump({"date": day, "counts": counts}, open(path, "w", encoding="utf-8"), ensure_ascii=False)
        done += 1
        print(f"  [{i}/{len(dates)}] {day}: {len(counts)} 只票 / {sum(counts.values())} 条公告", flush=True)
    print(f"完成：{done}/{len(dates)} 天 → {OUT_DIR}/")


if __name__ == "__main__":
    main()
