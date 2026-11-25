import { describe, expect, it } from 'vitest'
import corpusNotes from '../../server/ingest/corpus-notes.json'
import { chunkNote, noteKey } from '../../server/ingest/notes'

describe('contextual notes (ADR-0014)', () => {
  it('keys a chunk by page and exact text', () => {
    expect(noteKey(3, 'abc')).toBe('3:ba7816bf8f01cfea')
    expect(noteKey(4, 'abc')).not.toBe(noteKey(3, 'abc'))
    expect(noteKey(3, 'abc ')).not.toBe(noteKey(3, 'abc'))
  })

  it('has short plain notes for the four corpus PDFs only', () => {
    expect(Object.keys(corpusNotes).sort()).toEqual(['nist-ai-rmf-1.0.pdf', 'nist-csf-2.0.pdf', 'raptor.pdf', 'self-rag.pdf'])
    const notes = Object.values(corpusNotes).flatMap(n => Object.values(n))
    expect(notes).toHaveLength(687)
    for (const note of notes) {
      expect(note.trim()).toBe(note)
      expect(note.split(/\s+/).length).toBeLessThanOrEqual(50)
      expect(note).not.toMatch(/\*\*|^#|\n/)
    }
  })

  it('returns no note for text, pages or files the corpus does not have', () => {
    const [key, note] = Object.entries(corpusNotes['raptor.pdf'])[0]!
    const page = Number(key.split(':')[0])
    expect(note).not.toBe('')
    expect(chunkNote('raptor.pdf', page, 'not a chunk')).toBe('')
    expect(chunkNote('upload.pdf', page, 'anything')).toBe('')
  })
})
