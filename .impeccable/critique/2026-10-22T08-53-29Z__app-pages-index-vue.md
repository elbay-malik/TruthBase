---
target: TruthBase main screen
total_score: 30
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 2
target_identity: "file:/Users/elbaymalik/dev/eleo/truth_base/app/pages/index.vue"
target_fingerprint: "sha256:e1d4991b2c99f9dd8714f9a5b0cc1a0530a67c31e9d81a9c48eee5b64595c6dc"
target_path: /Users/elbaymalik/dev/eleo/truth_base/app/pages/index.vue
timestamp: 2026-10-22T08-53-29Z
slug: app-pages-index-vue
---
# Critique: TruthBase main screen (app/pages/index.vue)
Method: dual-agent (A: design review · B: detector + browser)

## Design Health Score: 30/40 (Good)
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3 | Viewer keeps the previous answer's citation beside a new answer |
| 2 | Match System / Real World | 3 | Chip "2" vs "Citation 1 of 4"; "Linked citation" jargon |
| 3 | User Control and Freedom | 3 | No way to clear the desk; reload loses the conversation |
| 4 | Consistency and Standards | 3 | Same source numbered differently in chip, card, stepper; two "document" selectors |
| 5 | Error Prevention | 3 | No quota headroom shown before the limit |
| 6 | Recognition Rather Than Recall | 3 | Phone badge "2" over "Citation 1 of 4" |
| 7 | Flexibility and Efficiency | 3 | [ ] dead once focus leaves the viewer; no answer-level link |
| 8 | Aesthetic and Minimalist Design | 3 | Full-pane blue focus frame on mouse open; hyphen lists; debris excerpts |
| 9 | Error Recovery | 3 | Refusal gives no next step; related links have no snippet |
| 10 | Help and Documentation | 3 | No hint on which questions work or what scope does |

## Design Specificity
Authored: two voices, margin bracket, dashed refusal, printed page names, Corpus Index, white page in dark. Generic: the chat column (role labels, grey example buttons, pinned composer); desktop left column ~60% empty on landing. Detector: CLI 0 findings (regex-only for .vue); URL scans 0 on landing; viewer states 21 (desktop) / 336 (phone) tiny-text/undersized-ui-text, all PDF.js transparent textLayer spans: false positives. Overlay blocked on live by Local Network Access and the app CSP (no wasm-unsafe-eval); ran on a local build with bypassCSP. Contrast: 0 text below AA; placeholder 4.79:1 light / 6.76:1 dark. Phone tap targets: "Method" 50×17 and "The 4 misses" 86×17 fail WCAG 2.2 24 px; composer, examples, scope select at 32 px. No horizontal overflow at 390, 200% or 400%.

## Priority Issues
- [P1] Citation numbers don't match citation order: chips 2,1,4,3,3,3; badge "2" over "Citation 1 of 4"; chip aria name disagrees with viewer announcement. Fix: renumber sources client-side by first appearance so chip n = card n = citation n. /impeccable clarify
- [P1] Source-card excerpts show page furniture and figure text ("Published as a conference paper at ICLR 20242 3 4 51 1 23…"): running head glued to folio not stripped; figure label runs; mid-entry starts. Fix: strip head followed by digits, skip/label figure-text runs, start at a sentence with leading "…". /impeccable harden
- [P2] Answer typography: "- " lines render as a pre-wrapped paragraph (spoken "dash"); space before full stop after chips; doubled spaces. Fix: render lists as <ul>, trim chip→punctuation whitespace, collapse spaces. /impeccable typeset
- [P2] Stale desk between answers + two competing document selectors (viewer "NIST CSF 2.0" next to "Searching RAPTOR only"). Fix: open the new answer's first citation on finish (desktop) or label "From an earlier answer"; rename viewer switcher "Reading". /impeccable clarify
- [P2] Full-pane 2 px Ink Blue focus frame after mouse/touch opens (focusScroller always sets data-focus-ring). Fix: ring only for keyboard-initiated opens. /impeccable polish
- [P3, detector] Phone "Method" / "The 4 misses" links 17 px tall (< 24 px). /impeccable adapt

## Persona Red Flags
Alex: [ ] only work with focus in the viewer; reload loses the conversation; only passage links. Sam: chip "Citation 2" vs "Citation 1 of 4"; list read as "dash". Casey: sheet header truncates "NIST CS…"; wide passages (73% fit) ~8 px text. Evaluator: chip order, hyphen list, ICLR debris excerpt are screenshot-able; IDENTIFY cited to a glossary block. Analyst: no history or copy-answer-with-citations; refusal has no next step; related pages have no snippet.

## Minor Observations
"Linked citation" on phone deep link; "Try another question" offers examples outside the active scope; corpus line and composer footer say the same thing on desktop; phone copy confirmation icon-only; chip boxes make line spacing uneven; related-page open lands with the previous page filling the top third.

## Questions to Consider
Should a chip number belong to the passage (numbered by first use) rather than to the retriever? Should the newest answer's first citation open automatically, so the desk never shows older evidence? What would make an analyst come back: a link to a whole answer?
