#!/usr/bin/env python3
"""
这个文件是干什么的：
`fetch-tdx-package.py` 的二进制解析与白名单过滤测试。

**fixture 是按协议现场构造的**，不下载真包——测试要能在没网、盘后包还没发布的
时候跑。协议来自 a-stock-data SKILL V3.9.0 §1.3（.cod 150 字节/条 +
.md1 512 字节/块），赤轨侧的实现照它写，两边布局必须一致。

跑法（在项目根目录）：
    python3 scripts/fetch-tdx-package.test.py
或  npm run test:all（会带上这一份）

重点钉住的：
1. 白名单只留股票段——沪市指数是 000xxx、深证是 399xxx、北证是 899xxx，
   这些**不是股票**，第一版按黑名单写全漏了。
2. close <= 0 的记录跳过（通达信自编板块整块为 0）。
3. 任何「文件不对劲」都抛 PackageError，不静默跳过——静默跳过会让
   「格式变了」读成「今天没数据」。
"""

import importlib.util
import io
import os
import struct
import sys
import unittest
import zipfile

# 文件名带连字符（fetch-tdx-package.py），不能直接 import，按路径加载。
_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("fetch_tdx_package", os.path.join(_HERE, "fetch-tdx-package.py"))
_mod = importlib.util.module_from_spec(_spec)
sys.modules["fetch_tdx_package"] = _mod
_spec.loader.exec_module(_mod)

BJ_FIRST_DAY = _mod.BJ_FIRST_DAY
STOCK_PREFIX = _mod.STOCK_PREFIX
PackageError = _mod.PackageError
parse_package = _mod.parse_package

COD_LEN, MD1_LEN = 150, 512


def make_record(code: str, seq: int, name: str) -> bytes:
    """造一条 .cod 记录：代码 0:6、序号 32:34、名称 40:72（GBK）。"""
    rec = bytearray(COD_LEN)
    rec[0 : len(code)] = code.encode("ascii")
    struct.pack_into("<H", rec, 32, seq)
    rec[40 : 40 + len(name.encode("gbk"))] = name.encode("gbk")
    return bytes(rec)


def make_block(prev: float, o: float, h: float, l: float, c: float, vol: int, amount: float) -> bytes:
    """造一块 .md1 行情：昨收 4:12、开高低收 12:44、成交量 56:64、成交额 72:80。"""
    blk = bytearray(MD1_LEN)
    struct.pack_into("<d", blk, 4, prev)
    struct.pack_into("<4d", blk, 12, o, h, l, c)
    struct.pack_into("<Q", blk, 56, vol)
    struct.pack_into("<d", blk, 72, amount)
    return bytes(blk)


def build_zip(ymd: str, sh: list, sz: list | None = None, bj: list | None = None) -> bytes:
    """按市场拼一个盘后包 zip。每个元素是 (code, name, block_bytes)。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for market, rows in (("sh", sh), ("sz", sz or []), ("bj", bj or [])):
            cod = b"".join(make_record(code, i, name) for i, (code, name, _) in enumerate(rows))
            md1 = b"".join(block for _, _, block in rows)
            zf.writestr(f"{market}{ymd[2:]}.cod", cod)
            zf.writestr(f"{market}{ymd[2:]}.md1", md1)
    return buf.getvalue()


def row(code, name, close=10.0, **kw):
    defaults = dict(prev=close - 0.1, o=close, h=close + 0.2, l=close - 0.2, c=close, vol=1000, amount=close * 1000)
    defaults.update(kw)
    return (code, name, make_block(**defaults))


class ParseTest(unittest.TestCase):
    YMD = "20261013"

    def test_正常解析三个市场(self):
        z = build_zip(self.YMD, [row("600000", "浦发银行", close=9.59)], [row("000001", "平安银行", close=11.2)], [row("920000", "安徽凤凰", close=13.83)])
        # 下限检查会拦下这么小的 fixture，所以这里只验证解析出的字段
        rows, skipped = self._parse_small(z)
        self.assertEqual(len(rows), 3)
        by_id = {r["id"]: r for r in rows}
        self.assertEqual(by_id["sh600000"]["name"], "浦发银行")
        self.assertAlmostEqual(by_id["sh600000"]["close"], 9.59)
        self.assertEqual(by_id["sh600000"]["volume"], 1000, "成交量单位是股，不是手")
        self.assertEqual(by_id["bj920000"]["code"], "920000")

    def _parse_small(self, z: bytes, ymd: str | None = None):
        """小 fixture 会被 MIN_PRICED 拦下，测试里临时把下限放到 0。"""
        import fetch_tdx_package as mod  # noqa: F401  （已由上方按路径加载）

        old = dict(mod.MIN_PRICED)
        mod.MIN_PRICED = {"sh": 0, "sz": 0, "bj": 0}
        try:
            return mod.parse_package(z, ymd or self.YMD)
        finally:
            mod.MIN_PRICED = old

    def test_白名单只留股票段_指数不是股票(self):
        """沪市指数 000xxx、深证 399xxx、北证 899xxx 都要被剔掉。"""
        z = build_zip(
            self.YMD,
            [row("000001", "上证指数"), row("600000", "浦发银行")],
            [row("399001", "深证成指"), row("000001", "平安银行")],
            [row("899050", "北证50"), row("920000", "安徽凤凰")],
        )
        rows, _ = self._parse_small(z)
        codes = {r["id"] for r in rows}
        self.assertEqual(codes, {"sh600000", "sz000001", "bj920000"})
        self.assertNotIn("sh000001", codes, "沪市指数是 000xxx，不是股票")
        self.assertNotIn("sz399001", codes, "深证成指是 399xxx，不是股票")
        self.assertNotIn("bj899050", codes, "北证50 是 899xxx，不是股票")

    def test_ETF和债券不在白名单里(self):
        z = build_zip(
            self.YMD,
            [row("510050", "上证50ETF"), row("110075", "南航转债"), row("600000", "浦发银行")],
            [row("159001", "深100ETF"), row("123456", "某某转债"), row("000001", "平安银行")],
        )
        rows, _ = self._parse_small(z)
        self.assertEqual({r["id"] for r in rows}, {"sh600000", "sz000001"})

    def test_收盘价为零的记录跳过_不是证券(self):
        z = build_zip(self.YMD, [row("880001", "总市值", close=0), row("600000", "浦发银行")])
        rows, _ = self._parse_small(z)
        self.assertEqual([r["id"] for r in rows], ["sh600000"])

    def test_科创和创业代码段都在(self):
        z = build_zip(
            self.YMD,
            [row("688356", "键凯科技"), row("689009", "九号公司")],
            [row("300725", "药石科技")],
        )
        rows, _ = self._parse_small(z)
        self.assertEqual({r["id"] for r in rows}, {"sh688356", "sh689009", "sz300725"})

    def test_成交量成交额字段齐全(self):
        z = build_zip(self.YMD, [row("600000", "浦发银行", vol=68029002, amount=654402287.0)])
        rows, _ = self._parse_small(z)
        r = rows[0]
        self.assertEqual(r["volume"], 68029002)
        self.assertAlmostEqual(r["amount"], 654402287.0)
        self.assertIn("prevClose", r)
        for key in ("open", "high", "low", "close"):
            self.assertIn(key, r)

    def test_北交所在首个北交所日之前_没有文件也不报错(self):
        """20220506 之前的包没有北交所文件，返回空而不是抛错。"""
        z = build_zip("20220505", [row("600000", "浦发银行")])
        rows, _ = self._parse_small(z, ymd="20220505")
        self.assertTrue(all(not r["id"].startswith("bj") for r in rows))

    def test_包不是zip_报错不说成没数据(self):
        with self.assertRaises(PackageError):
            parse_package("这不是 zip".encode("utf-8"), self.YMD)


class ValidationTest(unittest.TestCase):
    """文件不对劲时必须抛错，不能静默跳过。"""

    YMD = "20261013"

    def _expect_error(self, z: bytes, needle: str):
        with self.assertRaises(PackageError) as ctx:
            import fetch_tdx_package as mod  # noqa: F401  （已由上方按路径加载）

            old = dict(mod.MIN_PRICED)
            mod.MIN_PRICED = {"sh": 0, "sz": 0, "bj": 0}
            try:
                mod.parse_package(z, self.YMD)
            finally:
                mod.MIN_PRICED = old
        self.assertIn(needle, str(ctx.exception))

    def test_非有限数值抛错(self):
        bad = bytearray(MD1_LEN)
        struct.pack_into("<4d", bad, 12, 10.0, 10.2, 9.8, float("nan"))
        cod = make_record("600000", 0, "浦发银行")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(f"sh{self.YMD[2:]}.cod", cod)
            zf.writestr(f"sh{self.YMD[2:]}.md1", bytes(bad))
        self._expect_error(buf.getvalue(), "非有限数值")

    def test_代码表长度不是整块抛错(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(f"sh{self.YMD[2:]}.cod", b"\x00" * 149)
            zf.writestr(f"sh{self.YMD[2:]}.md1", b"\x00" * MD1_LEN)
        self._expect_error(buf.getvalue(), "长度不是整块")

    def test_代码表与行情块数量对不上抛错(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(f"sh{self.YMD[2:]}.cod", make_record("600000", 0, "浦发银行"))
            zf.writestr(f"sh{self.YMD[2:]}.md1", b"\x00" * (MD1_LEN * 2))
        self._expect_error(buf.getvalue(), "对不上")

    def test_行情块越界抛错(self):
        cod = make_record("600000", 5, "浦发银行")  # seq=5 但只有 1 块
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(f"sh{self.YMD[2:]}.cod", cod)
            zf.writestr(f"sh{self.YMD[2:]}.md1", b"\x00" * MD1_LEN)
        self._expect_error(buf.getvalue(), "越界")

    def test_名称不是GBK_报错不说成没数据(self):
        rec = bytearray(make_record("600000", 0, "浦发银行"))
        rec[40:44] = b"\xff\xfe\xfd\xfc"  # 不可能是 GBK 的序列
        blk = make_block(9.6, 9.6, 9.7, 9.5, 9.59, 1000, 9590.0)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            zf.writestr(f"sh{self.YMD[2:]}.cod", bytes(rec))
            zf.writestr(f"sh{self.YMD[2:]}.md1", blk)
        self._expect_error(buf.getvalue(), "不是 GBK")

    def test_有价记录少于下限抛错_不落半份(self):
        z = build_zip("20261013", [row("600000", "浦发银行")])
        with self.assertRaises(PackageError):
            parse_package(z, "20261013")


class WhitelistTest(unittest.TestCase):
    def test_代码段覆盖沪深北三市的股票段(self):
        self.assertIn("600", STOCK_PREFIX["sh"])
        self.assertIn("688", STOCK_PREFIX["sh"], "科创板")
        self.assertIn("689", STOCK_PREFIX["sh"], "科创板存托凭证")
        self.assertIn("300", STOCK_PREFIX["sz"])
        self.assertIn("301", STOCK_PREFIX["sz"])
        self.assertIn("920", STOCK_PREFIX["bj"], "北交所新段")
        self.assertIn("430", STOCK_PREFIX["bj"], "北交所老段")

    def test_指数和基金段不在白名单(self):
        """⚠️ 同一个代码段在不同市场含义不同，必须按市场判：
        沪市 000001 是上证指数，深市 000001 是平安银行（主板股票）。
        这就是白名单必须是 (market, prefix) 组合、不能只看 prefix 的原因。"""
        for bad in ("999", "399", "899", "510", "511", "159", "150", "110", "900", "880"):
            for market in ("sh", "sz", "bj"):
                self.assertNotIn(bad, STOCK_PREFIX[market], f"{bad} 不该是 {market} 的股票段")
        self.assertNotIn("000", STOCK_PREFIX["sh"], "沪市 000xxx 是指数")
        self.assertIn("000", STOCK_PREFIX["sz"], "深市 000xxx 是主板股票")

    def test_北交所首个日期常量(self):
        self.assertEqual(BJ_FIRST_DAY, "20220506")


if __name__ == "__main__":
    unittest.main(verbosity=2)
