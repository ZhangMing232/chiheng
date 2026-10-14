#!/usr/bin/env python3
"""
这个文件是干什么的：
拉通达信官网**每日盘后增量包**，解析成赤轨要的全市场日线截面，落盘
`data/backtest/tdx-daily/{ymd}.json`。

为什么要它（2026-10-14 接入，对标 a-stock-data SKILL V3.9.0 §1.3）：
赤轨原来的日线是 baostock **逐只**拉（回测 300 只 × 一个请求，还撞过 WAF 501）。
盘后包是**一个请求拿沪深北全部证券**当日的昨收/开高低收/成交量/成交额，
2.7MB zip。收盘后做截面筛选、每日落库比逐只拉快一个数量级。

⚠️ **它不是腾讯快照的替代品**：盘后包一天一个，盘中不更新。腾讯快照管盘中
实时价（选股/记账），这个管收盘后的权威日线。两件事，别混。

已知的坑（全部实测过，写在下面）：
1. **当天的包拿不到**（404）：通达信收盘后数小时才发布。这不是错误，
   报错时要写清「还没发布」而不是「接口挂了」。
2. **成交量单位是股**（不是手）。腾讯的 K 线是科创板股、其余手；通达信这个
   全是股。两个源混用前先换算，不然差 100 倍。
3. **包里 52168 条记录，只有 5565 条是 A 股股票**。其余是指数（沪 000xxx /
   深 399xxx / 北 899xxx / 999xxx）、ETF 与 LOF（沪 5xxxxx / 深 15xxxx）、
   可转债与债券（沪 11x/12x、深 12x/13x）、B 股（沪 900xxx、深 2xxxxx）、
   通达信自编板块（88xxxx）。**用白名单只留股票段**，黑名单一定漏。
4. 二进制布局：`.cod` 150 字节/条（代码 0:6、序号 32:34、名称 40:72 GBK），
   `.md1` 512 字节/块（昨收 4:12、开高低收 12:44、成交量 56:56+8、成交额 72:80，
   全是小端）。2026-09 起北交所文件才进包（20220506 是第一个有的）。
5. 5565 只 vs 腾讯快照的 5224 只**对不齐**（差 341 只，可能来自 ST 与停牌股
   的处理差异）。所以这个截面**不能直接当 universe 用**，它是日线数据源。

用法：
    python3 scripts/fetch-tdx-package.py                 # 拉今天
    python3 scripts/fetch-tdx-package.py --date 2026-10-13
    python3 scripts/fetch-tdx-package.py --back 5        # 补最近 5 个自然日
    python3 scripts/fetch-tdx-package.py --dry-run       # 只解析不落盘

落盘 JSON：{ date, fetchedAt, source, url, rows[], skipped }
rows[] 一条：{ id, code, name, prevClose, open, high, low, close, volume, amount }
"""

import argparse
import io
import json
import math
import os
import random
import re
import struct
import sys
import urllib.error
import urllib.request
import zipfile
from datetime import date, datetime, timedelta

# ── 端点与常量 ────────────────────────────────────────────────────────────
PACKAGE_URL = "https://www.tdx.com.cn/products/data/data/g4day/{ymd}.zip"
# 盘后包从这一天起带北交所文件（a-stock-data 2026-09-20 二分实测：20220505 无、20220506 有）
BJ_FIRST_DAY = "20220506"
# 每个市场有收盘价的最少条数。低于它说明文件被截断或格式变了，宁可不落盘。
# 数字来自 a-stock-data 2026-09-20 对 11 个真实包的实测最小值，下限取明显低于它的整数。
MIN_PRICED = {"sh": 10000, "sz": 3000, "bj": 50}
# A 股股票代码段（白名单）。指数/ETF/债券/B股/通达自编全在外头，见文件头坑 3。
STOCK_PREFIX = {
    "sh": ("600", "601", "603", "605", "688", "689"),
    "sz": ("000", "001", "002", "003", "300", "301"),
    "bj": ("430", "830", "870", "920"),
}
OUT_DIR = "data/backtest/tdx-daily"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"


class PackageError(RuntimeError):
    """包内容不对劲（格式变了/被截断/损坏）。和「还没发布」分开报。"""


def ymd_of(day: date) -> str:
    return day.strftime("%Y%m%d")


def download(ymd: str, timeout: int = 60) -> bytes:
    """下载一个日期的包。404 单独报——那是还没发布，不是接口挂了。"""
    url = PACKAGE_URL.format(ymd=ymd)
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            raise PackageError(f"{ymd} 的包还没有（404）。通达信通常收盘后数小时才发布，当天拿不到是正常的") from exc
        raise PackageError(f"{ymd} 的包下载失败：HTTP {exc.code}") from exc
    except urllib.error.URLError as exc:
        raise PackageError(f"{ymd} 的包下载失败：{exc.reason}") from exc


def _parse_market(archive: zipfile.ZipFile, ymd: str, market: str, names: set) -> list:
    """解析一个市场的 .cod + .md1，返回有价记录的列表。校验全部保留。"""
    cod_name, md1_name = f"{market}{ymd[2:]}.cod", f"{market}{ymd[2:]}.md1"
    if market == "bj" and ymd < BJ_FIRST_DAY and cod_name not in names and md1_name not in names:
        return []  # 这天之前的包还没有北交所文件
    if cod_name not in names or md1_name not in names:
        raise PackageError(f"盘后包缺 {cod_name}/{md1_name}，格式可能已变")
    cod, md1 = archive.read(cod_name), archive.read(md1_name)
    if len(cod) % 150 or len(md1) % 512:
        raise PackageError(f"{market} 代码表或行情块长度不是整块，文件可能被截断")
    if len(cod) // 150 != len(md1) // 512:
        raise PackageError(f"{market} 代码表 {len(cod) // 150} 条、行情块 {len(md1) // 512} 块，对不上")

    rows, codes, seqs = [], set(), set()
    for offset in range(0, len(cod), 150):
        record = cod[offset : offset + 150]
        code = record[0:6].rstrip(b"\x00 ").decode("ascii", "replace")
        seq = struct.unpack("<H", record[32:34])[0]
        if not re.fullmatch(r"[0-9]{6}", code):
            raise PackageError(f"{market} 代码表出现非 6 位数字代码 {code!r}，格式可能已变")
        if code in codes or seq in seqs:
            raise PackageError(f"{market} 代码表有重复的代码/序号（{code!r}, seq={seq}）")
        codes.add(code)
        seqs.add(seq)
        block = md1[seq * 512 : (seq + 1) * 512]
        if len(block) != 512:
            raise PackageError(f"{market}{code} 行情块越界（seq={seq}）")
        prev_close = struct.unpack("<d", block[4:12])[0]
        open_, high, low, close = struct.unpack("<4d", block[12:44])
        volume = struct.unpack("<Q", block[56:64])[0]
        amount = struct.unpack("<d", block[72:80])[0]
        # NaN 能绕过 close <= 0 被当成有价记录；11 个真实包里没有一个非有限值，
        # 出现了就是文件坏了，别静默放过。
        if not all(math.isfinite(v) for v in (prev_close, open_, high, low, close, amount)):
            raise PackageError(f"{market}{code} 出现非有限数值，文件可能已损坏")
        if close <= 0:
            continue  # 880/881 等通达信自编板块指数当日无价，整块为 0，不是证券
        raw_name = record[40:72].split(b"\x00")[0]
        try:
            name = raw_name.decode("gbk").strip()
        except UnicodeDecodeError as exc:
            raise PackageError(f"{market}{code} 的名称不是 GBK，文件可能已损坏") from exc
        if not name:
            raise PackageError(f"{market}{code} 有价格却没有名称，文件可能已损坏")
        rows.append(
            {
                "id": f"{market}{code}",
                "code": code,
                "name": name,
                "prevClose": round(prev_close, 4),
                "open": round(open_, 4),
                "high": round(high, 4),
                "low": round(low, 4),
                "close": round(close, 4),
                "volume": volume,  # 股，不是手（见文件头坑 2）
                "amount": round(amount, 2),
            }
        )
    if len(rows) < MIN_PRICED[market]:
        raise PackageError(f"{market} 只有 {len(rows)} 条有价记录，少于下限 {MIN_PRICED[market]}，文件可能被截断")
    return rows


def parse_package(content: bytes, ymd: str) -> list:
    """解析整个包，返回**只含 A 股股票**的记录（白名单过滤后的）。"""
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise PackageError(f"{ymd} 的包不是有效 zip（下载被截断了？）") from exc
    names = set(archive.namelist())
    kept, skipped = [], 0
    for market in ("sh", "sz", "bj"):
        for row in _parse_market(archive, ymd, market, names):
            if row["code"][:3] in STOCK_PREFIX[market]:
                kept.append(row)
            else:
                skipped += 1
    return kept, skipped  # type: ignore[return-value]


def out_path(root: str, day: date) -> str:
    return os.path.join(root, OUT_DIR, f"{day.isoformat()}.json")


def fetch_one(root: str, day: date, force: bool = False, dry: bool = False) -> dict:
    """拉一天。已落盘且没 --force 就跳过（幂等）。"""
    target = out_path(root, day)
    if os.path.exists(target) and not force:
        return {"date": day.isoformat(), "status": "skipped", "why": "已落盘（--force 可重拉）"}
    ymd = ymd_of(day)
    content = download(ymd)
    kept, skipped = parse_package(content, ymd)
    if dry:
        return {"date": day.isoformat(), "status": "dry-run", "rows": len(kept), "skipped": skipped}
    payload = {
        "date": day.isoformat(),
        "fetchedAt": datetime.now().isoformat(timespec="seconds"),
        "source": "tdx.com.cn",
        "url": PACKAGE_URL.format(ymd=ymd),
        "rows": kept,
        "skipped": skipped,
    }
    os.makedirs(os.path.dirname(target), exist_ok=True)
    # 临时名带 pid + 随机数：固定 .tmp 的话两个进程同时跑会写同一个临时文件，
    # 一个 rename 成功后另一个 ENOENT 抛出来，白跑一趟。
    tmp = f"{target}.{os.getpid()}.{random.randint(0, 1 << 30):x}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, target)
    return {"date": day.isoformat(), "status": "ok", "rows": len(kept), "skipped": skipped}


def main() -> int:
    parser = argparse.ArgumentParser(description="拉通达信盘后包，落盘全市场日线截面")
    parser.add_argument("--date", help="YYYY-MM-DD，默认今天")
    parser.add_argument("--back", type=int, default=0, help="往前补 N 个自然日（含指定日）")
    parser.add_argument("--force", action="store_true", help="已落盘也重拉")
    parser.add_argument("--dry-run", action="store_true", help="只下载解析，不落盘")
    parser.add_argument("--root", default=os.getcwd(), help="项目根目录")
    args = parser.parse_args()

    base = date.fromisoformat(args.date) if args.date else date.today()
    days = [base - timedelta(days=i) for i in range(args.back + 1)] if args.back else [base]

    root = args.root
    failures = 0
    for day in days:
        try:
            result = fetch_one(root, day, force=args.force, dry=args.dry_run)
        except PackageError as exc:
            print(f"  {exc}")
            failures += 1
            continue
        if result["status"] == "ok":
            print(f"  {result['date']} ✓ {result['rows']} 只股票（剔了 {result['skipped']} 条非股票）")
        elif result["status"] == "dry-run":
            print(f"  {result['date']}（dry-run）{result['rows']} 只股票，剔了 {result['skipped']} 条")
        else:
            print(f"  {result['date']} — {result['why']}")
    if failures:
        print(f"\n{failures} 天没拿到。当天包 404 = 还没发布（正常）；连续多天失败才是接口问题。")
    return 1 if failures == len(days) else 0


if __name__ == "__main__":
    sys.exit(main())
