// Phase 3 (docs/EXECUTION_PLAN.md): multipart PDF upload → unpdf extraction
// with positions → recursive ~512-token chunking → 768-dim Gemini embeddings
// (L2-normalized, see docs/TECH_NOTES.md §2) → Supabase insert, with SSE
// progress streaming.
export default defineEventHandler(() => {
  throw createError({
    statusCode: 501,
    statusMessage: 'Not Implemented',
    message: 'The ingestion pipeline lands in Phase 3.',
  })
})
