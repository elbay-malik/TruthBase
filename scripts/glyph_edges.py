# /// script
# requires-python = ">=3.12"
# dependencies = ["pymupdf==1.26.5"]
# ///
"""Independent glyph-position reference for highlight edges.

For every span in test/fixtures/highlight-spans.json, records the x-position
of its first character's left edge and last character's right edge as MuPDF
lays them out. This is a different PDF engine from PDF.js, so it checks
server/ingest's glyph math without sharing any of its code.

    uv run scripts/glyph_edges.py      # writes test/fixtures/glyph-edges.json

Coordinates are PDF user space (bottom-left origin), like the stored rects.
"""

import json
import re
from pathlib import Path

import pymupdf

ROOT = Path(__file__).resolve().parent.parent
FIXTURES = ROOT / "test/fixtures/highlight-spans.json"
OUT = ROOT / "test/fixtures/glyph-edges.json"
PDFS = ROOT / "docs/golden/pdfs"


def page_chars(page: pymupdf.Page) -> list[dict]:
    """Non-whitespace characters in MuPDF reading order, with PDF user-space x/baseline.

    MuPDF reports coordinates relative to the top-left of the (rotated)
    CropBox; ~page.transformation_matrix maps them back to PDF user space,
    the space PDF.js items and the stored rects use.
    """
    to_user = ~page.transformation_matrix
    chars = []
    raw = page.get_text("rawdict", flags=pymupdf.TEXT_PRESERVE_WHITESPACE | pymupdf.TEXT_PRESERVE_LIGATURES)
    for block in raw["blocks"]:
        for line in block.get("lines", []):
            for span in line["spans"]:
                for ch in span["chars"]:
                    if ch["c"].isspace():
                        continue
                    x0, _, x1, _ = ch["bbox"]
                    origin_y = ch["origin"][1]
                    left = pymupdf.Point(x0, origin_y) * to_user
                    right = pymupdf.Point(x1, origin_y) * to_user
                    chars.append({"c": ch["c"], "x0": min(left.x, right.x), "x1": max(left.x, right.x), "baseline": left.y})
    return chars


def find_edges(chars: list[dict], text: str) -> tuple[dict, dict] | None:
    """Locate `text` (ignoring whitespace) as a contiguous run of MuPDF chars."""
    target = re.sub(r"\s+", "", text)
    stream = "".join(c["c"] for c in chars)
    at = stream.find(target)
    if at == -1 or stream.find(target, at + 1) != -1:
        return None  # missing or ambiguous: skip rather than guess
    return chars[at], chars[at + len(target) - 1]


def main() -> None:
    fixtures = json.loads(FIXTURES.read_text())
    docs: dict[str, pymupdf.Document] = {}
    out, skipped = [], []
    for f in fixtures:
        doc = docs.setdefault(f["document"], pymupdf.open(PDFS / f["document"]))
        page = doc[f["page"] - 1]
        if page.rotation != 0:
            skipped.append(f"{f['id']} (rotated page: stored rects assume horizontal text)")
            continue
        edges = find_edges(page_chars(page), f["text"])
        if edges is None:
            skipped.append(f["id"])
            continue
        first, last = edges
        out.append({
            "id": f["id"],
            "startX": round(first["x0"], 3),
            "endX": round(last["x1"], 3),
            "startBaseline": round(first["baseline"], 3),
            "endBaseline": round(last["baseline"], 3),
        })
    OUT.write_text(json.dumps({"engine": f"PyMuPDF {pymupdf.VersionBind}", "edges": out, "skipped": skipped}, indent=1) + "\n")
    print(f"wrote {len(out)} spans ({len(skipped)} skipped: {skipped}) -> {OUT}")


if __name__ == "__main__":
    main()
