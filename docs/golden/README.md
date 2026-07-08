# Golden dataset (Phase 0)

The golden Q&A set is the project's ground truth: it drives retrieval/generation evals (promptfoo, Phase 9) **and** doubles as fixtures for the citation-to-highlight E2E tests (Phase 13). Target: 3–5 public, redistributable demo PDFs and ~30–50 hand-authored Q&A pairs with known supporting passages.

## Record schema

Stored as `golden.json` (array of records) in this directory; a CSV export is acceptable for spreadsheet editing but JSON is canonical.

```jsonc
{
  "id": "g-001",                    // stable unique id, referenced by evals and E2E tests
  "question": "What is ...?",
  "answer": "The reference answer, grounded in the supporting text.",
  "document": "example.pdf",        // filename under docs/golden/pdfs/
  "page": 4,                        // 1-based page number of the supporting passage
  "supporting_text": "Exact quote from the PDF that supports the answer.",
  "chunk_hint": "optional substring to disambiguate when supporting_text appears more than once",
  "tags": ["ambiguous", "multi-hop"] // optional; used to slice eval metrics
}
```

Notes:
- `supporting_text` must be an **exact** substring of the PDF's extracted text (it is used to verify highlight rects by text match).
- Include some deliberately unanswerable questions (`answer: null`, no supporting fields) to test grounded refusal.
- Include some ambiguous phrasings (tag `ambiguous`) to measure Phase 8 multi-query expansion.
- Demo PDFs go in `docs/golden/pdfs/` and must be public and redistributable — record each file's source and license in this README when added.
