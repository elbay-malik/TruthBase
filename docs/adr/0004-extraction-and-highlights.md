# ADR-0004: PDF extraction and the highlight coordinate model

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Clicking a citation must scroll to the cited page and highlight the passage at any zoom level. The highlight geometry has to be captured at ingestion, because retrofitting it later means re-parsing every PDF. Ingestion runs server-side, with no DOM and no canvas in the Nitro runtime.

## Decision

1. **Extraction (`server/ingest/extract.ts`).** `unpdf`'s `extractTextItems` returns PDF.js text items with their position (`x`, `y` = baseline origin, PDF space, bottom-left origin), `width`, `fontSize` and `hasEOL`. Page text is rebuilt exactly like `unpdf`'s `extractText` (item strings, plus `\n` when `hasEOL`), whitespace-collapsed. Every normalized character keeps a pointer to its source item and offset (`charItem`, `charOffset`).
2. **Highlight model (`server/ingest/highlight.ts`).** A chunk's character range becomes **one rect per rendered line** in PDF space at scale 1. These are stored in `chunks.highlight` as the `ChunkHighlight` shape (`rects[]`, `boundingRect`, `pageWidth/Height`, `startOffset/endOffset`, `usePdfCoordinates: true`).
   - **Line grouping:** consecutive items stay on one line while they share a baseline. A new line starts when x jumps backwards or across a column-sized gap, so two-column papers never get a rect spanning the gutter.
   - **Glyph box:** from baseline − 0.25·fontSize to baseline + 0.8·fontSize. PDF.js `item.height` is often 0 or the full line advance.
   - **Partial items** (a chunk starting or ending mid-item) are cut in proportion to character count.
3. **View time (Phase 5).** Convert each rect's two corners with `viewport.convertToViewportPoint` and redraw on every zoom or rotation. (`convertToViewportRectangle` no longer exists in the bundled PDF.js; see TECH_NOTES §7.)
4. **Verification.** `pnpm render:highlights <golden ids>` renders the page with both the chunk rects and the exact evidence-span rects drawn through the same viewport conversion as the viewer.

## Rationale

- PDF-space storage is resolution-independent. Pixels would be wrong at every other zoom level.
- Keeping the character→item map makes highlighting a pure function of `(page layout, character range)`, so evidence spans, chunks and future sub-chunk citations all use the same code.
- Checked visually on a single-column standards page (CSF p. 28), two-column body text (RAPTOR p. 3), a results table (Self-RAG p. 8, Table 2) and a span starting mid-line (AI RMF p. 22). Lines, columns and table rows were all boxed correctly.

## Known limitations

- **Partial-item ends can be off by about 1–2 glyphs.** The proportional cut ignores glyph widths: "(GMMs)" may end at "(GMM". Whole lines are exact. Planned fix: in Phase 5 the viewer measures exact glyph edges from the PDF.js text layer (a DOM `Range` over the chunk's offsets) and uses the stored rects as the fallback.
- Rotated pages and vertical text (`dir: 'ttb'`) are not handled. None appear in the demo corpus.
- Scanned PDFs have no text layer. Ingestion rejects them at the `parse` stage before any embedding calls.

## Rejected alternatives

- **Rendering and measuring server-side with a canvas:** needs native `@napi-rs/canvas` in the Nitro runtime, which isn't available on Workers. It's kept as a dev-only dependency for `render:highlights`.
- **Storing only character offsets and computing rects in the browser:** the plan's offline E2E and eval fixtures need geometry without a browser, and the risk register calls for stored rects plus a text-match fallback.
- **One bounding box per chunk:** covers unrelated text in two-column layouts and between table rows.
