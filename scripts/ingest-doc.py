#!/usr/bin/env python3
"""
这个文件是干什么的：
把研报文档（PDF / Word / Markdown / 文本 / 赤轨自己的研判 JSON）摄入成
**可检索的块**，落盘到 `data/docs/<docId>.json`，给 /reports 的文档库用。

这是对标 Vibe-Research 的 MyReports 页（它能导入 PDF/Word、检索、提问、引用回查
原文）——赤轨原来只存自己生成的研判，没有「摄入外部文档」这一层。

**为什么要「引用回查原文」**（这是这个功能的核心，不是搜索框）：
检索命中之后必须能指回原文的**具体位置**（第几页 / 第几行），否则读的人
无法核对 AI 引用的话到底出自哪里。所以每块都带 `locator`（页码或行号区间），
页面必须显示它——这是赤轨「数字/结论必须有出处」纪律在文档库里的落地。

支持的格式与实测（2026-10-15）：
- **PDF**：pypdf（纯 Python，arm64 能装，已实测）。中文 CID 字体实测能抽出
  （reportlab 生成的 STSong-Light 样张，85 字全对）。**子集化 TTF 的中文 PDF
  没验证过**——所以每份文档都记 `extractedChars`，抽不出就是抽不出，
  **不假装成功**。
- **Markdown / 文本**：直接读，按段落切。
- **JSON**：赤轨自己的研判导出（/reports 存的就是这种），按字段切。
- **Word**：**.docx 是 zip + XML，零依赖手写解析**（和社融那个 xlsx 一个套路）；
  老式 .doc 是二进制格式，读不了，会明说。

用法：
    python3 scripts/ingest-doc.py <路径> [<路径> ...]
    python3 scripts/ingest-doc.py ~/Downloads/*.pdf --title 茅台研报
    python3 scripts/ingest-doc.py data/reports/xxx.json
"""

import argparse
import hashlib
import json
import os
import random
import re
import sys
import zipfile
from datetime import datetime

OUT_DIR = "data/docs"
# 文本块的目标大小。太小检索命中太碎，太大上下文噪音多。600 字是个经验值。
CHUNK_CHARS = 600
CHUNK_OVERLAP = 80


class IngestError(RuntimeError):
    """文档读不了或根本抽不出内容。**不落盘半个文档。**"""


def doc_id_of(path: str, title: str) -> str:
    """文档 id：标题 slug + 内容哈希前 8 位（同名不同内容不会互相覆盖）。"""
    slug = re.sub(r"[^0-9a-zA-Z一-鿿]+", "-", title).strip("-").lower()[:40]
    return f"{slug or 'doc'}-{hashlib.sha256(path.encode()).hexdigest()[:8]}"


# ── 各种格式 → 带 locator 的文本块 ──────────────────────────────────────


def _chunk_text(text: str, locator_of) -> list:
    """把长文本按段落切成带重叠的块。段落边界优先，不硬切半句。"""
    text = text.replace("\r\n", "\n").strip()
    if not text:
        return []
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks, buf, start_line = [], "", 1
    line_no = 1
    for para in paragraphs:
        lines_in_para = para.count("\n") + 1
        if buf and len(buf) + len(para) + 2 > CHUNK_CHARS:
            chunks.append({"text": buf, "locator": locator_of(start_line, start_line + lines_in_para - 1)})
            # 留一点重叠，避免答案正好被切在边界上
            tail = buf[-CHUNK_OVERLAP:] if len(buf) > CHUNK_OVERLAP else ""
            buf = (tail + "\n\n" + para).strip()
        else:
            buf = (buf + "\n\n" + para).strip() if buf else para
        start_line = line_no
        line_no += lines_in_para
    if buf:
        chunks.append({"text": buf, "locator": locator_of(start_line, line_no)})
    return chunks


def ingest_pdf(path: str) -> tuple[list, dict]:
    """PDF → 块。locator 是页码（从 1 开始）。抽不出内容就抛错，不落盘。"""
    try:
        from pypdf import PdfReader
    except ImportError as exc:
        raise IngestError("没装 pypdf。跑 pip install pypdf（纯 Python，arm64 能装）") from exc
    try:
        reader = PdfReader(path)
    except Exception as exc:
        raise IngestError(f"PDF 读不了：{exc}") from exc
    chunks, total = [], 0
    for index, page in enumerate(reader.pages, start=1):
        try:
            text = page.extract_text() or ""
        except Exception:
            text = ""  # 单页坏掉不影响整份，但要在统计里体现
        text = text.strip()
        if not text:
            continue
        total += len(text)
        for chunk in _chunk_text(text, lambda a, b, p=index: f"第 {p} 页"):
            chunk["page"] = index
            chunks.append(chunk)
    if not chunks:
        raise IngestError(
            "PDF 抽出 0 字。可能是扫描件（图片版，没有文字层）、字体子集化导致无法映射，"
            "或者文件损坏——**这种情况需要 OCR，pypdf 做不到**，先别入库"
        )
    return chunks, {"pages": len(reader.pages), "extractedChars": total, "pagesWithText": len({c["page"] for c in chunks})}


def ingest_docx(path: str) -> tuple[list, dict]:
    """.docx → 块。**docx 就是 zip + XML，零依赖手写**（老 .doc 读不了）。"""
    try:
        archive = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        if path.lower().endswith(".doc"):
            raise IngestError("这是老式 .doc（二进制格式），不是 .docx——需要另行转换，本脚本读不了") from exc
        raise IngestError(f"不是有效的 docx（zip）文件：{exc}") from exc
    if "word/document.xml" not in archive.namelist():
        raise IngestError(f"docx 里没有 word/document.xml：{archive.namelist()[:6]}")
    xml = archive.read("word/document.xml").decode("utf-8", "replace")
    # 段落边界 </w:p>，标签之间可能有 <w:tab/> 之类
    paragraphs = [
        "".join(re.findall(r"<w:t[^>]*>([^<]*)</w:t>", p))
        for p in re.findall(r"<w:p[\s>].*?</w:p>", xml, re.S)
    ]
    text = "\n\n".join(p for p in paragraphs if p.strip())
    chunks = _chunk_text(text, lambda a, b: f"第 {a}-{b} 段")
    if not chunks:
        raise IngestError("docx 里没抽出文字（可能是纯图片或空文档）")
    return chunks, {"paragraphs": len(paragraphs), "extractedChars": len(text)}


def ingest_text(path: str) -> tuple[list, dict]:
    with open(path, encoding="utf-8", errors="replace") as fh:
        text = fh.read()
    chunks = _chunk_text(text, lambda a, b: f"第 {a}-{b} 行")
    if not chunks:
        raise IngestError("文件是空的")
    return chunks, {"extractedChars": len(text)}


def ingest_json(path: str) -> tuple[list, dict]:
    """赤轨自己的研判导出（/reports 存的就是这种 JSON）。按字段切，出处写字段名。"""
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)

    def walk(node, prefix: str, out: list):
        if isinstance(node, str) and len(node.strip()) > 20:
            out.append({"text": node.strip(), "locator": prefix or "根"})
        elif isinstance(node, dict):
            for key, value in node.items():
                walk(value, f"{prefix}.{key}" if prefix else str(key), out)
        elif isinstance(node, list):
            for index, value in enumerate(node[:50]):  # 别把超大数组全塞进来
                walk(value, f"{prefix}[{index}]", out)

    parts: list = []
    walk(data, "", parts)
    chunks = _chunk_text("\n\n".join(p["text"] for p in parts), lambda a, b: "（JSON 字段）")
    if not chunks:
        raise IngestError("JSON 里没有可摄取的文本字段")
    return chunks, {"fields": len(parts), "extractedChars": sum(len(p["text"]) for p in parts)}


INGESTERS = {
    ".pdf": ingest_pdf,
    ".docx": ingest_docx,
    ".txt": ingest_text,
    ".md": ingest_text,
    ".markdown": ingest_text,
    ".json": ingest_json,
}


def ingest_one(path: str, title: str | None) -> dict:
    suffix = os.path.splitext(path)[1].lower()
    if suffix not in INGESTERS:
        raise IngestError(f"不支持的格式 {suffix}（支持 {' '.join(sorted(INGESTERS))}）")
    chunks, stats = INGESTERS[suffix](path)
    name = title or os.path.splitext(os.path.basename(path))[0]
    return {
        "id": doc_id_of(path, name),
        "title": name,
        "sourcePath": os.path.abspath(path),
        "sourceBytes": os.path.getsize(path),
        "format": suffix.lstrip("."),
        "ingestedAt": datetime.now().isoformat(timespec="seconds"),
        "stats": stats,
        "chunks": chunks,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="把研报文档摄入成可检索的块，落盘 data/docs/")
    parser.add_argument("paths", nargs="+", help="文档路径（PDF/docx/md/txt/json）")
    parser.add_argument("--title", help="文档标题（只对单个文件有意义）")
    parser.add_argument("--root", default=os.getcwd())
    args = parser.parse_args()

    out_dir = os.path.join(args.root, OUT_DIR)
    os.makedirs(out_dir, exist_ok=True)
    ok, failed = 0, []
    for path in args.paths:
        if not os.path.exists(path):
            print(f"  ✗ {path}：文件不存在")
            failed.append(path)
            continue
        try:
            doc = ingest_one(path, args.title)
        except IngestError as exc:
            print(f"  ✗ {os.path.basename(path)}：{exc}")
            failed.append(path)
            continue
        target = os.path.join(out_dir, f"{doc['id']}.json")
        # 临时名带 pid + 随机数：固定 .tmp 的话两个进程同时跑会写同一个文件
        tmp = f"{target}.{os.getpid()}.{random.randint(0, 1 << 30):x}.tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(doc, fh, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, target)
        stats = doc["stats"]
        ok += 1
        print(
            f"  ✓ {doc['title']}（{doc['format']}）→ {len(doc['chunks'])} 块 / "
            f"{stats.get('extractedChars', 0)} 字 / {target}"
        )
    if failed:
        print(f"  {ok} 份成功，{len(failed)} 份失败（失败的没落盘，没有半个文档）")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())