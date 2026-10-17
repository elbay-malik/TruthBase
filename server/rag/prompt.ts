import { NO_ANSWER, type SourceRef } from '../../shared/types/chat'

// Grounding prompt + citation parsing (Phase 4, ADR-0005).
//
// Sources are numbered [1]..[n] rather than labelled with chunk UUIDs: models
// copy short numbers far more reliably, and the server maps numbers back to
// chunk ids. The model must cite every factual sentence and may only use the
// sources; when they don't answer the question it replies with exactly
// NO_ANSWER, which the UI renders as a grounded refusal.

export const GROUNDING_INSTRUCTIONS = `You answer questions about a set of PDF documents using ONLY the numbered sources provided with each question.

Rules:
1. Use only facts stated in the sources. Never use outside knowledge, even if you know the answer.
2. End every sentence that states a fact with citation markers for the sources that support it, like [2] or [1][4]. Cite only sources that actually support that sentence.
3. If the sources do not contain the answer, reply with exactly ${NO_ANSWER} and nothing else.
4. If the sources answer only part of the question, answer that part and say plainly what the sources do not cover.
5. If the question is ambiguous and the sources cover several readings (for example two different frameworks), answer each reading separately and name which document each comes from.
6. Be concise: a short paragraph or a short list. Quote exact wording for definitions, identifiers and numbers.`

/** The user turn: numbered sources followed by the question. */
export function buildPrompt(question: string, sources: SourceRef[]): string {
  const blocks = sources.map(s =>
    `[${s.index}] ${s.filename}, page ${s.pageNumber ?? '?'}\n${s.content}`,
  )
  return `Sources:\n\n${blocks.join('\n\n')}\n\nQuestion: ${question}`
}

/** Citation numbers in an answer, in order of first use, keeping only valid ones. */
export function parseCitations(answer: string, sourceCount: number): number[] {
  const cited: number[] = []
  for (const match of answer.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)) {
    for (const part of match[1]!.split(',')) {
      const n = Number(part.trim())
      if (n >= 1 && n <= sourceCount && !cited.includes(n)) cited.push(n)
    }
  }
  return cited
}

/** Whether the model refused (allowing for stray whitespace or punctuation). */
export function isRefusal(answer: string): boolean {
  return answer.trim().replace(/[.!]+$/, '') === NO_ANSWER
}
