import { createHash } from 'node:crypto'

// The public corpus PDFs are served as static files from the CDN, not through
// signed Storage URLs: docs/golden/pdfs is published at /pdfs
// (nitro.publicAssets in nuxt.config.ts). Supabase Free includes 5 GB of
// egress per billing cycle, Vercel Hobby 100 GB of transfer a month (ADR-0010).
// Each file is byte-identical to its object in the `documents` bucket, which
// the stored highlights were computed from. Changing one means a new filename.

/** Where docs/golden/pdfs is published. */
export const STATIC_PDF_BASE = '/pdfs'

/** The files in docs/golden/pdfs and their SHA-256 (test/unit/static-pdfs.test.ts keeps them in step). */
const STATIC_PDF_SHA256: Readonly<Record<string, string>> = {
  'nist-ai-rmf-1.0.pdf': '7576edb531d9848825814ee88e28b1795d3a84b435b4b797d3670eafdc4a89f1',
  'nist-csf-2.0.pdf': '3c31f46fee98cac0c4323453e5109291a213b4de7fef8c058af9bf67f717433c',
  'raptor.pdf': '01319e2e6e6ecfd504ee1bbda41d023f9e060bd3505ab3c161baa1d6d696cf75',
  'self-rag.pdf': 'd9eaa1398abac0df67a9d0933a5bf8b6d9d83d2e72da2a486073cd842dd52978',
}

export const STATIC_PDFS: ReadonlySet<string> = new Set(Object.keys(STATIC_PDF_SHA256))

/** The same-origin URL of a document served as a static file, or undefined. */
export function staticPdfUrl(filename: string): string | undefined {
  return STATIC_PDFS.has(filename) ? `${STATIC_PDF_BASE}/${encodeURIComponent(filename)}` : undefined
}

/**
 * Whether `pdf` would be stored under a corpus filename without being that
 * file. Documents are matched to /pdfs by name, so the viewer would open the
 * corpus copy and draw this document's highlights on it.
 */
export function takesCorpusName(filename: string, pdf: Uint8Array): boolean {
  const sha256 = STATIC_PDF_SHA256[filename]
  return sha256 !== undefined && createHash('sha256').update(pdf).digest('hex') !== sha256
}
