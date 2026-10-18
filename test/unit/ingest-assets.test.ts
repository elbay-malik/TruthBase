import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { getResolvedPDFJS } from 'unpdf'
import { describe, expect, it } from 'vitest'
import { extractPages } from '../../server/ingest/extract'
import type { PdfAssetReader } from '../../server/ingest/pdf-assets'

const ROOT = resolve(__dirname, '../..')

describe('PDF.js versions', () => {
  // Ingestion (unpdf's bundled PDF.js) and the viewer (pdfjs-dist) must lay out
  // text identically: stored offsets and rects index the server's page text,
  // and the viewer checks them against its own (app/components/PdfPage.vue).
  it('unpdf bundles the same PDF.js version as pdfjs-dist', async () => {
    const { version } = await getResolvedPDFJS()
    const pdfjsDist = createRequire(import.meta.url)('pdfjs-dist/package.json') as { version: string }
    expect(version).toBe(pdfjsDist.version)
  })
})

describe('PDF.js CMaps for CJK text', () => {
  // test/fixtures/cjk-cmap.pdf (scripts/cjk_fixture.py): non-embedded CID fonts
  // with predefined CMaps, so text extraction depends on the CMap files.
  const cjk = async () => new Uint8Array(await readFile(resolve(ROOT, 'test/fixtures/cjk-cmap.pdf')))

  it('extracts CJK text with the bundled CMaps', async () => {
    const [page] = await extractPages(await cjk())
    expect(page!.text).toContain('可验证的检索增强生成')
    expect(page!.text).toContain('検証可能な検索拡張生成')
  })

  it('reads CMaps through the injected asset reader', async () => {
    const requested: string[] = []
    const failing: PdfAssetReader = async (path) => {
      requested.push(path)
      throw new Error('not bundled')
    }
    const [page] = await extractPages(await cjk(), { assets: failing }).catch(() => [undefined])
    expect(requested.some(path => path.startsWith('cmaps/'))).toBe(true)
    expect(page?.text ?? '').not.toContain('可验证的检索增强生成')
  })
})
