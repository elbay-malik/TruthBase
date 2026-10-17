# ADR-0004: PDF extraction and the highlight coordinate model

- **Status:** Accepted. Amended 2026-10-17 by the Phase 3.5 spike: glyph-exact edges replace the proportional cut, and the planned text-layer refinement is rejected.
- **Date:** 2026-10-16

## Context

Clicking a citation must scroll to the cited page and highlight the passage at any zoom level. The highlight geometry has to be captured at ingestion, because retrofitting it later means re-parsing every PDF. Ingestion runs server-side, with no DOM and no canvas in the Nitro runtime.

## Decision

1. **Extraction (`server/ingest/extract.ts`).** Per page, `page.getTextContent()` items, with the same order and filter as `unpdf`'s `extractTextItems`. Each item carries its baseline origin (`x`, `y` = `transform[4]`, `transform[5]`, in PDF space with a bottom-left origin), `width`, `fontSize` (`hypot(transform[2], transform[3])`), `hasEOL` and `fontName`. Page text is rebuilt exactly like `unpdf`'s `extractText` (`shared/utils/page-text.ts`, the golden matching contract), and every normalized character keeps a pointer to its source item and offset (`charItem`, `charOffset`). The browser viewer builds the same map over the PDF.js text layer, so character offsets mean the same thing on both sides; this was verified 180/180 in the spike.
2. **Glyph positions (`server/ingest/glyphs.ts`).** The page's operator list is replayed with PDF.js's own `showText` advance math, mirroring `CanvasGraphics` in pdfjs-dist 6.4.299: text matrix, CTM, `Tc`/`Tw`/`Tz`, `TJ` kerning, font matrix, rise, negative-size font direction, ExtGState `/Font` and vertical-font advances. The replay is skipped on pages without text. That gives every glyph's x-extent. Glyphs are aligned to items by font, baseline, x-range and NFKC character sequence. An item gets per-character positions (`charX0`/`charX1`) only when the aligned glyphs reproduce the item's own start and width within 0.5 pt. Vertical writing, failed alignments and the like keep a proportional fallback.
3. **Highlight model (`server/ingest/highlight.ts`).** A chunk's character range becomes **one rect per rendered line**, in PDF space at scale 1, stored in `chunks.highlight` as `ChunkHighlight`.
   - **Horizontal:** exact glyph edges where available, otherwise a proportional cut by character count.
   - **Vertical:** baseline − 0.25·fontSize to baseline + 0.8·fontSize, because PDF.js `item.height` is often 0 or the full line advance.
   - **Line grouping:** consecutive items stay on one line while they share a baseline (±0.5·size), don't jump back, and aren't across a column gap (3·size).
4. **View time (Phase 5).** Convert each rect's two corners with `viewport.convertToViewportPoint`, since PDF.js 6 has no `convertToViewportRectangle`, and redraw on every zoom or rotation. **Draw the stored rects as they are**; don't re-derive them from the text layer.
5. **Verification.**
   - `test/unit/ingest-glyphs.test.ts` holds every golden span's start and end edge to **MuPDF**'s glyph positions (`scripts/glyph_edges.py`, an independent engine) within ±0.05 pt.
   - `pnpm spike:highlight` checks screen placement and ink coverage in Chromium.
   - `pnpm render:highlights` renders server-side previews.

## Spike results (Phase 3.5, headless Chromium 149, dpr 2, 60 golden spans × zoom 0.5/1/2)

| Check | Result |
|---|---|
| Text-layer characters at stored offsets equal the golden quote | 180/180 |
| Pages rotated, with an offset origin, or size-mismatched vs stored `pageWidth/Height` | 0/40 |
| PDF.js worker | real module worker (no fake-worker fallback) under the `/spike` CSP |
| Edge error where the text layer is exact (an item's first character, or the last character of a multi-character item; n=53) | median 0.00 pt, max 0.6 pt, **identical at all zooms**, so the PDF→screen conversion is exact |
| Span edges vs MuPDF glyph positions (n=120) | proportional cut: median 0.15, p90 6.6, **max 15.6 pt** (3 glyphs) → glyph replay: **max 0.001 pt** |
| Items with exact glyph positions | 10,919 / 10,959 (99.6%); extraction cost ~9 ms/page |
| Vertical ink coverage of stored line rects (canvas pixels) | 0/117 lines without ink at every zoom; mean 0.996 / 0.999 at zoom 1 / 2. The one outlier is a vector-drawn frame around an inline "Critique" token, not text. At zoom 0.5, ≤ 1 device px of anti-aliasing |
| Box margins around the ink | ~1.3 pt above, 0.5–1 pt below |

## Rationale

- PDF-space storage is resolution-independent; the spike confirms the conversion adds no error at any zoom.
- Keeping the character→item map makes highlighting a pure function of `(page layout, character range)`. Evidence spans, chunks and future sub-chunk citations all go through the same code.
- The glyph replay reuses the PDF.js build that already parses the document. It's exact against an independent engine, and when it can't align an item it degrades to the old behaviour instead of failing.

## Rejected alternatives

- **Refining partial-item edges from the browser text layer (the original plan in this ADR).** The text layer places characters inside an item with a *substitute* font (generic sans-serif or monospace), scaled so only the item's total width matches. Measured against MuPDF it's median 1.3 pt off and up to 18.6 pt, worse than the proportional cut on 29% of mid-item edges. It also makes highlights jump when the layer finishes rendering, and depends on text-layer state, ligatures and RTL handling.
- **Using the text layer as ground truth for accuracy metrics.** Its vertical box is the fallback font's em box rounded to whole CSS pixels, which made the spike's first IoU numbers drift with zoom (0.80 → 0.88) while the stored geometry was identical. It's valid only at item boundaries.
- **Raising the box to the text layer's height (ascent ≈ 0.97 em):** it would make 40–94% of consecutive line rects overlap, depending on the document, and the 0.8/0.25 box already covers the ink.
- **Font advance widths only, without the full replay:** median 0.41 pt, but up to 12 pt off, because it ignores `Tw` and `TJ`.
- **Rendering and measuring server-side with a canvas:** needs native `@napi-rs/canvas` in the Nitro runtime, which isn't available on Workers. Kept as a dev-only dependency for previews.
- **One bounding box per chunk:** covers unrelated text in two-column layouts and between table rows.

## Known limitations

- Rotated pages, vertical text (`dir: 'ttb'`), RTL, Type3 fonts and ligatures at span edges are absent from the golden set. They fall back to the proportional cut when the replay can't align, but the behaviour is unverified. Add golden spans for them before relying on it.
- `getOperatorList` also decodes images, about 60× the cost of `getTextContent` on JPEG-heavy pages. Text-less pages (scans) skip the replay, but text pages with large images still pay. Measure in the Workers runtime (Phase 14) and add a per-page time budget if needed.
- Table rows are highlighted as one continuous bar, including the whitespace between cells. That's a product choice, and it reads well.
- Scanned PDFs have no text layer and are rejected at the `parse` stage.
