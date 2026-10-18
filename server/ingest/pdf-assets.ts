import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// PDF.js data files for server-side extraction: predefined CMaps (CJK and
// other CID fonts) and standard-font data (non-embedded base-14 fonts) — the
// two kinds the worker requests through the BinaryDataFactory. (WASM image
// decoders and ICC profiles only affect image decoding, not text.)
//
// unpdf's serverless PDF.js reads these through a `BinaryDataFactory`. Its
// default resolves `pdfjs-dist` at runtime and fetches URLs, which breaks in a
// Nitro bundle (no import.meta.resolve, pdfjs-dist not traced) and with file://
// URLs (TECH_NOTES §11). So the files are served by an injected reader:
// - nodeAssetReader(): straight from node_modules (dev, tests, scripts)
// - the ingest route passes a reader over Nitro server assets (nuxt.config.ts)
//   so a deployed bundle carries the files itself.

/** Reads a PDF.js data file by path, e.g. "cmaps/UniJIS-UCS2-H.bcmap". */
export type PdfAssetReader = (path: string) => Promise<Uint8Array>

/** PDF.js asset kind → directory inside pdfjs-dist (and the server-asset name). */
export const PDFJS_ASSET_DIRS = {
  cMapUrl: 'cmaps',
  standardFontDataUrl: 'standard_fonts',
} as const

type AssetKind = keyof typeof PDFJS_ASSET_DIRS

/** Reader over the installed pdfjs-dist package (pinned to unpdf's PDF.js). */
export function nodeAssetReader(): PdfAssetReader {
  let root: string | undefined
  return async (path) => {
    root ??= dirname(createRequire(import.meta.url).resolve('pdfjs-dist/package.json'))
    return new Uint8Array(await readFile(join(root, path)))
  }
}

/**
 * getDocument options that route every PDF.js data-file request to `reader`.
 * `useWorkerFetch: false` makes the (in-process) worker ask the main side,
 * where our factory answers; the URL options only need to be non-null.
 */
export function pdfjsAssetOptions(reader: PdfAssetReader) {
  class BinaryDataFactory {
    async fetch({ kind, filename }: { kind: AssetKind, filename: string }): Promise<Uint8Array> {
      const dir = PDFJS_ASSET_DIRS[kind]
      if (!dir) throw new Error(`Unsupported PDF.js data kind: ${kind}`)
      return reader(`${dir}/${filename}`)
    }
  }
  return {
    BinaryDataFactory,
    useWorkerFetch: false,
    cMapUrl: 'pdfjs-assets:/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: 'pdfjs-assets:/standard_fonts/',
  }
}
