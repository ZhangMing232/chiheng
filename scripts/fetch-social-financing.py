#!/usr/bin/env python3
"""
这个文件是干什么的：
抓人民银行的「社会融资规模增量统计表」，解析成 JSON 落盘到
`data/macro/social-financing.json`，给 /review 的社融面板读。

为什么要它：社融是**领先指标**——它反映的是钱往实体经济投放的力度，比 PMI
更前瞻（PMI 是同步指标，社融往往先动）。A 股是流动性驱动，社融的方向和斜率
是判断「钱在进还是在出」的第一手依据。

**为什么不装 pandas / openpyxl**：akshare 就是因为 arm64 上装不上依赖而废掉的
（py-mini-racer 只有 x86_64 wheel）。xlsx 本质就是 zip + XML，用标准库手写解析，
零新增依赖——这是这个脚本存在的意义，不是炫技。

链路是三级跳（索引 → 年份页 → 专题页 → xls 附件），任何一级结构变了都**抛错**，
不静默返回空表（skill 文档强调的 fail-fast，静默空表比报错难发现得多）。

已实测的坑：
1. **Excel 会把 `2026.10` 的尾零吃掉读成 `2026.1`**，和 1 月的 `2026.01` 撞车。
   1 月在表里始终写作两位 `.01`，所以 `2026.1`（一位）判为 10 月。
2. **月份表头在第 8 行，数据从 +3 行开始**（表头是中英双行 + 一行补充说明）。
   靠「第一列等于『月份』」定位，找不到就抛错。
3. **未来的月份会有行但数值全空**（比如 10 月、11 月已列出还没发布）——
   数值列全空的行要剔掉，否则 `None` 会被当成「社融为 0」。
4. 单位是**亿元人民币**，原样保留，不换算（赤轨纪律：单位按源原样带出来）。
5. **只支持 2021 年起**。2020 及更早是旧版式（表头与项目名合并在一个单元格，
   还带「2017 年以来的历史区」），本脚本不解析那些年份——它们长得不一样，
   硬凑会出错。

用法（收盘后或月中跑都行，社融次月中旬发布）：
    python3 scripts/fetch-social-financing.py
    python3 scripts/fetch-social-financing.py --year 2025
"""

import argparse
import io
import json
import os
import random
import re
import sys
import urllib.error
import urllib.request
import zipfile
from datetime import datetime

BASE = "https://www.pbc.gov.cn"
INDEX = f"{BASE}/diaochatongjisi/116219/116319/index.html"
OUT = "data/macro/social-financing.json"
UA = "Mozilla/5.0"
# 2020 及更早是旧版式，解析逻辑完全不同，不硬凑。
FIRST_SUPPORTED_YEAR = 2021

# 十二列的顺序照表头，不靠猜。
COLUMNS = [
    ("month", "月份"),
    ("afreTotal", "社会融资规模增量"),
    ("rmbLoans", "人民币贷款"),
    ("fxLoans", "外币贷款（折合人民币）"),
    ("entrustedLoans", "委托贷款"),
    ("trustLoans", "信托贷款"),
    ("bankersAcceptance", "未贴现银行承兑汇票"),
    ("corporateBonds", "企业债券"),
    ("governmentBonds", "政府债券"),
    ("equityFinancing", "非金融企业境内股票融资"),
    ("abs", "存款类金融机构资产支持证券"),
    ("writeOff", "贷款核销"),
]


class FetchError(RuntimeError):
    """链路或文件不对劲。**fail-fast，不返回空表。**"""


def get(url: str, timeout: int = 40) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as exc:
        raise FetchError(f"HTTP {exc.code}: {url}") from exc
    except urllib.error.URLError as exc:
        raise FetchError(f"连不上 {url}: {exc.reason}") from exc


def get_text(url: str, timeout: int = 40) -> str:
    raw = get(url, timeout)
    # 人民银行页面编码不统一，按 gbk 试、再 utf-8；都不行就用 apparent
    for enc in ("utf-8", "gb18030"):
        try:
            return raw.decode(enc)
        except UnicodeDecodeError:
            continue
    return raw.decode("latin-1", "replace")


def abs_pbc(href: str) -> str:
    return href if href.startswith("http") else BASE + href


# ── xlsx 解析（纯标准库）──────────────────────────────────────────────


def parse_xlsx(content: bytes) -> list[list[str]]:
    """把 xlsx 的第一个 sheet 读成二维字符串数组。空单元格给 ""。"""
    try:
        archive = zipfile.ZipFile(io.BytesIO(content))
    except zipfile.BadZipFile as exc:
        raise FetchError("附件不是有效 xlsx（可能是 .xls 旧格式或下载被截断）") from exc
    names = archive.namelist()
    if "xl/sharedStrings.xml" not in names:
        raise FetchError(f"xlsx 里没有 sharedStrings.xml（不是 xlsx，或格式不同）：{names[:8]}")
    # **sheet 名不能写死 sheet1.xml**：2021 年的社融表 sheet 名就不是它（实测），
    # 写死会直接判「结构不认识」把那一年丢掉。取 worksheets 下第一个。
    sheets = sorted(n for n in names if re.fullmatch(r"xl/worksheets/sheet\d+\.xml", n))
    if not sheets:
        raise FetchError(f"xlsx 里找不到 worksheet：{names[:8]}")

    shared_xml = archive.read("xl/sharedStrings.xml").decode("utf-8")
    shared = [
        "".join(re.findall(r"<t[^>]*>([^<]*)</t>", si))
        for si in re.findall(r"<si>(.*?)</si>", shared_xml, re.S)
    ]
    sheet = archive.read(sheets[0]).decode("utf-8")

    out: list[list[str]] = []
    for row in re.findall(r"<row[^>]*>(.*?)</row>", sheet, re.S):
        cells = re.findall(r"<c\b[\s\S]*?(?:/>|</c>)", row)
        out.append([cell_text(c, shared) for c in cells])
    return out


def cell_text(cell_xml: str, shared: list[str]) -> str:
    inline = re.search(r"<is>.*?<t[^>]*>([^<]*)</t>.*?</is>", cell_xml, re.S)
    if inline:
        return inline.group(1)
    value = re.search(r"<v>([^<]*)</v>", cell_xml)
    if not value:
        return ""
    if re.search(r'\st="s"', cell_xml):
        index = value.group(1)
        return shared[int(index)] if index.isdigit() and int(index) < len(shared) else ""
    return value.group(1)


# ── 月份标签归一化（那个尾零被吃的坑）────────────────────────────────


def month_label(raw: str) -> str | None:
    """`2026.01` → `2026-01`；`2026.1` → `2026-10`。

    Excel 把 `2026.10` 读成浮点 `2026.1`，尾零被吃掉，和 1 月的 `2026.01` 撞车。
    **1 月在表里始终写作两位 `.01`**，所以一位数的那位就是 10 月。
    """
    m = re.fullmatch(r"(\d{4})\.(\d{1,2})", raw.strip())
    if not m:
        return None
    year, month = int(m.group(1)), int(m.group(2))
    if month == 1 and "." in raw and not raw.strip().endswith(".01"):
        month = 10  # `2026.1` 是被吃掉尾零的 10 月
    if not 1 <= month <= 12:
        return None
    return f"{year:04d}-{month:02d}"


# ── 主流程 ─────────────────────────────────────────────────────────────


def year_table() -> dict[int, str]:
    r"""索引页里的「年份 → 该年页 href」。找不到就抛错。

    ⚠️ 正则只认 `href=...>XXXX年统计数据</a>` 这种紧挨着的写法——中间夹了别的标签
    （2026-10-15 实测踩过：main 里先写了个宽松版 `\s(\d{4})年统计数据\s*</a>`，
    结果一条都匹配不上，只好靠本机年份硬猜，2027 年就抓错年了）。
    """
    index_html = get_text(INDEX)
    years = re.findall(r'href=["\']([^"\']+)["\'][^>]*>\s*(\d{4})年统计数据\s*</a>', index_html)
    if not years:
        raise FetchError("人民银行索引页没找到「XXXX年统计数据」链接，页面结构可能变了")
    return {int(y): href for href, y in years}


def find_book(year: int) -> tuple[str, str]:
    """三级跳找到那一年的社融 xlsx 附件 URL。找不到就抛错。"""
    table = year_table()
    if year not in table:
        raise FetchError(f"人民银行没有 {year} 年的数据，可选年份：{sorted(table, reverse=True)[:8]}")
    if year < FIRST_SUPPORTED_YEAR:
        raise FetchError(
            f"{year} 年是旧版式（表头与项目名合并、附表带 2017 年以来的历史区），"
            f"本脚本只支持 {FIRST_SUPPORTED_YEAR} 年起——硬凑会出错"
        )

    year_page = get_text(abs_pbc(table[year]))
    topics = re.findall(r'href=["\']([^"\']+)["\'][^>]*>\s*(社会融资规模)\s*</a>', year_page)
    if not topics:
        raise FetchError(f"{year} 年页没找到「社会融资规模」专题链接")
    topic_page = get_text(abs_pbc(topics[0][0]))
    # **只认 .xlsx**：2021 年那份是 .xls 旧二进制格式（实测），不是 zip 打的，
    # 硬解只会报一句看不懂的「结构不认识」。这里匹配不到就直接说清是什么情况。
    books = re.findall(r'href=["\']([^"\']+\.xlsx)["\']', topic_page)
    if not books:
        has_xls = re.search(r'href=["\']([^"\']+\.xls)["\']', topic_page)
        if has_xls:
            raise FetchError(
                f"{year} 年的附件是 .xls 旧格式（{has_xls.group(1).split('/')[-1]}），"
                f"不是 xlsx——本脚本零依赖手写 xlsx 解析，读不了 .xls，跳过这一年"
            )
        raise FetchError(f"{year} 年社融专题页没找到 xlsx 附件")
    return abs_pbc(books[0]), books[0]


def parse_social_financing(content: bytes) -> list[dict]:
    grid = parse_xlsx(content)
    # 靠「第一列等于『月份』」定位数据起点——不写死行号，表头行数变了也不会错位
    start = None
    for index, row in enumerate(grid):
        if row and row[0].strip() == "月份":
            start = index
            break
    if start is None:
        raise FetchError("社融表里没有独立的「月份」表头行——可能是不支持的旧版式")

    out: list[dict] = []
    for row in grid[start + 3 :]:  # 表头占 3 行（中英双行 + 一行单位补充）
        if not row or not row[0].strip():
            continue
        label = month_label(row[0])
        if label is None:
            continue
        values: dict[str, object] = {"month": label}
        has_number = False
        for offset, (key, _cn) in enumerate(COLUMNS[1:], start=1):
            raw = row[offset].strip() if offset < len(row) else ""
            if raw == "":
                values[key] = None
                continue
            try:
                values[key] = float(raw)
                has_number = True
            except ValueError:
                values[key] = None
        # **数值列全空的行是还没发布的未来月份**，剔掉——否则 null 会被当成「社融为 0」
        if has_number:
            out.append(values)
    if not out:
        raise FetchError("社融表解析出了 0 行有效数据")
    out.sort(key=lambda r: r["month"])
    return out


def main() -> int:
    parser = argparse.ArgumentParser(description="抓人民银行社融增量，落盘 data/macro/social-financing.json")
    parser.add_argument("--year", type=int, default=None, help="只抓这一年（默认从起始年到今年全抓）")
    parser.add_argument("--since", type=int, default=FIRST_SUPPORTED_YEAR, help="从哪年开始抓")
    parser.add_argument("--out", default=OUT, help="落盘路径")
    parser.add_argument("--root", default=os.getcwd())
    args = parser.parse_args()

    try:
        table = year_table()
    except FetchError as exc:
        print(f"  ✗ {exc}")
        return 1

    available = sorted(y for y in table if y >= args.since)
    if not available:
        print(f"  ✗ 索引页里没有 {args.since} 年之后的数据")
        return 1
    targets = [args.year] if args.year else available
    if args.year and args.year not in table:
        print(f"  ✗ 人民银行没有 {args.year} 年的数据，可选：{available[-8:]}")
        return 1

    # 逐年抓，合并去重（同一个月份后抓的覆盖先抓的——人民银行会补修订）
    merged: dict[str, dict] = {}
    sources: list[dict] = []
    failures: list[str] = []
    for year in targets:
        try:
            url, name = find_book(year)
            rows = parse_social_financing(get(url))
        except FetchError as exc:
            failures.append(f"{year}: {exc}")
            continue
        for row in rows:
            merged[row["month"]] = row
        sources.append({"year": year, "file": name, "url": url, "months": len(rows)})
        latest = rows[-1]
        print(
            f"  {year} ✓ {name} — {len(rows)} 个月"
            f"（最新 {latest['month']}：社融 {latest['afreTotal']} 亿）"
        )

    if not merged:
        print("  ✗ 一年都没抓到：")
        for line in failures:
            print(f"    {line}")
        return 1

    rows = [merged[k] for k in sorted(merged)]
    target = os.path.join(args.root, args.out)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    payload = {
        "source": "中国人民银行 · 社会融资规模增量统计表",
        "unit": "亿元人民币",
        "fetchedAt": datetime.now().isoformat(timespec="seconds"),
        "columns": [{"key": k, "label": cn} for k, cn in COLUMNS],
        "sources": sources,
        "failed": failures,
        "rows": rows,
    }
    # 临时名带 pid + 随机数：固定 .tmp 的话两个进程同时跑会写同一个文件
    tmp = f"{target}.{os.getpid()}.{random.randint(0, 1 << 30):x}.tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    os.replace(tmp, target)

    print(f"  落盘 {target}：{len(rows)} 个月（{rows[0]['month']} ~ {rows[-1]['month']}）")
    if failures:
        print(f"  ⚠️ {len(failures)} 年没抓到：{failures[0][:90]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())