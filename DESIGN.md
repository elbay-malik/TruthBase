---
name: TruthBase
description: Ask the documents. Every answer cites its source.
colors:
  ink-blue: "#1d4ed8"
  ink-blue-dark: "#60a5fa"
  highlighter-yellow: "rgb(250 204 21 / 0.45)"
  highlighter-flash: "rgb(250 204 21 / 0.85)"
  margin-brown: "#a16207"
  error-red: "#b91c1c"
  warning-ochre: "#854d0e"
  paper-white: "#ffffff"
  stone-wash: "#fafaf9"
  stone-elevated: "#f5f5f4"
  stone-hairline: "#e7e5e4"
  stone-dimmed: "#a8a29e"
  stone-muted: "#78716c"
  stone-toned: "#57534e"
  stone-ink: "#44403c"
  stone-heading: "#1c1917"
  night-desk: "#1c1917"
  night-elevated: "#292524"
typography:
  wordmark:
    fontFamily: "'TruthBase Serif' (Source Serif 4), Georgia, ui-serif, serif"
    fontSize: "1.75rem"
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: "-0.025em"
  answer:
    fontFamily: "'TruthBase Serif' (Source Serif 4), Georgia, ui-serif, serif"
    fontSize: "1.0625rem"
    fontWeight: 400
    lineHeight: 1.625
  claim:
    fontFamily: "'TruthBase Serif' (Source Serif 4), Georgia, ui-serif, serif"
    fontSize: "0.9375rem"
    fontWeight: 400
    lineHeight: 1.375
  excerpt:
    fontFamily: "'TruthBase Serif' (Source Serif 4), Georgia, ui-serif, serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  body:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.875rem"
    fontWeight: 400
    lineHeight: 1.43
  label:
    fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1.333
    letterSpacing: "0.05em"
  index:
    fontFamily: "'TruthBase Serif' (Source Serif 4), Georgia, ui-serif, serif"
    fontSize: "0.75rem"
    fontWeight: 600
    lineHeight: 1
    fontFeature: "tnum"
rounded:
  highlight: "2px"
  sm: "4px"
  md: "6px"
spacing:
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  6: "24px"
components:
  citation-chip:
    backgroundColor: "rgb(29 78 216 / 0.1)"
    textColor: "{colors.ink-blue}"
    rounded: "{rounded.sm}"
    typography: "{typography.index}"
    height: "24px"
    width: "24px"
  citation-chip-active:
    backgroundColor: "{colors.ink-blue}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.sm}"
  source-card:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.stone-muted}"
    rounded: "{rounded.md}"
    padding: "12px"
    typography: "{typography.excerpt}"
  source-card-hover:
    backgroundColor: "{colors.stone-wash}"
  source-card-active:
    backgroundColor: "rgb(29 78 216 / 0.05)"
    textColor: "{colors.stone-toned}"
    rounded: "{rounded.md}"
  source-index-badge:
    backgroundColor: "rgb(29 78 216 / 0.1)"
    textColor: "{colors.ink-blue}"
    rounded: "{rounded.sm}"
    typography: "{typography.index}"
    height: "20px"
  refusal:
    backgroundColor: "transparent"
    textColor: "{colors.stone-heading}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
    typography: "{typography.answer}"
  button-primary:
    backgroundColor: "{colors.ink-blue}"
    textColor: "{colors.paper-white}"
    rounded: "{rounded.md}"
  button-primary-hover:
    backgroundColor: "rgb(29 78 216 / 0.9)"
  question-input:
    backgroundColor: "{colors.paper-white}"
    textColor: "{colors.stone-ink}"
    rounded: "{rounded.md}"
    typography: "{typography.body}"
  question-input-placeholder:
    textColor: "{colors.stone-muted}"
  pdf-highlight:
    backgroundColor: "{colors.highlighter-yellow}"
    rounded: "{rounded.highlight}"
  evidence-bracket:
    backgroundColor: "{colors.margin-brown}"
    width: "6px"
  pdf-page:
    backgroundColor: "{colors.paper-white}"
---

# Design System: TruthBase

## Overview

**Creative North Star: "The Evidence Desk"**

TruthBase is a working desk. The answer sits on one side, the source document lies open on the other, and the job is to move between them without losing your place. The desk is warm stone, the pen is blue ink, and the document's words are set in a book serif. Attention goes to two things only: the answer's numbered citations and the bracketed, highlighted passage in the PDF. Nothing in the chrome competes with the page.

The system is built on Nuxt UI v4 and tuned rather than restyled. Its character comes from three decisions, not from decoration. First, two voices: what comes from the documents (the answer, quoted excerpts, the wordmark) is set in Source Serif 4, and everything the tool says (labels, controls, your own question) stays in the system sans. Second, a warm stone neutral instead of slate, so the desk reads as paper and ink rather than as a generic toolkit. Third, an editor's mark for evidence: a margin bracket beside the cited passage, the way a reviewer marks a page by hand. Semantic colors are shifted one or two shades darker so that every text pairing passes WCAG AA, and a single solid focus ring is used everywhere.

Density is calm but working: 24 px between conversation blocks, 8–12 px inside them, small tracked uppercase labels for structure. Light and dark themes are both first class. The PDF page itself always stays white, because it is the document. The earlier "native and unbranded" stance was a default, not a strategy; it is replaced by this one.

**Key Characteristics:**
- Two voices: a book serif for the documents' words, the system sans for the tool's.
- Warm stone surfaces separated by hairline borders, with no decorative shadows.
- One interactive accent (Ink Blue) and one evidence mark (Highlighter Yellow tint plus a Margin Brown bracket).
- Tabular numerals on every citation index and page number.
- The document pane is the visual anchor, and the chat column is narrower (≤ 42% on desktop).
- Dashed lines mean "no established evidence": the refusal, the approximate highlight.

## Colors

A warm stone desk, one blue pen, and one yellow highlighter with a brown margin pencil.

### Primary
- **Ink Blue** (`{colors.ink-blue}` in light, `{colors.ink-blue-dark}` in dark): every interactive affordance that leads to a source. That covers citation chips, the active source card's border and tint, source index badges, the Ask button, focus rings and links. Light mode uses the 700 shade, not Nuxt UI's default 500, so that white text on it reaches 6.8:1.

### Secondary
- **Highlighter Yellow** (`{colors.highlighter-yellow}`): only on the PDF, one tint per cited line. It multiplies with the page, so the glyphs stay crisp. On arrival it briefly flashes stronger (`{colors.highlighter-flash}`).
- **Margin Brown** (`{colors.margin-brown}`): only on the PDF, as the evidence bracket beside the cited passage (4.9:1 on white). It is the highlight's non-colour cue: its shape marks where the passage starts and ends.

### Tertiary
- **Error Red** (`{colors.error-red}`) and **Warning Ochre** (`{colors.warning-ochre}`): status alerts only, such as a failed answer, a failed PDF load or a per-minute limit. A grounded refusal ("not in the documents") is *not* an error and uses neutral styling.

### Neutral
- **Paper White** (`{colors.paper-white}`): the light-mode background and the PDF page, always, in both themes.
- **Stone Wash / Elevated** (`{colors.stone-wash}`, `{colors.stone-elevated}`): the viewer desk behind the pages, hover fills and muted panels. Muted text sits on Stone Wash at most; on Stone Elevated it falls below AA.
- **Stone Hairline** (`{colors.stone-hairline}`): every border and divider.
- **Stone Muted / Toned / Ink / Heading** (`{colors.stone-muted}` → `{colors.stone-heading}`): text from secondary labels and placeholders up to headings. Most supporting copy is Stone Muted (4.8:1 on white). Stone Dimmed (`{colors.stone-dimmed}`) is for decorative icons only, never text.
- **Night Desk / Night Elevated** (`{colors.night-desk}`, `{colors.night-elevated}`): the dark-theme background and raised surfaces, warm charcoal rather than blue-black.

### Named Rules
**The Two Pens Rule.** Blue marks the way to evidence; yellow and brown mark the evidence. No other accent is introduced, and none is used decoratively.

**The Paper and Ink Rule.** Neutrals are warm stone, never slate or zinc. The blue reads as ink on paper only against a warm ground.

**The White Page Rule.** The PDF page renders on Paper White in every theme. Dark mode darkens the desk, never the document.

## Typography

**Display Font:** Source Serif 4 (self-hosted as "TruthBase Serif": two static woff2 files, 400 at ~18 KB and 600 at ~20 KB, subset to Latin-1 and common punctuation, `font-display: swap`), with a size-adjusted Georgia fallback face ("TruthBase Serif Fallback") and `ui-serif, serif`. The serif is switched on only once the page is idle after hydration (`.serif-ready` on `<html>`), so first paint sets the serif voice in the metric-matched Georgia and the download never competes with LCP.
**Body Font:** the system UI sans stack (`ui-sans-serif, system-ui, -apple-system, …`).
**Label/Mono Font:** no mono. Indexes use the serif's tabular figures; page numbers use the sans with `tabular-nums`.

**Character:** a book serif with optical warmth for the documents' voice, against the reader's own system sans for the tool's voice. The pairing tells you at a glance which words came from the sources and which came from the interface.

### Hierarchy
- **Wordmark** (Serif 600, 1.75rem / 28px, 1.25, −0.025em): "TruthBase" only.
- **Answer** (Serif 400, 1.0625rem / 17px, 1.625): the streamed answer, with citation chips inline on the baseline, and the refusal's headline (600). One step above 16 px because the serif's smaller apparent size needs it at reading distance.
- **Claim** (Serif 400, 0.9375rem / 15px, 1.375): the answer sentence in the phone sheet's bottom bar, one step under the answer so three lines fit above the stepper.
- **Excerpt** (Serif 400, 0.875rem / 14px): source card excerpts (clamped to 3 lines) and the viewer's quoted-passage fallback.
- **Body** (Sans 400, 1rem / 16px): your question, the question box.
- **Body small** (Sans 400, 0.875rem / 14px): the subtitle, helper text, the refusal's explanation, related-passage links.
- **Label** (Sans 600, 0.75rem / 12px, uppercase, 0.05em tracking): role headings in the conversation ("You", "TruthBase", "Sources").
- **Index** (Serif 600, 0.75rem / 12px, tabular): numerals in citation chips and source index badges, read like footnote marks.

### Named Rules
**The Two Voices Rule.** Words from the documents are serif; words from the tool or the user are sans. Never set a control, label or error in the serif, and never set quoted document text in the sans.

**The Tabular Index Rule.** Every citation number, page number and count uses tabular numerals, so chips and badges keep their width as numbers change.

**The Light Font Rule.** At most two self-hosted woff2 files, subsetted, `font-display: swap`, never on the critical path: they load after first paint, behind a metric-matched fallback. Mobile Lighthouse stays at 98 with LCP 2.4 s.

## Layout

- **Desktop (≥ lg, 1024px):** a full-height split (`h-dvh`). The chat column is on the left, at most 42% wide, with a hairline right border. The PDF viewer fills the rest. The conversation scrolls, and the question box is pinned to the bottom.
- **Phone:** a single column. The viewer opens as a full-height bottom sheet (Nuxt UI Slideover) with its own close button, and focus is trapped inside while it is open. The sheet is where a phone reader verifies, so it carries claim and evidence together (see "Phone Verification Sheet").
- **Rhythm:** a 4 px base. 24 px (`gap-6`) between conversation blocks, 8–12 px within them. Page gutters are 16 px, or 24 px from `sm` (640px) up.
- **First screen:** the chat column offers four example questions ("Try a question"), one per document. Each is a golden question whose cited sources all held its evidence in the measured answer eval, so the first check an evaluator makes holds up. With a document in scope only its example is shown: asked elsewhere, the others could only be refused. A document without an example gets one sans line instead: "No example for <short name>. Ask about it below." On desktop the empty viewer pane is not left blank: it holds the Corpus Index (below), centred on the desk at the width a page will take. On phones the same index follows the examples in short rows. After an answer, the examples not yet asked stay reachable under the conversation ("Try another question").
- **Viewer:** pages stack vertically, centered, fitted to width by default, on the Stone Wash desk. Toolbar rows sit at the top: the "Reading" switcher (the documents' short names, "NIST CSF 2.0", never a truncated filename; named "Reading", not "Document", so it never echoes the search scope), page field, zoom; then citation stepping ("‹ Citation 1 of 2 · p. 20 (PDF 25) ›", with the `[` `]` key hint). The page field and page count are PDF pages.
- **Zoomed past the pane:** a citation scrolls to its passage centred when the passage and its bracket fit the pane, otherwise from the passage's left edge, so the bracket and the start of every line are never the part cut off. Zoom changes anchored on the highlight follow the same rule.

## Elevation & Depth

Flat by default. Depth comes from hairline borders and tonal fills, not from shadows. The one exception is the PDF page, which sits on the desk with a faint shadow and a 5% black ring, like a sheet of paper.

### Shadow Vocabulary
- **Paper sheet** (`box-shadow: 0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)` plus `ring-1 ring-black/5`): PDF pages only.
- **Cut edge** (`box-shadow: inset ±10px 0 8px -8px rgb(0 0 0 / 0.28)`, 12 px wide): only on the viewer's left or right edge while the page runs past it (zoomed in), so a line cut by the pane reads as "more this way", not as the end of the text. It belongs to the paper: it is the sheet passing under the pane's edge.

### Named Rules
**The Only Paper Floats Rule.** Cards, chips and panels stay flat with hairline borders. Only the document page gets a shadow.

## Shapes

Small, quiet radii. Controls and cards use gently rounded corners (4–6 px), and highlight tints use a 2 px radius so they hug the glyph lines. The evidence bracket is square-cornered: a 3 px vertical stroke with 2 px ticks at top and bottom, 6 px wide, set 6 px left of the passage. There are no pills, no large rounded cards, and no clipped or decorative shapes.

### Named Rules
**The Dashed Line Rule.** A dashed line means "no established evidence". The grounded refusal has a dashed border; an approximate highlight (rebuilt from the text layer) has a dashed bracket. Solid lines are never used for these, and dashes are never used for anything else.

## Components

### Buttons
- **Shape:** gently rounded (6 px).
- **Primary (Ask):** an Ink Blue fill with white text. Hover drops to 90% opacity, not the default 75%, so the contrast stays at AA.
- **Focus:** the global 2 px solid Ink Blue outline with a 2 px offset. Inside scroll regions the offset is −2 px, so the ring is drawn inside instead of clipped. Focus handed to the viewer's pages by code (a citation opened) shows the ring only when the reader is on the keyboard; after a click or tap, a blue frame around the whole document would compete with the highlight.
- **Ghost/neutral:** viewer toolbar controls (zoom, page stepping, close) are neutral icon buttons.

### Citation Chips (signature)
- **Style:** an inline numbered button sitting on the answer's baseline, 24 px minimum width, the serif's tabular figures at 600, like a footnote mark. At rest it is soft: a 10% Ink Blue tint with blue text.
- **Active:** solid Ink Blue with white text, and `aria-current`.
- **Number:** the chip shows the source's order of first use in the answer, like a footnote, not the retrieval index the model cited: the first source cited is 1, the next new one 2, and a source cited again keeps its number. Chip n, source card n, "Citation n of m" and the phone sheet's badge are always the same passage, and the Sources list is in that order.
- **Behavior:** hovering or focusing preloads the viewer. Clicking opens the source in the viewer, `[` and `]` step between citations, and Esc returns focus to the chip. On desktop a finished answer opens its first citation by itself (focus stays in the question box). Any other turn end (a refusal, an error, a stopped or cut answer, any answer on a phone) clears a citation that belongs to an earlier turn, or a received link, with its `?chunk=` and Copy link, back to the Corpus Index or the scope's document: the viewer never shows an earlier answer's evidence beside a new turn. The one exception is an open phone sheet, which the reader is looking at. Focus inside the viewer moves to the question box when it clears. Stepping with `[` `]` scrolls the active chip into view (nearest), so the claim stays beside its passage.
- **Tooltip:** at most 20 rem wide and wrapping: the document's short name and page name in the sans ("NIST CSF 2.0 · p. 23 (PDF 28)"), then the start of the passage in the serif, in quotes, with the running head removed. Only where the pointer can hover (`(hover: hover) and (pointer: fine)`), and only on keyboard focus, never on focus handed back by code after a tap or click. On touch a tap opens the citation, so a tooltip could only get stuck over the answer.

### Source Cards
- **Corner Style:** 6 px, with a hairline border.
- **Background:** transparent at rest, Stone Wash on hover. When active: an Ink Blue border and a 5% Ink Blue tint.
- **Content:** an index badge (20 px, 4 px radius, serif index figures, tinted, or solid when active), the document's short name in sans (truncated), then the page name at the right in small muted tabular sans ("p. 23 (PDF 28)", see "Citation Metadata"). Below that, a 3-line excerpt in the serif, cleaned as "Citation Metadata" describes.
- **Padding:** 12 px.

### Corpus Index (first screen)
- **Purpose:** tells an evaluator, before any question, what TruthBase answers from and how its central claim is checked, and gives the next step. It states facts only: no counts of users, no adjectives, and only figures already published in README.md.
- **Documents:** a hairline-ruled list, one row per PDF from `/api/documents`. Desktop rows: the printed title in the serif (the documents' own words, 17 px, balanced), the page count at the right in small muted tabular sans, then the publisher series or authors and the filename in small muted sans. Phone rows: the short name in the serif and the page count, one line, 44 px tall. Titles come from `app/utils/corpus.ts` (taken from each PDF's first page); an unknown document falls back to its filename. Rows are buttons: hover fills with the page colour (desk → paper), and a row opens that document at page 1 in the viewer (the phone sheet on phones), with focus moved into the pages.
- **The one figure:** "Highlight placement: 176/180 checks pass (60 golden passages at 50, 100 and 200% zoom, in a real browser)", with the count in 600 tabular figures and two Ink Blue links to the README's method and its list of the 4 misses. The value lives in `HIGHLIGHT_CHECKS` and changes only with the README.
- **Project links:** Source code, README, Architecture decisions, Evals; small muted sans with a hairline underline that darkens on hover. They open in a new tab and say so to screen readers.
- **Headings:** the tracked uppercase label, as in the conversation. No heading in the serif, no eyebrow above a heading, no cards, no hero number.

**The Outbound Arrow Rule.** The ↗ (`arrow-up-right`) icon marks a link that leaves TruthBase. In-app navigation does not use it.

### Citation Metadata
Every place that names a source (chip tooltip and accessible name, source card, possibly related link, viewer citation row, phone stepper, load-error quote) uses the same two parts, from `app/utils/corpus.ts`:
- **Document:** the short name the document uses for itself ("NIST CSF 2.0", "Self-RAG"). Filenames appear only in the Corpus Index's metadata line, as the file a reader would download.
- **Page name:** the number printed on the page first, then the PDF page the viewer's page field counts, when they differ: "p. 23 (PDF 28)", "p. iv (PDF 5)". When they agree, one number: "p. 7". When no printed number is known (a cover, or a document without a table entry), "PDF p. 1". Spoken: "page 23 (PDF page 28)". The printed numbers are read off the PDFs' folios and checked against them by `test/unit/corpus.test.ts`; PDF.js page labels are not used, because only the AI RMF has them and they number its unprinted cover pages.
- **Excerpt:** the passage without page furniture. A chunk that starts at the top of a page carries the running head and sometimes the folio ("NIST CSWP 29 … February 26, 2024 5 Fig. 2"), at times glued together ("…ICLR 20242 3 4"). The head is removed only as the exact string read off that document; a trailing folio only when the stored rects put a line in the bottom running-margin band (the same 7.5% band as `dropRunningMargins`). Text read out of a figure (tick labels, node numbers) before a caption is dropped, so the excerpt starts at "Figure 1: …"; it counts as figure text only when at least a quarter of its words are bare numbers. A passage that starts mid-sentence opens with "…".
- **Stepping keys:** the desktop citation row puts Prev / Next on either side of "Citation 1 of 2 · p. 23 (PDF 28)" and shows `[` `]` "previous / next" at its right edge in muted `UKbd`s, with `aria-keyshortcuts` on the buttons. Phones have no hint: there are no keys.

### Status Messages
- **Titles** name the state in two to four words, sentence case, no full stop: "Per-minute limit reached", "Daily demo limit reached", "Answer service unavailable", "Connection lost", "Question not accepted", "Answer failed", "Document failed to load". **Descriptions** are full sentences: what happened when known, then what to do. The screen-reader status reads title and description together.
- **Voice:** the tool speaks about itself in the third person ("TruthBase doesn't guess"), never "I". No title tells the reader to change their behaviour ("Slow down"): a limit is the demo's, and the copy says so, with the number when the server sends it.

### Answer Text
- **Layout:** the answer keeps the model's plain-text structure as real markup: lines starting "- ", "* " or "1." become a `<ul>` / `<ol>` (serif, muted markers, chips inline), blank lines separate paragraphs, and a single line break stays one. Never a pre-wrapped block with literal hyphens.
- **Spacing:** no space before a chip ("restoration¹"), none between a chip and the punctuation after it ("tree¹."), and runs of spaces collapsed.

### Grounded Refusal
- **Style:** not an alert. A 6 px rounded block with a dashed Stone border (the Dashed Line Rule), 12 × 16 px padding, a muted "search-x" icon, the headline "Not found in the documents." in the answer serif at 600, and a one-line sans explanation in Stone Muted.
- **Below:** "Possibly related (not used as sources)" links in small muted sans; they open the page without a highlight.

### Inputs / Fields
- **Style:** the Nuxt UI input with a hairline border and 6 px radius, and a `/` keyboard hint inside. The question box grows with its text up to 6 rows, then scrolls inside. The document scope is a select above the conversation.
- **Placeholder:** Stone Muted (4.8:1 light, 7:1 dark), set for every textarea and input in `app.config.ts`. Nuxt UI's default dimmed placeholder (2.5:1) is not used.
- **Focus:** the global solid Ink Blue ring.
- **Disabled:** at the daily cap the input becomes read-only and a countdown alert is shown.

### Composer and Conversation (multi-turn)
- **Scope chip:** while one document is selected, a chip sits above the question box: a muted filter icon, "Searching NIST CSF 2.0 only" in small Stone Toned sans on Stone Elevated, 4 px radius, hairline border, and an × that returns to "All documents" (named "Search all documents (remove filter …)"). The box's placeholder becomes "Ask NIST CSF 2.0…" and its accessible description is the chip's text, so a filter set at the top can never silently narrow a later question. Neutral, not Ink Blue: it is a setting, not a way to evidence.
- **Asked in:** a question asked in one document keeps that scope beside its "You" label ("in NIST CSF 2.0 only"), after the scope has changed.
- **New conversation:** a small neutral ghost button ("↺ New conversation") at the right of the same row, shown once there is a conversation and nothing is being answered (Stop comes first). It clears the answers, the open citation and its URL, returns the viewer to the scope's document or the Corpus Index, keeps the scope and an unsent draft, announces "New conversation." and focuses the box. No confirmation: nothing is stored, and the questions are one click from the examples.
- **Scrolling:** a new question scrolls to the top of the conversation (24 px under it), so its answer streams in below; while the answer is still too short for that, the column follows it until the question reaches the top, the answer ends, or the reader scrolls (wheel, touch, pointer, scroll keys). Smooth only without `prefers-reduced-motion`.

### Passage Links
- **URL:** while a citation or deep-linked passage is on screen, the address bar carries `?chunk=<id>` (`history.replaceState`: no navigation, no history entry per citation, the router's state kept). Closing the phone sheet, picking a document, or a new conversation removes it. A "possibly related" page is not evidence and never gets a link.
- **The passage only:** a link carries the passage, never text to show with it. A received link shows "Shared passage" and the document and page name; any other query parameter is ignored and dropped from the address bar. The answer sentence a citation backs appears only inside the app, beside the passage it opened (the phone sheet's claim bar).
- **Copy link:** in the desktop citation row, a ghost "Copy link" button with a link icon at the right edge (after the `[` `]` hint); in the phone sheet, a 44 px link icon at the end of the stepper row (a matching spacer keeps a lone citation's label centred). It copies `/?chunk=<id>` without the zoom, so the link opens at the receiver's own fit. For 2.5 s the button reads "Link copied" with a check; if the clipboard is unavailable it reads "Copy failed" and the announcement says the same link is in the address bar.
- **The passage, spoken:** opening or stepping to a citation announces "Page 23 (PDF page 28), Citation 1 of 2. Passage: …" with the cited text (running head and folio removed); page first, so a listener can stop once oriented. The same text sits as a screen-reader-only paragraph at the top of the pages region for browsing.

### Phone Verification Sheet
- **Opening zoom:** a citation opens fitted to its passage, not the page: the scale at which the highlighted lines plus their bracket and 24 px margins fill the sheet's width, floored to a whole percent (the zoom shown is the zoom used), never below fit width and at most 200%. The zoom field shows the percentage; Fit returns to the page width. A zoom the reader chose is kept and wins over this. A page opened without a highlight (a document row, a possibly related page) fits the width.
- **The claim:** the bottom bar carries the answer's sentence that holds the chip (markers removed), above the stepper, in the answer serif at 15 px, after a solid Ink Blue index badge matching the active chip. Three lines, then More / Less. It is the answer's voice, so it is not quoted or highlighted: the PDF above is the evidence, the bar is what it is evidence for.
- **Header:** close, the document's short name with "Page 8 of 32" in small muted sans under it (so the name is never truncated at 390 px), zoom. Stepping (Prev / Next, 44 px) stays in thumb reach at the bottom; its label is two lines ("Citation 1 of 2" / "p. 23 (PDF 28)") rather than one truncated line, with the copy-link button at the row's end.

### PDF Highlight (signature)
- **Tint:** one Highlighter Yellow box per text line, drawn from stored PDF-space rects with a 2 px radius, multiplied with the page. No per-line outline.
- **Bracket:** one Margin Brown evidence bracket in the margin beside the whole passage, from the first line's top to the last line's bottom. It is the non-colour cue, and it is dashed when the highlight is approximate.
- **Motion:** one authored moment when a passage opens: the tint flashes from 85% to 45% over 600 ms ease-out while the bracket draws outward from the passage's middle over 420 ms (`cubic-bezier(0.16, 1, 0.3, 1)`). Both are off under `prefers-reduced-motion`.

## Do's and Don'ts

### Do:
- **Do** route every path to evidence through Ink Blue: chips, source cards, and the Ask button.
- **Do** set the documents' words (answer, excerpts, quotes) in the serif and the tool's words in the sans.
- **Do** mark evidence with the per-line tint *and* the margin bracket, so it never relies on color alone.
- **Do** keep every text pairing, placeholders included, at WCAG AA in both themes. In light mode use the 700 shades for semantic colors.
- **Do** use tabular numerals for indexes and page numbers.
- **Do** keep the PDF page white and lightly lifted, and keep the rest of the desk flat and warm.

### Don't:
- **Don't** use Highlighter Yellow or Margin Brown anywhere outside the PDF viewer.
- **Don't** leave the first screen's viewer pane empty, and don't fill it with claims that are not in the README: the Corpus Index states the corpus and one published figure, nothing more.
- **Don't** draw outlines around each highlighted line; the bracket carries the shape cue.
- **Don't** style a grounded refusal as an alert or with an accent color. It is a correct answer: neutral, dashed, in the answer serif.
- **Don't** reintroduce slate or another cool neutral.
- **Don't** add a second webfont family or a third file, a mono "for technical feel", or load the serif on first paint.
- **Don't** add shadows, gradients or large radii to cards, chips or panels.
- **Don't** use Nuxt UI's default 25% focus ring, 75% hover fill or dimmed placeholder; all fall below AA here.
- **Don't** darken or invert the PDF page in dark mode.
- **Don't** open a phone citation at fit width: body text is ~7 px there. Fit the passage.
- **Don't** show a hover tooltip on touch, or show a filename where the document's short name exists.
- **Don't** let a scope filter act only from the top of the column: while it narrows the search, it is named beside the question box.
- **Don't** push a history entry per citation or put a "possibly related" page in the URL; replace the state, and link only evidence.
- **Don't** give a bare "p. 28" for a PDF index when the page prints another number; name both ("p. 23 (PDF 28)"), or say "PDF p." when the printed number is unknown.
- **Don't** end a status title with a full stop, or write UI copy in the first person.
