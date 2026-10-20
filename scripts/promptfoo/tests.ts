// promptfoo test cases from docs/golden/golden.json: one per record, with
// the golden evidence as a var for the deterministic citation check.
// GOLDEN_ONLY=g-001,g-013 limits the run (smoke tests, quota-sized slices).

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

interface GoldenRecord { id: string, question: string, answer: string | null, evidence: unknown[], tags: string[] }

const ROOT = resolve(import.meta.dirname, '../..')
const assertion = (fn: string, metric: string) => ({ type: 'javascript', value: `file://assertions.ts:${fn}`, metric })

export default function tests() {
  const golden: GoldenRecord[] = JSON.parse(readFileSync(join(ROOT, 'docs/golden/golden.json'), 'utf8'))
  const only = process.env.GOLDEN_ONLY ? new Set(process.env.GOLDEN_ONLY.split(',')) : undefined
  return golden.filter(r => !only || only.has(r.id)).map((r) => {
    const answerable = r.answer !== null
    return {
      description: `${r.id} ${r.tags.join(',')}`,
      vars: { id: r.id, question: r.question, answerable, evidence: JSON.stringify(r.evidence), tags: r.tags.join(',') },
      assert: [
        assertion('refusal', 'refusal'),
        ...(answerable ? [assertion('evidenceCitation', 'evidence-citation')] : []),
        assertion('grounded', 'grounded'),
      ],
      metadata: { goldenId: r.id, tags: r.tags },
    }
  })
}
