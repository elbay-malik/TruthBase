// promptfoo result rows as scripts/promptfoo/summary.ts reads them
// (promptfoo 0.124.1's output JSON).

import type { JudgeSource } from './judge'

export interface Row {
  vars: { id: string, question: string, answerable: boolean | string }
  response?: { output?: string, metadata?: { refused?: boolean, sources?: JudgeSource[], expander?: string, reranker?: string, rewrites?: string[], reranked?: boolean, answeredBy?: string } }
  namedScores?: Record<string, number>
  error?: string
  /** promptfoo's ResultFailureReason: 0 none, 1 a failed assertion, 2 an error. */
  failureReason?: number
}

/**
 * A row with no gradable answer. A failed assertion also sets `error` (to the
 * grading reason), so `error` alone doesn't mean the row errored.
 */
export const isErrored = (r: Row) => r.failureReason === 2 || !r.response?.metadata
