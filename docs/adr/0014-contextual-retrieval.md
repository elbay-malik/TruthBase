# ADR-0014: Contextual notes in the chunk embeddings

- **Status:** Accepted
- **Date:** 2026-11-25

## Context

Many chunks don't say where they sit in their document. A table row doesn't name its table, a paragraph says "this hypothesis" or "the critic", and a control ID appears without its function. bge-m3 then embeds the chunk without the words a question uses. In the 2026-11-10 eval, g-029's evidence (Self-RAG pages 7 and 17) never reached the top 15, and several questions sat at ranks 9-14, just past the 8 sources the answer model sees when the reranker is off or out of quota.

Contextual retrieval (Anthropic, 2024) has an LLM write a short note per chunk that places it in its document, and embeds or indexes the note with the chunk. ADR-0003 listed it as a stretch goal, because it needs one LLM call per chunk. At about 1M tokens for 687 chunks, that is five days of a free Groq model's 200K tokens a day, and those quotas are shared with the live demo and the eval judge.

## Decision

1. **One note per corpus chunk, written once, offline.** Claude agents wrote a note for each of the 687 chunks of the four corpus PDFs (one agent per batch of up to 70 chunks, with the whole document as context). A second agent per batch checked every note against the document and fixed 27 of them (wrong section, an unresolved "this", an invented claim). The rules: English, 1-2 sentences, at most 50 words, plain text; start with the document's short name and section; say what the chunk covers in the document's terms, resolving what it leaves implicit (pronouns, undefined abbreviations, which table a fragment belongs to); only facts the document states; no evaluations. The agents read only the document and their batch, never the golden questions or eval data.
2. **The notes ship as data.** `server/ingest/corpus-notes.json` maps each chunk's page and SHA-256 of its exact text to its note (`server/ingest/notes.ts`), as `title.ts` already hard-codes the corpus titles. Keying by page and text means a chunking change drops a note instead of pairing it with other text. RAPTOR repeats a passage on pages 19 and 21, so the page is part of the key.
3. **The note is embedded only.** `embeddingText` puts it between the title and the run context: title, note, context, content. It isn't stored, keyword-indexed or shown to the answer model.
4. **Re-embedding keeps chunk ids.** `pnpm ingest:golden --reembed` recomputes every corpus vector from the stored text and the notes. It writes only once every vector is computed, so shared citation links keep working.

## Measurement

`pnpm eval:retrieval`, question only, 45 answerable golden questions, 687 chunks. Offline, on a local copy with three sets of chunk ids (tie-breaks, ADR-0003), mean:

| Note used in | recall@5 | recall@8 | recall@10 | recall@15 | MRR |
|---|---|---|---|---|---|
| nothing (before) | 73% | 82% | 88% | 91% | 0.563 |
| **embedding** | **77%** | **91%** | **91%** | **93%** | **0.581** |
| embedding and keyword arm | 73% | 86% | 86% | 87% | 0.606 |
| keyword arm only | 75% | 81% | 82% | 84% | 0.600 |

In the keyword arm the notes' shared words ("Section", "paper", "describes") match too many chunks: g-005, g-030 and g-031 fell out of the top 15.

The hosted corpus after `--reembed` (the gate's new [retrieval-baseline.json](../evals/retrieval-baseline.json)): recall@5 73%, recall@8 91% (41/45, was 37), recall@10 91%, recall@15 93% (42/45, was 41), MRR 0.564, nDCG@5 0.609 (was 0.615). g-040 moved from rank 12 to 6, g-022 from 9 to 6, g-030 from 7 to 4, and g-026 from outside the top 15 to 5. g-029's evidence is still not retrieved. Dense-only rose further (ADR-0006).

## Rationale

The notes fix the measured failure, chunks that lack the words of their context, at the one place it occurs, the embedding. Nothing changes at query time: no extra model call, no latency, and no free-tier quota. Writing the notes with Claude agents was a one-off cost outside the demo's free tiers. The notes are committed and reviewable, and `--reembed` reproduces the vectors from them.

## Rejected alternatives

- **Notes from the production models (Groq gpt-oss-20b or qwen):** about five days of a model's daily quota, which the live demo's rewriting and reranking or the eval judge would otherwise use. Notes from a smaller model would likely help less than what was measured here.
- **Cloudflare Workers AI:** the 10,000 daily Neurons also pay for every question's embedding and the answer fallback.
- **Notes in the keyword arm:** measured above. They lower recall at every depth.
- **Storing notes in `chunks`:** a migration for text only the embedding needs. The JSON file is the record.

## Consequences

- **Uploads get no notes.** `chunkNote` returns '' for any other PDF, so an uploaded document is embedded as before. Bring-your-own-docs (Phase 11b) would need a note generator in the ingest pipeline and its own measurement.
- **A chunking or extraction change stales the notes.** A changed chunk loses its note silently at ingest. `pnpm ingest:golden --reembed` refuses to run while any corpus chunk has no note. New notes then need the same write-and-check pass.
- **The numbers are a best case for model-written notes:** Claude wrote and checked them. A cheaper generator should be measured, not assumed equal.
- Revisit if the corpus changes, or before uploads open.
