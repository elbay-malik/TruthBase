---
target: TruthBase main screen
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/elbaymalik/dev/eleo/truth_base/app/pages/index.vue"
target_fingerprint: "sha256:bebc04facfee463686c4b7df55f8afc575db2cbbbce347ab731961bd5aeb4a93"
target_path: /Users/elbaymalik/dev/eleo/truth_base/app/pages/index.vue
timestamp: 2026-10-22T10-14-58Z
slug: app-pages-index-vue
---
# Critique: TruthBase main screen (app/pages/index.vue)
Method: dual-agent (A: design review on live main · B: detector + axe on local build), answers replayed, no live quota

## Design Health Score: 29/40 (Good)
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | After a refusal (desktop) the viewer still shows the previous answer's "Citation 3 of 4", ?chunk= and Copy link |
| 2 | Match System / Real World | 3 | Two page systems side by side ("Page 8 of 32" / "8 / 32" vs "p. 3 (PDF 8)"); "Linked citation" |
| 3 | User Control and Freedom | 3 | No persistence; Prev at 1 of 4 looks enabled, does nothing |
| 4 | Consistency and Standards | 3 | "Never an earlier answer's evidence" rule broken by refusals; Fit vs 76%; two example-button treatments |
| 5 | Error Prevention | 2 | Example questions ignore the scope (CSF question offered while "Searching RAPTOR only") |
| 6 | Recognition Rather Than Recall | 3 | Desktop stepping: active card/chip scroll out of view, no claim strip |
| 7 | Flexibility and Efficiency | 3 | 13 Shift+Tabs box → chip 1; unnamed focusable chat scroller |
| 8 | Aesthetic and Minimalist Design | 3 | Passage shown three times (tooltip, card, PDF); chips wrap alone at 390 px |
| 9 | Error Recovery | 3 | Refusal has no next step (try all documents / rephrase) |
| 10 | Help and Documentation | 3 | Method / evals links vanish once a conversation starts |

## Design Specificity
Authored: two voices, bracket + tint, footnote chips numbered by first use (now one system: chip = card = stepper = badge = spoken), dashed refusal, Corpus Index. Generic: soft example buttons, stock composer, phone zoom group. Detector: CLI 0 (regex-only for .vue); URL/overlay 0 on landing; viewer states 21 desktop / 336 phone, all PDF.js textLayer false positives. axe 0 violations in 12 states. Contrast 0 failures (placeholder 4.79:1 / 6.76:1). Phone targets all ≥ 24 px; under 44: composer, examples, scope select, New conversation (28), footer links (24), chips (24). No overflow down to 320 px reflow.

## Priority Issues
- [P1] Refusal leaves the previous answer's evidence live on desktop (highlight, Citation 3 of 4, ?chunk=, Copy link, active chip). Fix: on any new turn, clear the open citation unless the new answer opens its own; refusal → Corpus Index / scope document. /impeccable harden
- [P1] Flagship example "six Functions" cites passages that don't state IDENTIFY (glossary) or DETECT/RESPOND/RECOVER ("addressed concurrently"). Fix: choose examples whose every chip lands on stating text; longer term a weak-support chip state. /impeccable clarify
- [P2] Examples ignore the active scope and spend quota on certain refusals. Fix: filter by document or ask out-of-scope examples in all documents. /impeccable harden
- [P2] Shared ?chunk= link arrives without its claim ("Linked citation"). Fix: carry the claim or call it "Shared passage" with document/page in the chat column. /impeccable onboard
- [P3] Desktop stepping loses the claim. Fix: scroll the active chip into view (nearest) or a claim strip under the citation row. /impeccable layout

## Persona Red Flags
Alex: 13 Shift+Tabs to chip 1; no end-of-citations feedback. Sam: unnamed chat-scroller tab stop; hidden "Cited passage" text stale after a refusal; three identical "Citation 4" names. Casey: chips wrap onto own line; possibly-related links 24 px; nothing persists. Evaluator: example 1's citations 2 and 4 don't support claims; refusal beside stale highlight looks like a bug; method links gone after first question. Document worker: shared link without claim; no history; no copy-citation text.

## Minor Observations
Page field "8 / 32" next to "p. 3 (PDF 8)"; related page opens with previous page in top third; Ask looks enabled when empty; "Fig. 1. CSF Core structure The CSF…" caption glued to body; Fit vs 76%.

## Questions to Consider
Should the UI show when a check fails (dashed chip for weak support)? Should the shared link be claim + evidence? Could the phone's claim strip become the desktop verification surface too?
