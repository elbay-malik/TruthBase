# ADR-0003: Chunking strategy and sizes

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Phase 3 splits each PDF into chunks that are embedded, retrieved, cited and highlighted. Chunk size trades retrieval context against citation precision: the highlight a user sees after clicking a citation **is** the chunk, so a 2,000-character chunk highlights half a page.

Constraints:
- `ChunkRecord` has a single `pageNumber` and one set of highlight rects (`shared/types`).
- Chunk text must be a substring of the normalized page text that the golden set is verified against (`docs/golden/README.md`). Normalization collapses all whitespace, so no line or paragraph breaks survive.
- Gemini embedding input is capped at 2,048 tokens. Every candidate below is far under it.

## Decision

`server/ingest/chunk.ts`, with defaults in `DEFAULT_CHUNK_OPTIONS`:

- **Page-bounded.** A chunk never crosses a page.
- **Sentence packing.** Split at sentence ends (`. ! ?` plus an optional closing quote or bracket), pack sentences greedily up to **`maxChars` = 800** (~200 tokens, roughly a paragraph), and split an over-long sentence at word boundaries (hard cut if a single token is longer).
- **Overlap.** The next chunk restarts with up to **`overlapChars` = 120** (15%) of whole trailing sentences.
- A final chunk under **`minChars` = 150** is merged into the previous one, so a chunk can reach `maxChars + minChars`.

## Rationale

Measured on the 4 golden PDFs (133 pages) with no embeddings needed. The criterion is whether each golden evidence span (60 spans) falls inside a single chunk: a span split across chunks can't be cited or highlighted as one passage.

| maxChars | overlap | spans in one chunk | records fully covered | chunks | avg chars |
|---|---|---|---|---|---|
| 600 | 15% | 57/60 (95%) | 42/45 | 757 | 487 |
| **800** | **15%** | **60/60 (100%)** | **45/45** | **568** | **659** |
| 1000 | 15% | 59/60 (98%) | 44/45 | 462 | 816 |
| 1200 | 15% | 59/60 (98%) | 44/45 | 387 | 987 |
| 1600 | 15% | 60/60 (100%) | 45/45 | 310 | 1241 |
| 2000 | 15% | 60/60 (100%) | 45/45 | 258 | 1489 |

800/15% is the smallest setting with full containment. Larger chunks don't improve containment but blunt the highlight, and the plan's 512-token default (~2,000 chars) would mark half a page. 568 chunks cost nothing in storage (~2 MB of vectors) or embedding quota.

Containment is a proxy, not retrieval quality. `test/unit/ingest-chunk.test.ts` locks in 100% containment; recall@k (Phase 6) decides whether to revisit.

## Rejected alternatives

- **Recursive 512-token splitting** (the plan's default): highlights too coarse for passage-level citations. See the table above.
- **Cross-page chunks:** would need multi-page highlights and break the one-page `ChunkRecord`. A sentence that wraps across a page break is split instead.
- **Semantic chunking:** embedding-distance boundaries are ~14× slower and spend free-tier embedding quota at ingest.
- **Late chunking / contextual retrieval:** contextual retrieval needs an LLM call per chunk. It's a stretch goal.
- **Stripping running headers and footers:** they pollute some chunks (e.g. "NIST CSWP 29 … CSF 2.0", page numbers), but removing them would break the golden text contract. Revisit if recall@k suffers.

## Consequences

- Highlights are paragraph-sized and always on one page.
- Sentence detection over-splits on abbreviations ("e.g.", "et al."), which is harmless because pieces are re-packed.
- Changing the defaults means re-ingesting every document. The containment test fails first if a change splits golden spans.
