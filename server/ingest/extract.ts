import { extractTextItems, getDocumentProxy } from 'unpdf'

// Phase 3, step 1: PDF → per-page normalized text with a character→item map.
//
// Page text is built exactly like unpdf's extractText (each item's `str`, plus
// "\n" when `hasEOL`), then whitespace runs collapse to one space and the
// result is trimmed — the matching contract in docs/golden/README.md. Because
// we build it ourselves we know, for every normalized character, which text
// item (and which character inside it) it came from. That map is what turns a
// chunk's character range into highlight rects (./highlight.ts).

/** One PDF.js text item, positioned in PDF space (bottom-left origin, scale 1). */
export interface PositionedItem {
  str: string
  /** Baseline origin, from `transform[4]` / `transform[5]`. */
  x: number
  y: number
  width: number
  /** Often 0 or unreliable in PDF.js; prefer `fontSize` for line height. */
  height: number
  fontSize: number
  hasEOL: boolean
}

export interface PageLayout {
  /** 1-based physical page index (what PDF.js uses). */
  pageNumber: number
  /** Page size from `page.getViewport({ scale: 1 })`. */
  width: number
  height: number
  /** Normalized page text (whitespace collapsed, trimmed). */
  text: string
  items: PositionedItem[]
  /**
   * For each character of `text`: index into `items`, or -1 for a space that
   * stands in for an item boundary / line break rather than a character.
   */
  charItem: Int32Array
  /** For each character of `text`: offset inside `items[charItem[i]].str`. */
  charOffset: Int32Array
}

export async function extractPages(data: Uint8Array): Promise<PageLayout[]> {
  const pdf = await getDocumentProxy(data)
  try {
    const { items } = await extractTextItems(pdf)
    const pages: PageLayout[] = []
    for (let i = 0; i < pdf.numPages; i++) {
      const page = await pdf.getPage(i + 1)
      const viewport = page.getViewport({ scale: 1 })
      const pageItems: PositionedItem[] = (items[i] ?? []).map(item => ({
        str: item.str,
        x: item.x,
        y: item.y,
        width: item.width,
        height: item.height,
        fontSize: item.fontSize,
        hasEOL: Boolean(item.hasEOL),
      }))
      pages.push({ pageNumber: i + 1, width: viewport.width, height: viewport.height, ...normalizePage(pageItems) })
    }
    return pages
  }
  finally {
    // The serverless PDF.js build has no PDFDocumentProxy#destroy; unpdf
    // itself releases documents through the loading task.
    await pdf.loadingTask.destroy()
  }
}

/** Builds normalized text plus the char→item maps from a page's items. */
export function normalizePage(items: PositionedItem[]): Pick<PageLayout, 'items' | 'text' | 'charItem' | 'charOffset'> {
  const chars: string[] = []
  const charItem: number[] = []
  const charOffset: number[] = []
  let pendingSpace = false

  const pushWhitespace = () => {
    if (chars.length > 0) pendingSpace = true // leading whitespace is trimmed
  }

  items.forEach((item, itemIndex) => {
    for (let offset = 0; offset < item.str.length; offset++) {
      const ch = item.str[offset]!
      if (/\s/.test(ch)) {
        pushWhitespace()
        continue
      }
      if (pendingSpace) {
        chars.push(' ')
        charItem.push(-1)
        charOffset.push(-1)
        pendingSpace = false
      }
      chars.push(ch)
      charItem.push(itemIndex)
      charOffset.push(offset)
    }
    if (item.hasEOL) pushWhitespace()
  })

  return {
    items,
    text: chars.join(''),
    charItem: Int32Array.from(charItem),
    charOffset: Int32Array.from(charOffset),
  }
}
