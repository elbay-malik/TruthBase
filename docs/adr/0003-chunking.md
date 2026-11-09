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
- **Overlap.** The next chunk restarts with up to **`overlapChars` = 300** of whole trailing sentences (120 until 2026-11-09, see the update below).
- **Run context.** A chunk that starts inside an over-long run that had to be cut at word boundaries (in practice a table, which has no sentence ends) gets `context`: up to **`contextChars` = 240** of the run's opening, cut at a word boundary. It is stored in `chunks.context`, embedded after the title, searched by the keyword arm and shown to the reranker and the answer model. The chunk's own text and highlight are unchanged.
- A final chunk under **`minChars` = 150** is merged into the previous one, so a chunk can reach `maxChars + minChars`.

## Rationale

Measured on the 4 golden PDFs (133 pages) with no embeddings needed. The criterion is whether each golden evidence span (60 spans) falls inside a single chunk: a span split across chunks can't be cited or highlighted as one passage.

| maxChars | overlap | spans in one chunk | records fully covered | chunks | avg chars |
|---|---|---|---|---|---|
| 600 | 15% | 57/60 (95%) | 42/45 | 746 | 494 |
| **800** | **15%** | **60/60 (100%)** | **45/45** | **564** | **663** |
| 1000 | 15% | 59/60 (98%) | 44/45 | 463 | 814 |
| 1200 | 15% | 59/60 (98%) | 44/45 | 392 | 975 |
| 1600 | 15% | 60/60 (100%) | 45/45 | 313 | 1230 |
| 2000 | 15% | 60/60 (100%) | 45/45 | 264 | 1457 |

Re-measured 2026-10-18 after the fix that stops a chunk from being a strict subset of the previous one (when the overlap plus the next sentence would exceed `maxChars`, the overlap is cut instead); the first run gave 568 chunks at 800. Containment and the choice did not change.

800/15% is the smallest setting with full containment. Larger chunks don't improve containment but blunt the highlight, and the plan's 512-token default (~2,000 chars) would mark half a page. 564 chunks cost nothing in storage (~2 MB of vectors) or embedding quota.

Containment is a proxy, not retrieval quality. `test/unit/ingest-chunk.test.ts` locks in 100% containment; recall@k (Phase 6) decides whether to revisit.

## Update 2026-11-09: overlap 300 and run context

The LLM eval showed two failures that came from chunk boundaries. A training-hardware sentence was the last full sentence before a ~150-character one, so a 120-character overlap never carried it into the next chunk. And a table's rows were split from its header row, so the answer model couldn't tell which column a number came from: with the old prompt it answered with a number from the wrong column.

Measured with the offline retrieval gate on a local database (`hybrid_search_bge_m3`, 45 answerable records, k = 15). Every setting was re-chunked and embedded with bge-m3. Search breaks ties by chunk id, so new ids alone move recall by about 2 points; each row is the mean of three id sets.

| overlap | context | chunks | recall@8 | recall@10 | recall@15 | MRR |
|---|---|---|---|---|---|---|
| 120 | none | 564 | 75.6% | 77.0% | 82.9% | 0.547 |
| 120 | 240 | 564 | 77.8% | 79.3% | 82.9% | 0.559 |
| 200 | 240 | 612 | 72.6% | 72.6% | 80.7% | 0.599 |
| **300** | **240** | **687** | **80.7%** | **85.9%** | **89.6%** | **0.548** |
| 400 | 240 | 789 | 79.3% | 82.2% | 91.1% | 0.569 |

300 is best at recall@8 and @10, the depths the answer and the reranker see. 400 gains a little at @15 for 100 more chunks. nDCG@5 is left out: its ideal counts every chunk that holds an evidence span, and more overlap makes more chunks hold one, so it isn't comparable across overlaps. Containment stays 60/60. 24 chunks get a context.

## Rejected alternatives

- **Recursive 512-token splitting** (the plan's default): highlights too coarse for passage-level citations. See the table above.
- **Cross-page chunks:** would need multi-page highlights and break the one-page `ChunkRecord`. A sentence that wraps across a page break is split instead.
- **Semantic chunking:** embedding-distance boundaries are ~14× slower and spend free-tier embedding quota at ingest.
- **Late chunking / contextual retrieval:** contextual retrieval needs an LLM call per chunk. It's a stretch goal. Run context (above) is the rule-based part of it.
- **Neighbouring chunks in the answer prompt:** fixes the same failures at query time, but about triples the answer prompt for every question.
- **Stripping running headers and footers:** they pollute some chunks (e.g. "NIST CSWP 29 … CSF 2.0", page numbers), but removing them would break the golden text contract. Revisit if recall@k suffers.

## Consequences

- Highlights are paragraph-sized and always on one page.
- Sentence detection over-splits on abbreviations ("e.g.", "et al."), which is harmless because pieces are re-packed.
- CJK `。！？` also end a sentence, with no space needed after them. Chunks of the Latin golden corpus are unchanged (verified byte-identical).
- Changing the defaults means re-ingesting every document. The containment test fails first if a change splits golden spans.
