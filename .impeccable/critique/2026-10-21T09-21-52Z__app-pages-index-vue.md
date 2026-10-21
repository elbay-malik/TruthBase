---
target: TruthBase main screen
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/elbaymalik/dev/eleo/truth_base/app/pages/index.vue"
target_fingerprint: "sha256:e397629cb4ffd7f045f166c369e4afc7c7c6f330151288677078629aea160c92"
target_path: /Users/elbaymalik/dev/eleo/truth_base/app/pages/index.vue
timestamp: 2026-10-21T09-21-52Z
slug: app-pages-index-vue
---
# Critique: TruthBase main screen (app/pages/index.vue)
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score: 26/40 (Acceptable)
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | No auto-scroll to new answers |
| 2 | Match System / Real World | 2 | PDF index vs printed page; raw filenames; running headers in excerpts |
| 3 | User Control and Freedom | 3 | Phone sheet hides the claim; no new conversation |
| 4 | Consistency and Standards | 3 | Refusal uses the blue accent (breaks DESIGN.md); ↗ on in-app links |
| 5 | Error Prevention | 3 | Scope filter scrolls away while still active |
| 6 | Recognition Rather Than Recall | 2 | [ ] shortcuts invisible; examples vanish |
| 7 | Flexibility and Efficiency | 3 | Deep link exists but no copy-link UI |
| 8 | Aesthetic and Minimalist Design | 3 | Empty half-screen on landing; per-line outlines |
| 9 | Error Recovery | 3 | "Slow down a moment" blames the user |
| 10 | Help and Documentation | 1 | No link to README/ADRs/evals or corpus description |

## Design Specificity
Behaviour authored (chip→glyph loop, honesty states, white page in dark mode); surface generic Nuxt UI. Detector: 0 findings in .vue (regex only); live site: placeholder contrast 2.6:1 light / 3.7:1 dark (index.vue:732); phone straggler "PDF." (index.vue:480); dark-glow false positive (overlay's own colour). Overlay blocked by CSP (no wasm-unsafe-eval) and Private Network Access.

## Priority Issues
- [P1] Phone verification loses the claim; evidence unreadable at Fit; truncated filename. Fix: open zoomed to highlight bbox, claim in bottom bar, short title. /impeccable adapt
- [P1] Evaluator path has no proof and no next step; empty viewer pane on landing. Fix: corpus list + one factual metric line + repo link, or pre-highlighted example. /impeccable onboard
- [P2] Citation metadata: page label, filename vs title, running headers in excerpts, unwrapped 1000px tooltip (stuck on phone). /impeccable clarify
- [P2] Multi-turn: no auto-scroll, scope filter scrolls away, no copy-link/URL update, unbounded textarea. /impeccable harden
- [P2] Signature marks: per-line 2px outlines heavy; refusal blue; placeholder AA fail. /impeccable quieter, /impeccable polish

## Persona Red Flags
Alex: invisible [ ], no copy-citation, no clear. Sam: passage never exposed as text in viewer. Casey: stuck tooltip, unreadable Fit, no auto-scroll. Evaluator: no metrics/ADR link. Analyst: page mismatch, no title/date, no copyable citation, no verbatim quote.

## Minor Observations
Error title style mixed; first-person "I won't guess"; Ask looks inert on landing; citation label far from chevrons; focus frame after mouse click; 200% zoom cut-off cue missing.

## Questions to Consider
Why is the document pane empty on first screen? Inline verbatim quotes per claim? What is recognisably TruthBase without the name and the yellow?
