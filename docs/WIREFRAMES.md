# TruthBase: Wireframes (Phase 0)

Low-fidelity layouts for the split-pane chat and PDF viewer. These pin down layout, states and interactions; visual styling happens in Phase 12. The example content is real golden-set data (g-020, g-047), so the same flows also serve as the Phase 13 E2E scripts.

Components map to Nuxt UI v4 where possible: `UButton`, `UBadge`, `UTextarea`, `USelectMenu`, `UTooltip`, `UTabs`, `UAlert`, `UProgress`, `USkeleton`, `UKbd`.

---

## 1. Desktop: empty state

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│ ◆ TruthBase      Demo workspace ▾      [ All documents ▾ ]               Evals ↗  GitHub ↗│
├──────────────────────────────────────────┬────────────────────────────────────────────────┤
│                                          │  nist-csf-2.0.pdf ▾        ◀ 1 / 32 ▶   − 100% + │
│   Ask the documents.                     │ ┌────────────────────────────────────────────┐ │
│   Every answer cites its source.         │ │                                            │ │
│                                          │ │   The NIST Cybersecurity Framework         │ │
│   Try:                                   │ │   (CSF) 2.0                                │ │
│   ┌────────────────────────────────────┐ │ │                                            │ │
│   │ What are the six CSF Functions?    │ │ │   ░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░           │ │
│   └────────────────────────────────────┘ │ │   ░░░░░░░░░░░░░░░░░░░░░░░░                 │ │
│   ┌────────────────────────────────────┐ │ │                                            │ │
│   │ How does RAPTOR cluster chunks?    │ │ │                                            │ │
│   └────────────────────────────────────┘ │ │                                            │ │
│   ┌────────────────────────────────────┐ │ │                                            │ │
│   │ What is residual risk?             │ │ │                                            │ │
│   └────────────────────────────────────┘ │ │                                            │ │
│                                          │ │                                            │ │
│                                          │ └────────────────────────────────────────────┘ │
├──────────────────────────────────────────┤  4 demo PDFs · public domain / CC BY 4.0       │
│ ┌──────────────────────────────────────┐ │                                                │
│ │ Ask a question…                    ⏎ │ │                                                │
│ └──────────────────────────────────────┘ │                                                │
│  Answers only from these documents.      │                                                │
└──────────────────────────────────────────┴────────────────────────────────────────────────┘
             chat pane (~42%, fixed)                      viewer pane (~58%)
```

- Example questions are taken from the golden set, so a first-time visitor always gets a good answer.
- The document selector scopes retrieval (`filter_document_id`). "All documents" is the default.
- The viewer shows the selected document until a citation is clicked. With "All documents" it starts on the corpus index (the four PDFs, how the highlight is checked, project links), so no PDF is downloaded before a question; a row of the index, or the viewer's own switcher, opens any document from page 1.

## 2. Desktop: answer streaming

```
├──────────────────────────────────────────┬────────────────────────────────────────────────┤
│  You                                     │                                                │
│  Which CSF subcategory says backups      │                                                │
│  must be checked before they are used    │                                                │
│  to restore systems?                     │        (viewer unchanged while streaming)      │
│                                          │                                                │
│  TruthBase                               │                                                │
│  RC.RP-03 requires that the integrity    │                                                │
│  of backups and other restoration        │                                                │
│  assets is verified before using them    │                                                │
│  for restoration [1]. This is separate   │                                                │
│  from PR.DS-11, which covers creating    │                                                │
│  and testing backups [2]▌                │                                                │
│                                          │                                                │
│  ⟳ Searching 4 documents · reranking…    │                                                │
│                                          │                                                │
│                              [ ■ Stop ]  │                                                │
```

- Citation chips `[n]` render inline as soon as their marker streams in. They are clickable immediately.
- A status line shows the pipeline stage (searching → reranking → writing). It disappears when the answer finishes.
- `Stop` aborts the stream. Partial answers keep their citations.

## 3. Desktop: citation clicked → scroll + highlight (the core interaction)

```
├──────────────────────────────────────────┬────────────────────────────────────────────────┤
│  TruthBase                               │  nist-csf-2.0.pdf ▾       ◀ 28 / 32 ▶   − 100% + │
│  RC.RP-03 requires that the integrity    │ ┌────────────────────────────────────────────┐ │
│  of backups and other restoration        │ │ NIST CSWP 29 … CSF 2.0         Feb 26, 2024│ │
│  assets is verified before using them    │ │                                            │ │
│  for restoration [1]. This is separate   │ │ o RC.RP-02: Recovery actions are selected, │ │
│  from PR.DS-11, which covers creating    │ │   scoped, prioritized, and performed       │ │
│  and testing backups [2].                │ │╔══════════════════════════════════════════╗│ │
│              ▲                           │ │║o RC.RP-03: The integrity of backups and  ║│ │
│        [1] active (filled)               │ │║  other restoration assets is verified    ║│ │
│                                          │ │║  before using them for restoration       ║│ │
│  Sources                                 │ │╚══════════════════════════════════════════╝│ │
│  ┌────────────────────────────────────┐  │ │ o RC.RP-04: Critical mission functions and │ │
│  │[1] nist-csf-2.0.pdf · p. 28      ◉ │  │ │   cybersecurity risk management are …      │ │
│  │    "RC.RP-03: The integrity of…"   │  │ │                                            │ │
│  ├────────────────────────────────────┤  │ └────────────────────────────────────────────┘ │
│  │[2] nist-csf-2.0.pdf · p. 25        │  │   Citation 1 of 2     [ ◀ Prev ]  [ Next ▶ ]   │
│  │    "PR.DS-11: Backups of data are…"│  │                                                │
│  └────────────────────────────────────┘  │                                                │
```

Behavior:

1. Clicking `[1]` (or its row in **Sources**) switches the viewer to the cited document if needed, then scrolls page 28 into view with the passage vertically centered.
2. The highlight is one overlay rect **per line** (`rects[]`), not one bounding box. It is redrawn from PDF-space coordinates on every zoom or rotation (`viewport.convertToViewportPoint` on both corners, since PDF.js 6 has no `convertToViewportRectangle`).
3. The highlight flashes once (≤ 600 ms, disabled under `prefers-reduced-motion`), then stays tinted until another citation is chosen.
4. Hovering a chip shows a `UTooltip` with the document, page and first ~120 characters of the chunk.
5. `Prev` / `Next` step through this answer's citations in order.
6. The active chip and its Sources row share a filled state. The viewer header shows `Citation n of m`.
7. **Fallback:** if the stored rects fail the text-match check (risk register item 1: the rendered page text at the stored offsets differs from the chunk text, or the page size changed), the viewer still jumps to the page and highlights by searching the text layer for the chunk text. A small "approximate highlight" badge says so.

## 4. Desktop: grounded refusal

```
├──────────────────────────────────────────┬────────────────────────────────────────────────┤
│  You                                     │                                                │
│  What financial penalties does the       │                                                │
│  NIST CSF 2.0 impose for non-compliance? │                                                │
│                                          │                                                │
│  TruthBase                               │                                                │
│  ┌────────────────────────────────────┐  │                                                │
│  │ ⓘ  Not found in the documents.     │  │                                                │
│  │ None of the retrieved passages     │  │                                                │
│  │ answers this. TruthBase doesn't    │  │                                                │
│  │ guess.                             │  │                                                │
│  └────────────────────────────────────┘  │                                                │
│  Possibly related (not used as sources): │                                                │
│   · NIST CSF 2.0 · p. 2 (PDF 7)          │                                                │
│   · NIST CSF 2.0 · p. ii (PDF 3)         │                                                │
```

- A refusal never shows citation chips. "Possibly related" links open the page without a highlight, which marks them as not evidence.
- Visual tone is neutral (`UAlert`, info color). It must not look like an error, because refusing is correct behavior.

## 5. Upload and ingestion (bring-your-own-docs, Phase 11b)

```
│  Documents                                         [ + Upload PDF ]  │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │ ✓ nist-ai-rmf-1.0.pdf        48 pages · 212 chunks   ready   │   │
│  │ ⟳ my-report.pdf              Parsing pages 12 / 40           │   │
│  │   ▓▓▓▓▓▓░░░░░░░░░░░░░░  parse → chunk → embed → store        │   │
│  │ ✕ scan.pdf                   No text layer (scanned PDFs     │   │
│  │                              aren't supported)        Remove │   │
│  └──────────────────────────────────────────────────────────────┘   │
```

- Progress shows the pipeline stage, not just a percentage. Stage names match the Langfuse trace spans.
- A scanned PDF with no text layer fails fast with a reason (OCR is out of scope).

## 6. Mobile (< 768 px): stacked, viewer as a sheet

```
┌───────────────────────────┐     ┌───────────────────────────┐
│ ◆ TruthBase   [All docs ▾]│     │ ✕  nist-csf-2.0.pdf  p.28 │
├───────────────────────────┤     ├───────────────────────────┤
│ You                       │     │ o RC.RP-02: Recovery      │
│ Which CSF subcategory …   │     │   actions are selected…   │
│                           │     │╔═════════════════════════╗│
│ TruthBase                 │ tap │║o RC.RP-03: The integrity║│
│ RC.RP-03 requires that    │ [1] │║  of backups and other   ║│
│ the integrity of backups  │ ──▶ │║  restoration assets is  ║│
│ … for restoration [1].    │     │║  verified before using… ║│
│ … creating and testing    │     │╚═════════════════════════╝│
│ backups [2].              │     │ o RC.RP-04: Critical …    │
│                           │     │                           │
├───────────────────────────┤     ├───────────────────────────┤
│ [ Ask a question…      ⏎ ]│     │ [◀ Prev]  1 of 2  [Next ▶]│
└───────────────────────────┘     └───────────────────────────┘
        chat (default)              viewer sheet (full height)
```

- A single column with no horizontal scroll and 16 px side gutters. The PDF renders at fit-width.
- Tapping a citation opens the viewer as a full-height sheet, scrolled and highlighted. `✕` or swipe-down returns to the same scroll position in the chat.

## 7. Error and limit states

| State | Where | Message (draft) | Recovery |
|---|---|---|---|
| Rate limited (429) | Inline in chat, replaces the answer | "You've hit the demo limit (N questions/hour). Try again in 12 min." | Countdown, input disabled until reset |
| LLM provider down (fallback also failed) | Inline in chat | "Answer service unavailable" | `Retry` button; question text kept |
| PDF failed to load | Viewer pane | "Document failed to load" | `Retry`; the cited passage is quoted below it |
| Stream interrupted | End of partial answer | "Answer interrupted." | `Regenerate`; partial citations stay clickable |

## Keyboard and accessibility (showcase flow)

| Key | Action |
|---|---|
| `/` | Focus the question input |
| `Enter` / `Shift+Enter` | Send / newline |
| `Tab` | Move through citation chips in reading order |
| `Enter` on a chip | Jump and highlight. Focus moves to the viewer region, which announces "Page 23 (PDF page 28), Citation 1 of 2. Passage: …" via `aria-live="polite"` |
| `[` / `]` | Previous / next citation while the viewer has focus |
| `Esc` | Return focus to the chip that opened the citation (mobile: close the sheet) |

- Chips are real `<button>`s labeled e.g. "Citation 1: NIST CSF 2.0, page 23 (PDF page 28)".
- The highlight is not shown by color alone: it has a tint per line plus a margin bracket beside the whole passage (DESIGN.md "PDF Highlight"), and meets the contrast requirement in both themes.
- The PDF text layer stays selectable and readable by screen readers. The overlay is `aria-hidden`.

## Implementation status (after Phase 12, 2026-10-20)

Built as specified in §1–4, §6, §7, the keyboard table and the a11y notes. That includes the §3.4 tooltip excerpt, the §3.7 text-match fallback, §4's "possibly related" links that open the page without a highlight (one per page, at most three), and `Retry` with the question kept. Screen readers get one status line ("Searching…", "Answer ready, 2 sources") instead of every streamed token. Items deferred after Phase 5 and built in Phase 12:

- **Viewer header (§1, §3):** a document switcher, `◀ n / N ▶` page buttons with a page-number field, and zoom buttons with 24 px targets (44 px on phones). Page jumps and zoom steps are announced.
- **`/` shortcut:** focuses the question input from anywhere except a text field or an open menu.
- **`Retry` in the viewer** when a PDF fails to load, announced as "<short title> failed to load. Retry available."; focus stays in the viewer.
- **Daily-cap state (§7):** a 429 from the daily quota ([ADR-0010](./adr/0010-abuse-protection.md)) shows its message with "Back in about …, at <time>" and keeps the input read-only (still focusable) until the reset, then offers the question again. The per-minute limit still shows a "wait a minute" message.

Decisions that change the wireframes:

- The split pane is fixed at 42/58 instead of resizable. It works from 1024 to 1920 px, and a keyboard-operable separator adds little to the showcase.
- On desktop the viewer starts empty under "All documents" (§1 note above) instead of showing the first document.
- The highlight drops overlay lines in the top and bottom 7.5% of the page (running headers, footers, page numbers that a chunk includes), unless the whole passage is there.

Still deferred:

| Item | Where specified | Why |
|---|---|---|
| `Evals ↗` / `GitHub ↗` header links and the "4 demo PDFs · public domain / CC BY 4.0" line | §1 | Their public URLs exist only after deployment (Phase 14) |
| Resizable split pane | §1 | See decisions above |
| Upload and ingestion UI | §5 | Operator-only until Phase 11b ([ADR-0010](./adr/0010-abuse-protection.md)) |
| Running headers and footers stripped from chunk text at ingestion | §3.4 tooltip | Needs a chunker change, re-ingestion and a new retrieval-eval baseline; the render-time filter covers the highlight |
| Dimmed PDF pages in dark mode, "zoom to passage" on phones | §6 | Contrast risk for the highlight colours; fit-width plus manual zoom works |

The showcase questions still work: in the post-audit Groq eval, g-020 is answered with a correct citation (both Phase 4 runs refused it), and g-047 is still correctly refused.
