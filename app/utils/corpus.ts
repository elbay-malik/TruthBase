// What the reader sees of a corpus document: its printed title and where it
// was published, taken from the PDF's own first page. The documents table only
// stores the filename, so a document ingested later without an entry here is
// listed by its filename until one is added.
//
// Page numbers and running heads are read off the PDFs too, and
// test/unit/corpus.test.ts checks every entry against docs/golden/pdfs: none
// of these PDFs except the AI RMF carries page labels, and its labels name the
// unnumbered cover pages "1" and "i", so the printed numbers are kept here.

/** PDF pages `from`–`to` carry printed numbers counting up from `first`. */
interface PrintedRange {
  from: number
  to: number
  first: number
  roman?: true
  /** Printed before the number in the folio, e.g. "Page " ("Page 4"); none prints a bare "4". */
  prefix?: string
}

export interface DocumentInfo {
  /** The title as printed on the first page. */
  title: string
  /** Short form for narrow rows: the name the documents themselves use. */
  short: string
  /** Publisher series or authors and venue, as printed. */
  source?: string
  /** Where the printed page numbers run; a PDF page outside every range has none. */
  printed?: PrintedRange[]
  /** The running head, as PDF.js reads it (variants in item order). */
  runningHead?: string[]
}

const CORPUS: Record<string, DocumentInfo> = {
  'nist-ai-rmf-1.0.pdf': {
    title: 'Artificial Intelligence Risk Management Framework (AI RMF 1.0)',
    short: 'NIST AI RMF 1.0',
    source: 'NIST AI 100-1',
    printed: [
      { from: 4, to: 4, first: 1, roman: true },
      { from: 5, to: 5, first: 2, roman: true, prefix: 'Page ' },
      { from: 6, to: 47, first: 1, prefix: 'Page ' },
    ],
    runningHead: ['NIST AI 100-1 AI RMF 1.0'],
  },
  'nist-csf-2.0.pdf': {
    title: 'The NIST Cybersecurity Framework (CSF) 2.0',
    short: 'NIST CSF 2.0',
    source: 'NIST CSWP 29, February 2024',
    printed: [{ from: 2, to: 5, first: 1, roman: true }, { from: 6, to: 32, first: 1 }],
    runningHead: [
      'NIST CSWP 29 The NIST Cybersecurity Framework (CSF) 2.0 February 26, 2024',
      'The NIST Cybersecurity Framework (CSF) 2.0 NIST CSWP 29 February 26, 2024',
    ],
  },
  'raptor.pdf': {
    title: 'RAPTOR: Recursive Abstractive Processing for Tree-Organized Retrieval',
    short: 'RAPTOR',
    source: 'Sarthi et al., ICLR 2024',
    printed: [{ from: 1, to: 23, first: 1 }],
    runningHead: ['Published as a conference paper at ICLR 2024'],
  },
  'self-rag.pdf': {
    title: 'Self-RAG: Learning to Retrieve, Generate, and Critique through Self-Reflection',
    short: 'Self-RAG',
    source: 'Asai et al., preprint',
    printed: [{ from: 1, to: 30, first: 1 }],
    runningHead: ['Preprint.'],
  },
}

export function documentInfo(filename: string): DocumentInfo {
  return CORPUS[filename] ?? { title: filename, short: filename }
}

const ROMAN: [number, string][] = [[10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]
function roman(n: number): string {
  let out = ''
  for (const [value, letters] of ROMAN) {
    for (; n >= value; n -= value) out += letters
  }
  return out
}

const rangeOf = (filename: string, pdfPage: number) =>
  CORPUS[filename]?.printed?.find(r => pdfPage >= r.from && pdfPage <= r.to)

/** The page number printed on PDF page `pdfPage`, when the corpus records one ("iv", "23"). */
export function printedPage(filename: string, pdfPage: number): string | undefined {
  const range = rangeOf(filename, pdfPage)
  if (!range) return undefined
  const n = range.first + pdfPage - range.from
  return range.roman ? roman(n) : String(n)
}

/** The page-number line as printed on the page ("Page 4", or a bare "4"). */
export function folioOf(filename: string, pdfPage: number): string | undefined {
  const printed = printedPage(filename, pdfPage)
  return printed === undefined ? undefined : `${rangeOf(filename, pdfPage)!.prefix ?? ''}${printed}`
}

/**
 * How a cited page is named: the printed number a reader finds on the paper,
 * then the PDF page a viewer's page field counts, when they differ.
 * `text` is the visible form, `spoken` the accessible one.
 *
 * - printed 23 on PDF page 28: "p. 23 (PDF 28)" / "page 23 (PDF page 28)"
 * - printed and PDF page agree: "p. 5" / "page 5"
 * - no printed number known: "PDF p. 28" / "PDF page 28"
 */
export function pageName(filename: string | undefined, pdfPage: number | null | undefined): { text: string, spoken: string } {
  if (!pdfPage) return { text: 'p. ?', spoken: 'page unknown' }
  const printed = filename ? printedPage(filename, pdfPage) : undefined
  if (printed === undefined) return { text: `PDF p. ${pdfPage}`, spoken: `PDF page ${pdfPage}` }
  if (printed === String(pdfPage)) return { text: `p. ${printed}`, spoken: `page ${printed}` }
  return { text: `p. ${printed} (PDF ${pdfPage})`, spoken: `page ${printed} (PDF page ${pdfPage})` }
}

/** Where a source sits, for labels: "NIST CSF 2.0, page 23 (PDF page 28)". */
export function sourceName(source: { filename: string, pageNumber: number | null }): string {
  return `${documentInfo(source.filename).short}, ${pageName(source.filename, source.pageNumber).spoken}`
}

/** Share of the page height holding running heads and folios: mirrors RUNNING_MARGIN in app/utils/pdf-highlight.ts. */
const RUNNING_MARGIN = 0.075

interface PassageSource {
  filename: string
  pageNumber: number | null
  content: string
  highlight?: { rects: { y1: number, y2: number }[], pageHeight: number } | null
}

/**
 * A source's text without the page furniture a chunk picked up: the running
 * head at its start and the printed page number ("…2024 5 Fig. 2" → "Fig. 2",
 * "…distributions. 3" → "…distributions."). The viewer already leaves those
 * lines out of the highlight (dropRunningMargins); excerpts match it.
 *
 * A head is only removed as the exact string read off that document's pages.
 * A trailing bare number is removed only when the stored rects put a line in
 * the bottom margin, so a passage that really ends in a number keeps it.
 */
export function passageText(source: PassageSource): string {
  const info = CORPUS[source.filename]
  let text = source.content.replace(/\s+/g, ' ').trim()
  if (!info) return text
  const h = source.highlight
  const inBand = (edge: 'top' | 'bottom') => !!h?.rects.some((r) => {
    const centre = (r.y1 + r.y2) / 2 // PDF space: y grows upward
    return edge === 'top' ? centre > h.pageHeight * (1 - RUNNING_MARGIN) : centre < h.pageHeight * RUNNING_MARGIN
  })
  const folio = source.pageNumber ? folioOf(source.filename, source.pageNumber) : undefined

  const head = info.runningHead?.find(head => text === head || text.startsWith(`${head} `))
  if (head && (!h || inBand('top'))) {
    text = text.slice(head.length).trimStart()
    // Folios at the foot of the page can come right after the head in reading order.
    if (folio && text.startsWith(`${folio} `)) text = text.slice(folio.length).trimStart()
  }
  if (folio && text.endsWith(` ${folio}`) && (inBand('bottom') || (!h && /\D/.test(folio)))) {
    text = text.slice(0, -folio.length).trimEnd()
  }
  return text || source.content.trim()
}

/**
 * The one quality figure the landing page states, as published in README.md
 * ("Headline numbers", "Highlight accuracy"). Update both together.
 */
export const HIGHLIGHT_CHECKS = { passed: 176, total: 180, spans: 60, zooms: '50, 100 and 200%' } as const

const REPO = 'https://github.com/EleoXDA/TruthBase'
export const PROJECT_LINKS = {
  repo: REPO,
  readme: `${REPO}#readme`,
  highlightAccuracy: `${REPO}#highlight-accuracy`,
  limitations: `${REPO}#limitations-and-roadmap`,
  adrs: `${REPO}/tree/main/docs/adr`,
  evals: `${REPO}/tree/main/docs/evals`,
} as const
