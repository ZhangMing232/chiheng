"""Dock icon: dark rounded square, price gap. Writes a PNG next to this file."""
import struct
import zlib
from pathlib import Path

W = 512
RED = (225, 6, 0)
RAIL = (238, 242, 246)
BG = (12, 12, 14)


def inside(x: int, y: int) -> bool:
    m = 72
    cx = min(max(x, m), W - 1 - m)
    cy = min(max(y, m), W - 1 - m)
    return (x - cx) ** 2 + (y - cy) ** 2 <= m * m


def pixel(x: int, y: int) -> tuple[int, int, int]:
    if not inside(x, y):
        return (0, 0, 0)
    if 86 <= x <= 230 and 268 <= y <= 316:
        return RAIL
    if 282 <= x <= 426 and 168 <= y <= 216:
        return RED
    return BG


def png() -> bytes:
    raw = bytearray()
    for y in range(W):
        raw.append(0)
        for x in range(W):
            raw.extend(pixel(x, y))
    comp = zlib.compress(bytes(raw), 9)

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", W, W, 8, 2, 0, 0, 0)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", comp) + chunk(b"IEND", b"")


Path(__file__).with_name("app-icon.png").write_bytes(png())
