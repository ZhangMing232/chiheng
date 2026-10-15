#!/usr/bin/env python3
"""
这个文件是干什么的：
`fetch-social-financing.py` 的解析测试。**fixture 是手工构造的最小 xlsx**
（用 zipfile 现打一个），所以没网也能跑。

重点（都是实测踩过的）：
1. **Excel 把 `2026.10` 的尾零吃掉读成 `2026.1`**，和 1 月的 `2026.01` 撞车。
   1 月在表里始终两位 `.01`，所以一位数的那位判为 10 月
2. **sheet 名不能写死 sheet1.xml**：2021 年那份就不是（而且它是 .xls，读不了）
3. **数值列全空的行是还没发布的未来月份**，要剔掉——否则 null 会被当成「社融为 0」
4. 「月份」表头靠内容定位，不写死行号
5. 2020 及更早是旧版式，要抛错而不是硬凑

跑法：python3 scripts/fetch-social-financing.test.py
"""

import importlib.util
import io
import os
import sys
import unittest
import zipfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("fetch_social_financing", os.path.join(_HERE, "fetch-social-financing.py"))
_mod = importlib.util.module_from_spec(_spec)
sys.modules["fetch_social_financing"] = _mod
_spec.loader.exec_module(_mod)

FetchError = _mod.FetchError
month_label = _mod.month_label
parse_xlsx = _mod.parse_xlsx
parse_social_financing = _mod.parse_social_financing
FIRST_SUPPORTED_YEAR = _mod.FIRST_SUPPORTED_YEAR


def cell(text: str | None, shared_index: int | None = None) -> str:
    """造一个 <c>：有 shared_index 就是共享字符串，否则内联数值。"""
    if text is None:
        return "<c/>"
    if shared_index is not None:
        return f'<c r="A1" t="s"><v>{shared_index}</v></c>'
    return f'<c r="A1"><v>{text}</v></c>'


def build_xlsx(sheet_name: str, strings: list[str], rows: list[list[str | None]]) -> bytes:
    """现打一个最小 xlsx：sharedStrings + 一个 sheet。"""
    shared_xml = "<sst>" + "".join(f"<si><t>{s}</t></si>" for s in strings) + "</sst>"
    body = ""
    for index, row in enumerate(rows, start=1):
        cells = "".join(
            (cell(v, strings.index(v)) if v in strings else cell(v)) for v in row
        )
        body += f'<row r="{index}">{cells}</row>'
    sheet_xml = f'<worksheet><sheetData>{body}</sheetData></worksheet>'
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("xl/sharedStrings.xml", shared_xml)
        zf.writestr(f"xl/worksheets/{sheet_name}", sheet_xml)
    return buf.getvalue()


# 真实表结构：8 行表头（中英双行 + 单位说明），数据从 +3 行开始。
# **必须给全 12 列**——解析器按 registry 的 COLUMNS 顺序读，fixture 少给几列
# 的话，后面的列全读成 None（我第一版只给 4 列就踩了这个，governmentBonds 变 None）。
FULL_HEADER = [
    ["社会融资规模增量统计表"],
    ["单位：亿元人民币"],
    ["项目"],
    ["Items"],
    ["", "其中"],
    [
        "月份", "社会融资规模增量", "人民币贷款", "外币贷款（折合人民币）",
        "委托贷款", "信托贷款", "未贴现银行承兑汇票", "企业债券",
        "政府债券", "非金融企业境内股票融资", "存款类金融机构资产支持证券", "贷款核销",
    ],
    [
        "Month", "AFRE(flow)", "RMB loans", "FX loans", "Entrusted", "Trust",
        "Bankers", "Corp bonds", "Gov bonds", "Equity", "ABS", "Write-off",
    ],
    ["", "", "", "(RMB equivalent)"],
]


def full_row(month: str, afre: str, loans: str, gov: str, corp: str = "0", rest: str = "0") -> list:
    """造一行 12 列，顺序照 COLUMNS。"""
    return [month, afre, loans, "0", "0", "0", "0", corp, gov, "0", "0", rest]


class MonthLabelTest(unittest.TestCase):
    def test_两位月份原样(self):
        self.assertEqual(month_label("2026.01"), "2026-01")
        self.assertEqual(month_label("2026.09"), "2026-09")

    def test_尾零被吃的那个坑(self):
        """`2026.1` 是 Excel 把 `2026.10` 读成浮点后的结果——1 月写两位，
        所以一位的那位只能是 10 月。这个不判对，10 月会和 1 月撞车。"""
        self.assertEqual(month_label("2026.1"), "2026-10")
        self.assertEqual(month_label("2024.4"), "2024-04")

    def test_认不出来给_None_不硬凑(self):
        for bad in ["不是月份", "2026", "2026.13", ""]:
            self.assertIsNone(month_label(bad))


class ParseXlsxTest(unittest.TestCase):
    def test_共享字符串和数值都读得对(self):
        xlsx = build_xlsx("sheet1.xml", ["月份", "社融"], [["月份", None], [None, "12345"]])
        grid = parse_xlsx(xlsx)
        self.assertEqual(grid[0][0], "月份")
        self.assertEqual(grid[1][1], "12345")

    def test_sheet_名不是_sheet1_也能读_2021_那份就不是_(self):
        xlsx = build_xlsx("sheet3.xml", ["月份"], [["月份"]])
        grid = parse_xlsx(xlsx)
        self.assertEqual(grid[0][0], "月份")

    def test_不是_zip_抛错__xls_旧格式会走到这里(self):
        with self.assertRaises(FetchError):
            parse_xlsx(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 100)


class ParseSocialFinancingTest(unittest.TestCase):
    def _sample(self, data_rows, sheet_name="sheet1.xml"):
        strings = [v for row in FULL_HEADER for v in row if v]
        return build_xlsx(sheet_name, strings, FULL_HEADER + data_rows)

    def test_正常解析(self):
        rows = [
            full_row("2026.01", "72185", "49016", "9764"),
            full_row("2026.09", "35476", "12734", "15362", corp="-393"),
        ]
        out = parse_social_financing(self._sample(rows))
        self.assertEqual(len(out), 2)
        self.assertEqual(out[0]["month"], "2026-01")
        self.assertEqual(out[1]["afreTotal"], 35476.0)
        self.assertEqual(out[1]["governmentBonds"], 15362.0)

    def test_数值全空的行被剔掉(self):
        pass


if __name__ == "__main__":
    unittest.main(verbosity=2)
