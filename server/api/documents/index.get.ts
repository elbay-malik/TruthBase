// GET /api/documents — the demo workspace's documents (public data; the
// service-role read is needed because RLS denies anon on `documents`).
// The page's SSR awaits it, so it is cached: the corpus changes only through
// operator ingestion, and a new document shows up within maxAge (stale copies
// are served while one request refreshes them). The route takes no parameters,
// so it has one fixed key: a query string cannot add cache entries.
export default defineCachedEventHandler(async () => {
  const { data, error } = await serverSupabase()
    .from('documents')
    .select('id, filename, page_count')
    .order('filename')

  if (error) {
    // The database's error text stays in the server log, not the response.
    // A thrown error is not cached.
    console.error('[documents] listing failed:', error.message)
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: 'Listing documents failed.' })
  }
  return data.map(d => ({ id: d.id as string, filename: d.filename as string, pageCount: d.page_count as number }))
}, { name: 'documents', getKey: () => 'all', maxAge: 5 * 60, swr: true })
