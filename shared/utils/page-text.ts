// Normalized page text with a character→item map. Shared by server-side
// ingestion (server/ingest/extract.ts, over unpdf text items) and the browser
// viewer (over PDF.js TextLayer items): both walk the same getTextContent()
// item order, so a chunk's character offsets mean the same thing on both sides.
//
// Text is built exactly like unpdf's extractText (each item's `str`, plus "\n"
// when `hasEOL`), then whitespace runs collapse to one space and the result is
// trimmed — the matching contract in docs/golden/README.md. Other control
// characters (e.g. U+0000 from fonts without a usable ToUnicode map) are
// dropped: Postgres text rejects NUL, and they carry no readable text.

export interface TextItemLike {
  str: string
  hasEOL: boolean
}

export interface PageText {
  text: string
  /**
   * For each character of `text`: index into the items, or -1 for a space
   * that stands in for an item boundary / line break rather than a character.
   */
  charItem: Int32Array
  /** For each character of `text`: offset inside `items[charItem[i]].str`. */
  charOffset: Int32Array
}

/** C0 and C1 controls plus DEL; the whitespace ones are handled first. */
const isControl = (ch: string) => ch < ' ' || (ch >= '\u007f' && ch <= '\u009f')

export function normalizePageText(items: readonly TextItemLike[]): PageText {
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
      if (isControl(ch)) continue
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
    text: chars.join(''),
    charItem: Int32Array.from(charItem),
    charOffset: Int32Array.from(charOffset),
  }
}

/**
 * Covered character range inside each item touched by [start, end), in item
 * order. Spaces that stand in for item boundaries are skipped.
 */
export function itemRanges(page: PageText, start: number, end: number): Map<number, { from: number, to: number }> {
  const covered = new Map<number, { from: number, to: number }>()
  for (let i = start; i < end; i++) {
    const itemIndex = page.charItem[i]!
    if (itemIndex === -1) continue
    const offset = page.charOffset[i]!
    const range = covered.get(itemIndex)
    if (range) range.to = offset
    else covered.set(itemIndex, { from: offset, to: offset })
  }
  return covered
}
