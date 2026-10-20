# Golden dataset (Phase 0)

The golden Q&A set is the project's ground truth. It drives the retrieval and generation evals (promptfoo, Phase 9) **and** doubles as fixtures for the citation-to-highlight E2E tests (Phase 13). It contains 4 public, redistributable demo PDFs and **50 hand-authored Q&A pairs** with known supporting passages.

`golden.json` is canonical and is checked by [`test/unit/golden.test.ts`](../../test/unit/golden.test.ts). The test fails CI if any evidence quote stops being a verbatim substring of its page.

## Record schema

```jsonc
{
  "id": "g-001",                   // stable unique id (g-NNN), referenced by evals and E2E tests
  "question": "What is ...?",
  "answer": "Reference answer, grounded in the evidence.",   // null = unanswerable
  "evidence": [                    // every span needed for a complete answer; [] when unanswerable
    {
      "document": "example.pdf",   // filename under docs/golden/pdfs/
      "page": 4,                   // 1-based PHYSICAL page index (what PDF.js uses), not the printed page label
      "text": "Exact quote from that page."
    }
  ],
  "tags": ["paraphrase"]           // used to slice eval metrics (see below)
}
```

`evidence` is an array because answers can need several spans, on different pages or in different documents (multi-span, multi-page, cross-document questions). Retrieval recall for a record means the retrieved chunks cover **all** of its evidence spans.

## Matching rules (the contract with Phase 3)

- **Page text** = `unpdf` `extractText(pdf, { mergePages: false })` for that page, with all whitespace runs collapsed to one space, other control characters (C0/C1, DEL) dropped, and the result trimmed.
- **`evidence.text`** must be an exact substring of that page text. Curly quotes (`’ “ ”`) and en dashes (`–`) are kept as the PDF encodes them.
- Quotes avoid words hyphenated at a line break (`recommenda- tion`), because the extracted text keeps the break.
- If the Phase 3 chunker changes the normalization (e.g. de-hyphenation), update this rule and the test together. Otherwise highlight and recall matching drift apart.
- **Physical vs printed pages:** the AI RMF's printed "Page 4" is physical page 9. Always use the physical index.

## Composition

| Source | Records |
|---|---|
| NIST AI RMF 1.0 | 12 |
| NIST CSF 2.0 | 11 |
| Self-RAG | 10 |
| RAPTOR | 8 |
| Cross-document (2+ PDFs) | 4 |
| Unanswerable | 5 |
| **Total** | **50** |

## Tags

| Tag | Meaning | Exercises |
|---|---|---|
| `factoid`, `definition`, `list`, `numeric`, `yes-no` | Answer shape | Generation accuracy |
| `keyword` | Hinges on an exact identifier (`PR.DS-11`, `GOVERN 1.6`) | Full-text arm of hybrid search (Phase 6) |
| `paraphrase` | Question shares few words with the passage | Dense arm of hybrid search (Phase 6) |
| `reverse-lookup`, `distractor` | Identifier must be found from its description; near-duplicate passages nearby | Reranking (Phase 7) |
| `ambiguous` | Vague or underspecified phrasing ("What are the tiers?") | Multi-query expansion (Phase 8) |
| `multi-span`, `multi-page`, `cross-document`, `multi-hop`, `comparison` | Needs more than one passage | Recall@k, citation completeness |
| `table`, `figure-caption`, `figure-reference`, `front-matter` | Evidence sits in hard-to-extract layout | Ingestion + highlight rects (Phases 3, 5) |
| `duplicate-passage` | Same text also appears elsewhere (e.g. glossary); the canonical page is listed | Highlight/eval tolerance |
| `unanswerable`, `near-miss`, `false-premise` | No supporting text exists; `near-miss` sounds answerable from the corpus | Grounded refusal (Phase 4) |

## Demo PDFs

All four are public and redistributable. They mix single-column government prose and tables with two-column academic layout, to stress-test highlighting.

| File | Document | Source | License | Pages | SHA-256 (prefix) |
|---|---|---|---|---|---|
| `nist-ai-rmf-1.0.pdf` | NIST AI 100-1, *Artificial Intelligence Risk Management Framework (AI RMF 1.0)*, Jan 2023 | <https://doi.org/10.6028/NIST.AI.100-1> | US Government work: not subject to copyright in the US (17 U.S.C. §105) | 48 | `7576edb5` |
| `nist-csf-2.0.pdf` | NIST CSWP 29, *The NIST Cybersecurity Framework (CSF) 2.0*, Feb 2024 | <https://doi.org/10.6028/NIST.CSWP.29> | US Government work: not subject to copyright in the US (17 U.S.C. §105) | 32 | `3c31f46f` |
| `self-rag.pdf` | Asai et al., *Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection* (arXiv:2310.11511v1) | <https://arxiv.org/abs/2310.11511> | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 30 | `d9eaa139` |
| `raptor.pdf` | Sarthi et al., *RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval* (arXiv:2401.18059v1) | <https://arxiv.org/abs/2401.18059> | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | 23 | `01319e2e` |

The PDFs are committed unmodified. Credit for the CC BY works goes to their authors as listed above.

## Adding or editing records

1. Copy the quote from the extracted page text, not from a PDF viewer. Viewers render ligatures and hyphenation differently. Running `unpdf` on the page is the quickest way to get it.
2. Keep ids stable. Append new ids rather than renumbering, because evals and E2E tests reference them.
3. Run `pnpm test`. The golden test lists every quote that no longer matches.
