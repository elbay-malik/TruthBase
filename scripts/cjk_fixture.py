# /// script
# requires-python = ">=3.12"
# dependencies = ["pymupdf==1.26.5"]
# ///
"""Builds test/fixtures/cjk-cmap.pdf: CJK text in non-embedded CID fonts that
rely on predefined CMaps (UniGB-UTF16-H, UniJIS-UTF16-H). PDF.js can only
extract that text when its CMap files are available, so the fixture catches a
server bundle that ships without them (server/ingest/pdf-assets.ts).

    uv run scripts/cjk_fixture.py
"""

from pathlib import Path

import pymupdf

OUT = Path(__file__).resolve().parent.parent / "test/fixtures/cjk-cmap.pdf"

doc = pymupdf.open()
page = doc.new_page()
# MuPDF's built-in CJK names write a Type0 font with a predefined Unicode CMap
# and no embedded font program (the reader supplies both).
page.insert_text((72, 100), "可验证的检索增强生成", fontname="china-s", fontsize=16)
page.insert_text((72, 140), "検証可能な検索拡張生成", fontname="japan", fontsize=16)
doc.save(OUT, garbage=4, deflate=True)
print(OUT)
