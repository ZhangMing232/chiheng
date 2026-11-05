#!/usr/bin/env python3
"""
抓「公告」历史，落盘到 data/backtest/ann/。

为什么需要它（2026-11-05）：
因子注册表里的 `ann_count`（公告密度）**没有数据源**——回测里 metrics() 写死 null，
于是这个因子每轮都是「数据缺失·未测」。本脚本补上这条线。

源：巨潮资讯的公告查询接口（cninfo hisAnnouncement）。
- 支持按日期区间 + 分页；每条带 secCode（6 位代码）和公告时间。
- ⚠️ pageSize 服务端封顶 30（传 100 也只给 30）。所以按天翻页很碎。

量级（实测）：A 股两市一天几千条公告 → 一天要翻上百页，
**全窗口（250 个交易日）约 2.5~4 万次请求、2~4 小时**。
所以这是**一次性历史抓取**（和 scripts/fetch-margin-history.ts 同一个套路：2-3 小时、可 Ctrl-C 断点续跑），
不是每天都要跑的活。抓完落盘，回测直接读缓存。

用法：
    python3 scripts/fetch-ann-count.py                    # 抓整个回测窗口
    python3 scripts/fetch-ann-count.py --days 5           # 只抓最近 5 天（试跑）
    python3 scripts/fetch-ann-count.py --from 2025-10-27 --to 2025-11-05
"""

import json
import os
import sys
import time
import urllib.request

OUT_DIR = "data/backtest/ann"
PAGE_SIZE = 30
SLEEP = 0.30
HEADERS = {
    "User-Agent": "Mozilla/5.0",
    "Content-Type": "application/json",
    "Accept": "application/json",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://www.cninfo.com.cn/new/commonUrl?url=disclosure/list/notice",
}


def post(day):
    body = {
        "pageNum": 1,
        "pageSize": PAGE_SIZE,
        "column": "szse",
        "tabName": "fulltext",
        "plate": "",
        "stock": "",
        "searchkey": "",
        "secid": "",
        "category": "",
        "trade": "",
        "seDate": day,
        "sortName": "",
        "sortType": "",
        "isHLtitle": "true",
    }
    req = urllib.request.Request(
        "https://www.cninfo.com.cn/new/hisAnnouncement/query",
        data=json.dumps(body).encode(),
        headers=HEADERS,
    )
    return json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace"))


def day_dates(start, end):
    """闭区间的自然日列表（接口按自然日过滤，非交易日会返回空）。"""
    from datetime import date, timedelta
    cur = date.fromisoformat(start)
    last = date.fromisoformat(end)
    out = []
    while cur <= last:
        out.append(cur.isoformat())
        cur += timedelta(days=1)
    return out


def fetch_day(day):
    """抓一天的全部公告 → {code: 条数}。翻到空页为止。"""
    counts = {}
    page = 1
    while True:
        body = {
            "pageNum": page, "pageSize": PAGE_SIZE, "column": "szse", "tabName": "fulltext",
            "plate": "", "stock": "", "searchkey": "", "secid": "", "category": "", "trade": "",
            "seDate": day, "sortName": "", "sortType": "", "isHLtitle": "true",
        }
        req = urllib.request.Request(
            "https://www.cninfo.com.cn/new/hisAnnouncement/query",
            data=json.dumps(body).encode(), headers=HEADERS,
        )
        try:
            data = json.loads(urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace"))
        except Exception as e:
            return counts, f"翻页失败：{str(e)[:60]}"
        anns = data.get("announcements") or []
        if not anns:
            break
        for a in anns:
            code = a.get("secCode")
            if code:
                counts[code] = counts.get(code, 0) + 1
        page += 1
        if page % 20 == 0:
            print(f"      …{day} 已翻 {page} 页 / {sum(counts.values())} 条", flush=True)
        time.sleep(SLEEP)
        if page > 400:  # 安全阀：一天不该有 12000 条公告
            break
    return counts, None


def main():
    args = sys.argv[1:]
    days = None
    if "--days" in args:
        days = int(args[args.index("--days") + 1])
    start = "2025-10-27"
    end = "2026-11-05"
    if "--from" in args:
        start = args[args.index("--from") + 1]
    if "--to" in args:
        end = args[args.index("--to") + 1]
    os.makedirs(OUT_DIR, exist_ok=True)
    dates = day_dates(start, end)
    if days:
        dates = dates[-days:]
    print(f"要抓 {len(dates)} 天（{start} ~ {end}），每页 {PAGE_SIZE} 条")
    done = 0
    for i, day in enumerate(dates, 1):
        path = os.path.join(OUT_DIR, f"{day}.json")
        if os.path.exists(path):
            done += 1
            continue
        counts, err = fetch_day(day)
        if err:
            print(f"  [{i}/{len(dates)}] {day} {err}")
            continue
        if not counts:
            # 非交易日：写个空标记，避免重抓
            json.dump({"date": day, "counts": {}}, open(path, "w", encoding="utf-8"), ensure_ascii=False)
            continue
        json.dump({"date": day, "counts": counts}, open(path, "w", encoding="utf-8"), ensure_ascii=False)
        done += 1
        total = sum(counts.values())
        print(f"  [{i}/{len(dates)}] {day}: {len(counts)} 只票 / {total} 条公告")
    print(f"完成：{done}/{len(dates)} 天 → {OUT_DIR}/")


if __name__ == "__main__":
    main()
