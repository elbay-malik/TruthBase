# Evals

How TruthBase is measured on the [golden set](../golden/golden.json) (50 records: 45 answerable, 5 unanswerable). Metric definitions are in [SPEC](../SPEC.md#acceptance-metrics); the methodology and the CI gate are in [ADR-0008](../adr/0008-evals-and-ci-gate.md).

## The two gates

| | Retrieval gate | LLM eval |
|---|---|---|
| Command | `pnpm eval:retrieval --install` | `pnpm eval:llm && pnpm eval:llm:summary` |
| Runs | Every PR and push to main (CI `db` job) | Manually and weekly (`llm-eval` workflow) |
| Measures | recall@5/8/10/15, MRR, nDCG@5 (ideal: every relevant chunk in the database) of `hybrid_search_bge_m3` | Faithfulness, citation precision, answer relevance, refusals, of the full pipeline |
| Needs | Postgres with the migrations (local Docker or CI) | `.env` values (Groq, Cloudflare, Supabase); ~300K Groq tokens per full run |
| Baseline | `retrieval-baseline.json`, no tolerance; record count must match | `llm-baseline.json`, tolerance 0.05, plus SPEC targets; written only by a passing full run |

## Commands

```bash
# Retrieval gate locally (Postgres on :54329, see scripts/tune-retrieval.ts).
# --install replaces all documents; it refuses a non-local database without --allow-remote.
pnpm eval:retrieval --install
pnpm eval:retrieval --install --update-baseline   # accept an intended change

# After re-ingesting the corpus or editing golden questions
pnpm fixtures:retrieval

# LLM eval (resumes from .cache/models after a spent daily quota). eval:llm exits 0
# when assertions fail or rows error; the summary gates both. Only a crash or a spent
# quota (2) stops it before the summary.
pnpm eval:llm && pnpm eval:llm:summary [--update-baseline]
GOLDEN_ONLY=g-001,g-013 pnpm eval:llm               # a slice
pnpm dlx promptfoo@0.124.1 view                    # browse results

# Technique-level evals (phases 6–8); these now embed with bge-m3 through Cloudflare
pnpm tune:retrieval      # hybrid weights and RRF grid (ADR-0006)
pnpm eval:rerank         # reranker vs fused order (ADR-0007)
pnpm eval:multiquery     # multi-query expansion (ADR-0009)
pnpm eval:answers --label <name>   # answers + citations, the pre-promptfoo eval

# Production traces → golden-set candidates (Langfuse, Phase 10)
pnpm sample:traces --days 7        # writes .cache/golden-candidates.json for curation
```

## Files here

- `retrieval-baseline.json`, `llm-baseline.json`: what the gates compare against. `retrieval-baseline.json` is bge-m3 with question-only retrieval: recall@5/8/10/15 33 / 34 / 34 / 38 of 45, MRR 0.548, nDCG@5 0.640. There is no `llm-baseline.json` yet. The first full LLM run (2026-10-23) is kept as `phase-9-llm.json` (same fields): it met the faithfulness and citation precision targets by the judge's scoring but had 4 false refusals (≤ 1), and a hand check found the judge lenient ([ADR-0008](../adr/0008-evals-and-ci-gate.md)).
- `retrieval-baseline-gemini.json`: the gate's baseline before the switch, kept for comparison. No gate reads it.
- `bge-m3-cutover.json`: the go/no-go for leaving Gemini, 2026-11-02 to 2026-11-03 ([ADR-0013](../adr/0013-leaving-gemini.md)). The harness was a one-off and is not in this repo; `pnpm eval:llm` measures the same pipeline going forward.
- `phase-*.json`: the measurements behind each phase's ADR. They all used Gemini embeddings (`gemini-embedding-001`, 768 dims) and were not re-run on bge-m3, so they are dated history, not current numbers.
