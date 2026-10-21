# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Two audiences with equal weight:

- **Evaluators.** Hiring managers and engineers assessing the author for senior / tech-lead roles. They spend a few minutes on the live demo and skim the README, looking for evidence of judgment: does the flow work, are the numbers real, are the tradeoffs explained.
- **Document workers.** People who need answers they can verify from dense PDFs, such as compliance, security and policy analysts or researchers. They ask a question, read the answer, and check the claim against the source before relying on it. They may come back and use it repeatedly.

## Product Purpose

TruthBase answers questions from a fixed set of PDFs. Every claim in an answer carries an inline citation. Clicking a citation opens the PDF on the right page, scrolled to the cited passage and highlighted exactly. When the documents don't support an answer, it refuses instead of guessing.

Success:
- An evaluator gets from question to highlighted passage within a minute and trusts the published numbers.
- A document worker can verify any claim without searching the PDF themselves.

## Positioning

- **Exact-passage highlight.** A citation resolves to the cited glyphs on the right page at any zoom, not just to a document or a page. Placement is checked against an independent PDF engine and in a real browser.
- **Measured, honest quality.** Retrieval and answer quality are measured on a golden set. The numbers are published with what they were measured on, and pending measurements are labelled as pending. Refusing is preferred to guessing.
- **Engineering transparency.** Architecture decisions, the alternatives rejected, and the tradeoffs are part of the product story (ADRs, README whitepaper), not hidden internals.

## Operating Context

- Live public demo: https://truthbase-brown.vercel.app, no login.
- Corpus: four public PDFs (NIST CSF 2.0, NIST AI RMF 1.0, the RAPTOR and Self-RAG papers), ingested by the operator. Visitors can't upload their own documents yet.
- Typical session: ask a question, optionally scoped to one document, then read the streamed answer and click the citations. The viewer sits beside the answer on desktop and opens as a bottom sheet on phones.
- Evaluators also read the GitHub README, the ADRs and the eval files.

## Capabilities and Constraints

- Nuxt 4 + Nuxt UI v4 + Tailwind v4 front end, Supabase (pgvector + full-text) back end, PDF.js viewer, deployed on Vercel Hobby.
- Runs on free tiers. LLM and embedding quotas are small, so daily per-client and global caps and per-minute limits are part of the experience: users can hit a cap, and it is shown with a countdown.
- Retrieval: hybrid search (RRF), an optional LLM reranker, multi-query rewriting. Generation streams, and answers cite numbered sources.
- **Undecided / not built:** uploading your own documents (Phase 11b), and accounts.

## Brand Commitments

- The name "TruthBase" is the only brand asset. There is no logo, palette or type commitment.
- **Voice:** sober and factual. Use plain wording, no marketing hype and no invented claims. The existing UI copy sets the tone ("Ask the documents. Every answer cites its source.", "Answers come only from these documents.").

## Evidence on Hand

- Eval results: `docs/evals/*.json`, `docs/evals/README.md`; summarized in `README.md` with sources.
- Highlight accuracy: 176/180 checks pass in `pnpm check:viewer`; the 4 known misses are listed in README Limitations.
- Lighthouse and axe results are in the README Quality section: accessibility 100, 0 axe violations, performance 98 mobile / 100 desktop.
- Demo video: `docs/media/demo.mp4`, `docs/media/demo.gif`.
- ADRs: `docs/adr/0001`–`0012`.
- **Absences:** no users, testimonials, customers, press or usage statistics exist. Don't fabricate any.

## Product Principles

1. **Every claim is checkable.** Any answer text that asserts something leads to its exact source passage in one click.
2. **Say what is known, label what isn't.** Pending measurements, refusals and limits are stated plainly, never dressed up.
3. **The source document is the authority.** The PDF and its highlighted passage outrank the generated answer, and the UI should never obscure them.
4. **Fast to the first proof.** First paint stays light: PDF.js and the AI SDK load off the critical path. Keep mobile Lighthouse performance around 98 and LCP around 2.4 s.
5. **Show the reasoning behind the build.** Tradeoffs and rejected alternatives stay visible to anyone evaluating the work.
