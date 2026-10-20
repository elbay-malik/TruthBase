# Evals

How TruthBase is measured on the [golden set](../golden/golden.json) (50 records: 45 answerable, 5 unanswerable). Metric definitions are in [SPEC](../SPEC.md#acceptance-metrics); the methodology and the CI gate are in [ADR-0008](../adr/0008-evals-and-ci-gate.md).

## The two gates

| | Retrieval gate | LLM eval |
|---|---|---|
| Command | `pnpm eval:retrieval --install` | `pnpm eval:llm && pnpm eval:llm:summary` |
| Runs | Every PR and push to main (CI `db` job) | Manually and weekly (`llm-eval` workflow) |
| Measures | recall@5/8/10/15, MRR, nDCG@5 (ideal: every relevant chunk in the database) of `hybrid_search` | Faithfulness, citation precision, answer relevance, refusals, of the full pipeline |
| Needs | Postgres with the migrations (local Docker or CI) | `.env` keys; ~300K Groq tokens per full run |
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

# Technique-level evals (phases 6–8)
pnpm tune:retrieval      # hybrid weights and RRF grid (ADR-0006)
pnpm eval:rerank         # reranker vs fused order (ADR-0007)
pnpm eval:multiquery     # multi-query expansion (ADR-0009)
pnpm eval:answers --label <name>   # answers + citations, the pre-promptfoo eval

# Production traces → golden-set candidates (Langfuse, Phase 10)
pnpm sample:traces --days 7        # writes .cache/golden-candidates.json for curation
```

## Files here

- `retrieval-baseline.json`, `llm-baseline.json`: what the gates compare against.
- `phase-*.json`: the measurements behind each phase's ADR.
