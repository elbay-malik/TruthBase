// The retrieval fixture: the indexed corpus (documents, chunks, chunk
// embeddings) and the golden questions' query embeddings, committed as
// test/fixtures/retrieval-corpus.json.gz so CI can run hybrid_search on the
// real corpus without API keys (ADR-0008).
//
// Embeddings are stored as base64 little-endian float32, the precision
// pgvector keeps, so a fixture database ranks exactly like the hosted one.

import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'
import type { Sql } from 'postgres'
import { ROOT } from './golden'

export const FIXTURE_FILE = join(ROOT, 'test/fixtures/retrieval-corpus.json.gz')

export interface Fixture {
  /** When and from where it was exported. */
  exportedAt: string
  embeddingModel: string
  documents: { id: string, filename: string, page_count: number | null }[]
  chunks: { id: string, document_id: string, page_number: number | null, content: string, embedding: string }[]
  /** Golden question text → RETRIEVAL_QUERY embedding. */
  queries: Record<string, string>
}

export function encodeVector(vector: readonly number[]): string {
  return Buffer.from(new Float32Array(vector).buffer).toString('base64')
}

export function decodeVector(encoded: string): number[] {
  const bytes = Buffer.from(encoded, 'base64')
  return Array.from(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4))
}

/** pgvector's text input format. */
export const vectorLiteral = (vector: readonly number[]) => `[${vector.join(',')}]`

export async function writeFixture(fixture: Fixture): Promise<void> {
  await writeFile(FIXTURE_FILE, gzipSync(JSON.stringify(fixture), { level: 9 }))
}

export async function readFixture(): Promise<Fixture> {
  return JSON.parse(gunzipSync(await readFile(FIXTURE_FILE)).toString('utf8'))
}

/** Replaces the database's documents and chunks with the fixture's. */
export async function installFixture(sql: Sql, fixture: Fixture): Promise<void> {
  await sql.begin(async (tx) => {
    await tx`delete from documents` // chunks cascade
    await tx`insert into documents ${tx(fixture.documents, 'id', 'filename', 'page_count')}`
    const rows = fixture.chunks.map(c => ({ ...c, embedding: vectorLiteral(decodeVector(c.embedding)) }))
    for (let i = 0; i < rows.length; i += 200) {
      await tx`
        insert into chunks (id, document_id, page_number, content, embedding)
        select id, document_id, page_number, content, embedding::extensions.vector
        from jsonb_to_recordset(${tx.json(rows.slice(i, i + 200) as never)}::jsonb)
          as x(id uuid, document_id uuid, page_number int, content text, embedding text)`
    }
  })
}
