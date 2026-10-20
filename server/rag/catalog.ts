import type { SupabaseClient } from '@supabase/supabase-js'
import type { ChunkHighlight } from '../../shared/types'

// A one-line description per document, for prompts that must tell documents
// apart (query rewriting, ADR-0009). Filenames alone don't say what a document
// covers, so each line adds the start of the topmost text on its first page,
// which is the title for the documents we ingest ("RAPTOR: Recursive
// Abstractive Processing for Tree-Organized Retrieval").
//
// Documents change rarely, so the catalog is cached per server process and
// dropped after an ingest. A document with no lead yet (its chunks are still
// being stored) is only cached briefly; one whose page 1 has no text (a scanned
// cover) keeps that 30 s TTL for good, two cheap queries. Phase 11 uploads
// should store a title at ingestion instead.

export interface CatalogEntry {
  id: string
  filename: string
  /** Start of the topmost page-1 text, whitespace collapsed. */
  lead: string
}

const DESCRIPTION_CHARS = 160
const TTL_MS = 10 * 60_000
const BLANK_LEAD_TTL_MS = 30_000
let cache: { until: number, entries: CatalogEntry[] } | undefined

/** Forget the cached catalog (after an ingest, and in tests). */
export function clearCatalogCache(): void {
  cache = undefined
}

/** One "filename: lead" line per document. */
export function catalogLine(entry: CatalogEntry): string {
  return entry.lead ? `${entry.filename}: ${entry.lead}` : entry.filename
}

/** PDF space has a bottom-left origin: a larger y is higher on the page. */
function top(highlight: ChunkHighlight | null): number {
  return highlight?.rects.length ? Math.max(...highlight.rects.map(r => Math.max(r.y1, r.y2))) : -Infinity
}

export async function documentCatalog(supabase: SupabaseClient): Promise<CatalogEntry[]> {
  if (cache && Date.now() < cache.until) return cache.entries
  const [docs, firstPages] = await Promise.all([
    supabase.from('documents').select('id, filename').order('filename'),
    supabase.from('chunks').select('document_id, content, highlight').eq('page_number', 1),
  ])
  if (docs.error) throw new Error(`document lookup failed: ${docs.error.message}`)
  if (firstPages.error) throw new Error(`first-page lookup failed: ${firstPages.error.message}`)

  const topChunk = new Map<string, { content: string, top: number }>()
  for (const c of firstPages.data as { document_id: string, content: string, highlight: ChunkHighlight | null }[]) {
    const y = top(c.highlight)
    const current = topChunk.get(c.document_id)
    if (!current || y > current.top) topChunk.set(c.document_id, { content: c.content, top: y })
  }
  const entries = docs.data.map(d => ({
    id: d.id as string,
    filename: d.filename as string,
    lead: (topChunk.get(d.id as string)?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, DESCRIPTION_CHARS),
  }))
  cache = { until: Date.now() + (entries.some(e => !e.lead) ? BLANK_LEAD_TTL_MS : TTL_MS), entries }
  return entries
}
