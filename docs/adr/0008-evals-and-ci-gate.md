# ADR-0008: Eval methodology and CI gate

- **Status:** Accepted 2026-11-26. The retrieval gate runs in CI, and the LLM eval has an accepted baseline ([llm-baseline.json](../evals/llm-baseline.json), 2026-11-25). A second hand check kept qwen as the judge, with its known leniency recorded (Consequences). Proposed from 2026-10-20 until then: the first full LLM eval (2026-10-23, `docs/evals/phase-9-llm.json`) failed on 4 false refusals, and a hand check found the judge lenient.
- **Note (2026-11-25):** The first accepted LLM baseline, [llm-baseline.json](../evals/llm-baseline.json): CI run 45700985608 on bge-m3 with the contextual notes (ADR-0014), all 50 questions. Faithfulness 98.9%, citation precision 98.3%, 5/5 unanswerable refused, 1 false refusal (g-027). Hand-checked on 2026-11-26 (Consequences).
- **Date:** 2026-10-20
- **Note (2026-11-04):** Embeddings moved to bge-m3 ([ADR-0013](./0013-leaving-gemini.md)). The gate now runs `hybrid_search_bge_m3` on a 2.7 MB fixture with recall@8 76%, MRR 0.548, nDCG@5 0.640 and filtered recall@8 78% (`docs/evals/retrieval-baseline.json`); since the 2026-11-09 chunking change ([ADR-0003](./0003-chunking.md)) recall@8 82%, MRR 0.555, nDCG@5 0.615 and filtered recall@8 83%; since the 2026-11-25 contextual notes ([ADR-0014](./0014-contextual-retrieval.md)) recall@8 91%, MRR 0.564, nDCG@5 0.609 and filtered recall@8 90%. The figures below are from Gemini embeddings.

## Context

SPEC defines the quality metrics on the 50-record golden set (45 answerable, 5 unanswerable): recall@k and MRR/nDCG@5 for retrieval; faithfulness, citation precision and refusal accuracy for answers. Phases 6–8 measured them with one-off scripts (`eval:rerank`, `eval:multiquery`, `eval:answers`). Phase 9 makes measurement routine and gates changes on it.

The binding constraint is the free tier. Groq allows 200K tokens/day per model, shared with the live demo, and a full run of the answer pipeline plus an LLM judge needs about 300K tokens across four models: rewriting and reranking (gpt-oss-20b, ~170K), answers (gpt-oss-120b, ~100K) and judging (~110K). That can't run on every pull request.

## Decision

**Two evals, gated differently.**

1. **Retrieval gate on every PR and push to main** (`pnpm eval:retrieval`, CI `db` job). The indexed corpus (4 documents, 564 chunks with embeddings) and the golden questions' query embeddings are committed as `test/fixtures/retrieval-corpus.json.gz` (2.1 MB; embeddings as float32, pgvector's precision). CI loads them into the Supabase Postgres image with the migrations applied, runs the real `hybrid_search` for every answerable record, with and without the document filter, and compares recall@5/8/10/15, MRR and nDCG@5 (its ideal ranking is every evidence-bearing chunk in the database searched, so missing a relevant chunk can't raise it) with `docs/evals/retrieval-baseline.json`. No API keys, deterministic, so **no tolerance**: any drop fails, and a change that trades metrics updates the baseline in the same PR, where the diff (including per-record ranks) shows it. A changed record count, a baseline record missing from the run, or an empty scope also fails. `pnpm fixtures:retrieval` re-exports the fixture after re-ingestion.
2. **LLM eval, manual and weekly** (`pnpm eval:llm`, workflow `llm-eval`). promptfoo runs the production answer pipeline (`server/rag/retrieve.ts` unchanged, then grounded generation) for all 50 records through a custom provider (`scripts/promptfoo/provider.ts`). Assertions per record:
   - `refusal` (deterministic): unanswerable → refused, answerable → not refused.
   - `evidenceCitation` (deterministic): an answer cites at least one source holding a golden evidence span.
   - `grounded` (LLM judge): one structured call splits the answer into factual claims and, per claim, lists the cited sources that support it, and says whether the answer addresses the question.

   `pnpm eval:llm:summary` pools these into the SPEC metrics: **faithfulness** = claims supported by at least one of their citations / claims (an uncited claim counts as unsupported); **citation precision** = citation markers whose source supports the claim / all markers; **answer relevance**; **refusal accuracy**. It fails on the SPEC targets (faithfulness ≥ 0.90, citation precision ≥ 0.90, 5/5 unanswerable refused, ≤ 1 false refusal) or a drop of more than **0.05** below `docs/evals/llm-baseline.json` (answers vary between uncached runs). Records that fail an assertion count in the metrics (only promptfoo's errored rows are left out, and they fail the gate); promptfoo itself exits 0 on failed assertions (`PROMPTFOO_PASS_RATE_THRESHOLD=0`), so this summary is the one gate. `--update-baseline` skips the baseline comparison and writes only an error-free run of the full golden set that meets the SPEC targets.
3. **Every model call in the LLM eval is cached on disk** by an AI SDK middleware (`scripts/lib/cached-model.ts`), keyed by the full request including the system instructions and by the model that answered (the answer model's Gemini fallback wraps the per-provider caches), and paced under 8K tokens/min per model, shared across rewriting and reranking on the same model. A run stopped by a spent daily quota exits 2 and resumes for free; CI keeps the cache between runs (`actions/cache`, saved even on failure).
4. **Judge: `qwen/qwen3.8-27b` on Groq** (`JUDGE_MODEL`), a different model family from the answer model (gpt-oss), on its own quota.
5. **promptfoo 0.124.1 via `pnpm dlx`**, pinned, not a dependency: its 540 packages stay out of the app's lockfile and `pnpm audit`. Its dependency tree is therefore resolved fresh on every run, so the workflow has a read-only `GITHUB_TOKEN` and passes the secrets only to the steps that call models.

## Rationale

- **Retrieval is where regressions hide, and it's the one part that can run offline.** Chunking, SQL, weights and the golden set itself all change retrieval; every one of those PRs now shows its effect on 86 ranked lists. The fixture database reproduces the hosted numbers exactly (recall@8 87%, MRR 0.515, nDCG@5 0.638, filtered recall@8 88%); with the corpus-wide ideal the gate uses, nDCG@5 is 0.633.
- **No tolerance for a deterministic metric.** Exact cosine search with id tie-breaks gives the same ranks on every run, so a tolerance would only let real regressions through. Intended trade-offs are explicit baseline updates.
- **One judge call instead of promptfoo's built-in graders.** `context-faithfulness` makes two calls per answer and `answer-relevance` needs an embedding provider; one structured call grades all three at roughly half the judge tokens. promptfoo still provides the test runner, per-record results, the viewer and before/after comparisons (`promptfoo view`).
- **Pooled metrics, as SPEC defines them.** promptfoo averages scores per test; a short answer with one unsupported claim and a long one with ten supported claims weigh the same there. The summary pools claims and citations.
- **Caching through middleware, not a copy of the pipeline.** The eval exercises the code the chat route runs. A copy would drift.
- **The deterministic `evidenceCitation` stays** next to the judge as a cheap, judge-free lower bound and a check on the judge: a judge that passes answers citing no evidence-bearing source is suspect.

## Rejected alternatives

- **The LLM eval on every PR**, sampled to fit the quota: a 10–15 question sample moves 7–10 points per question, too noisy to gate, and it needs API secrets in PR runs and spends quota the demo needs.
- **promptfoo for the retrieval gate too**: the metrics are custom code either way, and the gate would need promptfoo installed in CI for a script that otherwise needs only Node and Postgres.
- **Ragas**: Python, wrong ecosystem (EXECUTION_PLAN Phase 9).
- **Braintrust / Evalite**: SaaS not needed at this scale; Evalite is less mature.
- **gpt-oss-120b as judge**: grades its own answers (self-preference) and shares the answer quota.
- **Gemini Flash-Lite as judge**: it's the answer fallback, and its free quota ran out within a day of Phase 7–8 evals.
- **Hosted Supabase in the retrieval gate**: needs secrets in PR runs and makes the gate depend on whatever is currently ingested.

## Consequences

- **First full run (2026-10-23, `docs/evals/phase-9-llm.json`).** It covered all 50 records with no errored rows. It resumed from the cache of the run stopped by a spent quota on 2026-10-22 and spent about 93K tokens on the day.
  - Faithfulness 95.2% (99 of 104 claims) and judged citation precision 92.5% (136 of 147 citations).
  - Answer relevance 100% (41 of 41 answered) and evidence citation 87.8% (36 of 41).
  - Refusals: 5/5 unanswerable refused, and **4 false refusals** (g-030, g-032, g-035, g-040; SPEC ≤ 1).
  - The pipeline as shipped: gpt-oss-20b rewrites (8 of 50) and reranks (no fallbacks), and gpt-oss-120b answers all 50.

  The gate fails on the false refusals, so `--update-baseline` wrote nothing.
- **The judge, checked by hand.** Five answers, 31 claims, each compared claim by claim with the cited source text: the two lowest-scoring answers, one that dropped a citation, and two fully supported ones.
  - Its support calls on a claim's own citations are mostly right. 28 match the hand check, 2 count a citation that doesn't support the claim, and 1 rejects support a lenient reader would accept.
  - The faults are in what it chooses to judge. It split one answer so that four unsupported additions became a single claim, scoring 0.8 where a consistent split gives 0.5–0.63. It left a non-supporting citation off a claim, skipped three statements of another answer, copied source wording into claims, and once repeated a list of source numbers 61 times. The scorer ignores support from sources a claim doesn't cite, which kept that loop out of the score.
  - Correcting only these five answers lowers the pooled figures to about 92–94% faithfulness and 88–90% citation precision. Faithfulness holds; citation precision sits at the target.
  - qwen also needed retries for invalid JSON: 3 on 2026-10-23, and 15 JSON or schema errors plus 5 "Request too large" in the stopped 2026-10-22 run. All recovered.
- **Open before Accepted, and how each closed:**
  1. ~~Fewer false refusals.~~ Done: 1 false refusal (g-027) in the 2026-11-25 baseline run, after the grounding rule for flattened tables (ADR-0005) and the contextual notes (ADR-0014).
  2. A firmer judge, then a hand check of ~10 judgments (SPEC) and a decision on qwen. The hand check is done (below) and qwen stays. The firmer judge is a follow-up: take the claims and their citations from the answer's own sentences and markers instead of letting the judge re-split them, reject output whose supporting citations aren't a subset of the claim's or that repeats itself, and tell it that a second cited source on the same topic doesn't support a claim unless it states it.
  3. ~~Add the four secrets to the GitHub repo for the `llm-eval` workflow.~~ Done 2026-10-20.
- **Second hand check (2026-11-26, baseline run 45700985608).** Ten answered records, 42 claims and 63 citation markers, each compared with the cited source text. Picked, not sampled at random: the two answers the judge flagged (g-013, g-040), and eight multi-claim answers across all four PDFs (g-006, g-015, g-016, g-022, g-025, g-030, g-038, g-045).
  - The judge agrees on 41 of 42 claim verdicts and 60 of 63 citation verdicts. It never rejected supported text, and both claims it flagged are unsupported.
  - All four disagreements are lenient. g-015 "Identify — categorizes assets and related cybersecurity risks" cites a passage that names assets, not risks. In g-045, two second citations are on the topic without stating the claim (prompting GPT-4 with instruction and demonstration pairs; the OpenAI API).
  - On the sample, faithfulness is 97.6% by the judge and 95.2% by hand, and citation precision 96.8% and 92.1%. Read the baseline's 98.9% and 98.3% as roughly 96-97% and 93-95%, still above SPEC's 0.90.
  - The October faults (merged claims, skipped statements, repetition loops) did not recur. Claim granularity still varies: one sentence became three claims in g-025, g-030 and g-040.
  - Decision: keep qwen3.8-27b. Its errors are few and go one way, and a new judge would need its own check and quota.
- **The fixture must follow the corpus.** After re-ingesting or changing chunking/embeddings, run `pnpm fixtures:retrieval` and update the baseline in the same PR, or the gate measures the old corpus.
- **LLM steps aren't in the PR gate.** A change to the rewrite, rerank or grounding prompts shows up only in the LLM eval, so run it (or a `GOLDEN_ONLY` slice) before merging such a change.
- **The weekly run spends one day's quota on Sunday night.** If the demo needs that headroom, drop the schedule and keep it manual.
- **Revisit** if the golden set grows (more records make a sampled LLM gate viable), on a paid tier, or if the judge proves unreliable.
