#!/usr/bin/env python3
"""
抓「板块资金流」历史 + 板块成分股，落盘到 data/backtest/sector-flow/。

为什么需要它（2026-11-05）：
因子注册表里的 `sector_flow`（所属板块主力净流入）**数据源一直没有**——回测里
metrics() 写死 null，于是这个因子每轮都是「数据缺失·未测」（t=0），白占一个注册位。
本脚本补上这条线。

拿什么源：东方财富的板块资金流日线（push2his 的 fflow/daykline）。
- f51=日期 f52=主力净流入额(元) … f57=**主力净流入占比(%)** f58..f61=各单占比 f63=涨跌幅
- **取 f57（占比）不是 f52（金额）**：横截面上比金额比的是板块规模，不是资金流强度。
  和个股主力净流入（main_flow）用比率版是同一个道理。

⚠️ **口径警告（前视）**：板块成分股是**抓取当天**的快照，历史回放时用的也是这张表。
  某只票若中途调过板块，它历史的「所属板块资金」会按今天的归属算——这是**分类前视**，
  不是收益前视（板块资金流本身是真实历史）。量级有限但不是零，如实记着。
  因子注册表里 sector_flow 的 rationale 也写了这条局限。

用法：
    python3 scripts/fetch-sector-flow.py            # 抓全部（已存在的跳过，可中断续跑）
    python3 scripts/fetch-sector-flow.py --limit 10  # 只抓前 10 个（试跑用）
"""

import json
import os
import sys
import time
import urllib.request

OUT_DIR = "data/backtest/sector-flow"
UA = {"User-Agent": "Mozilla/5.0", "Referer": "https://data.eastmoney.com/"}
# 两页之间歇一下，别把东财打出限流（项目踩过：连跑十几轮就限流，等几分钟自愈）
SLEEP = 0.35


def get(url, timeout=15):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", "replace")


def fetch_sectors():
    """行业板块列表（m:90+t:2 = 行业板块；t:3 是概念板块，太多且互相重叠，先不用）。"""
    url = (
        "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=500&po=1&np=1&fltt=2&invt=2"
        "&fid=f3&fs=m:90+t:2&fields=f12,f14,f3"
    )
    data = json.loads(get(url)).get("data") or {}
    diff = data.get("diff") or []
    out = []
    for row in diff:
        code = row.get("f12")
        name = row.get("f14")
        if code and name:
            out.append({"code": code, "name": name})
    return out


def fetch_members(sector_code):
    """板块成分股（今天的快照——历史成分拿不到，这是已知的分类前视）。"""
    url = (
        "https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=600&po=1&np=1&fltt=2&invt=2"
        f"&fid=f3&fs=b:{sector_code}&fields=f12,f13"
    )
    data = json.loads(get(url)).get("data") or {}
    diff = data.get("diff") or []
    out = []
    for row in diff:
        code = row.get("f12")
        market = row.get("f13")  # 0=深 1=沪
        if not code:
            continue
        # 东财的 secid：沪市 1.xxxxxx / 深市 0.xxxxxx；北交所也是 0
        prefix = "sh" if str(market) == "1" else "sz"
        if code.startswith(("4", "8", "9")):  # 北交所
            prefix = "bj"
        out.append(f"{prefix}{code}")
    return out


def fetch_flow_history(sector_code):
    """板块资金流日线历史（一次请求拿全部）。"""
    url = (
        "https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get"
        f"?lmt=400&klt=101&secid=90.{sector_code}"
        "&fields1=f1,f2,f3,f7&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63"
    )
    data = json.loads(get(url)).get("data") or {}
    klines = data.get("klines") or []
    days = []
    for line in klines:
        parts = str(line).split(",")
        if len(parts) < 13:
            continue
        try:
            days.append({
                "date": parts[0],
                "mainRatio": float(parts[6]),   # f57 主力净流入占比 %
                "mainAmount": float(parts[1]),  # f52 主力净流入额（元）
            })
        except (ValueError, IndexError):
            continue
    return days


def main():
    limit = None
    if "--limit" in sys.argv:
        limit = int(sys.argv[sys.argv.index("--limit") + 1])
    os.makedirs(OUT_DIR, exist_ok=True)
    index_path = os.path.join(OUT_DIR, "sectors.json")
    sectors = fetch_sectors()
    print(f"行业板块 {len(sectors)} 个")
    if limit:
        sectors = sectors[:limit]
    index = []
    for i, s in enumerate(sectors, 1):
        code = s["code"]
        flow_path = os.path.join(OUT_DIR, f"{code}.json")
        entry = {"code": code, "name": s["name"]}
        if os.path.exists(flow_path):
            try:
                old = json.load(open(flow_path, encoding="utf-8"))
                entry["days"] = len(old.get("days") or [])
                entry["members"] = old.get("members") or []
                index.append(entry)
                print(f"  [{i}/{len(sectors)}] {code} {s['name']} 已有 {entry['days']} 天，跳过")
                continue
            except Exception:
                pass
        try:
            days = fetch_flow_history(code)
            time.sleep(SLEEP)
            members = fetch_members(code)
            time.sleep(SLEEP)
        except Exception as e:
            print(f"  [{i}/{len(sectors)}] {code} {s['name']} 失败：{str(e)[:70]}")
            continue
        if not days:
            print(f"  [{i}/{len(sectors)}] {code} {s['name']} 没数据")
            continue
        json.dump({"code": code, "name": s["name"], "days": days, "members": members},
                  open(flow_path, "w", encoding="utf-8"), ensure_ascii=False)
        entry["days"] = len(days)
        entry["members"] = members
        index.append(entry)
        print(f"  [{i}/{len(sectors)}] {code} {s['name']}: {len(days)} 天, {len(members)} 只成分股")
    json.dump({"sectors": index, "fetchedAt": time.strftime("%Y-%m-%dT%H:%M:%S")},
              open(index_path, "w", encoding="utf-8"), ensure_ascii=False)
    print(f"完成 → {OUT_DIR}/（{len(index)} 个板块）")


if __name__ == "__main__":
    main()
