// GET /api/documents — the demo workspace's documents (public data; the
// service-role read is needed because RLS denies anon on `documents`).
export default defineEventHandler(async () => {
  const { data, error } = await serverSupabase()
    .from('documents')
    .select('id, filename, page_count')
    .order('filename')

  if (error) {
    // The database's error text stays in the server log, not the response.
    console.error('[documents] listing failed:', error.message)
    throw createError({ statusCode: 502, statusMessage: 'Bad Gateway', message: 'Listing documents failed.' })
  }
  return data.map(d => ({ id: d.id as string, filename: d.filename as string, pageCount: d.page_count as number }))
})
