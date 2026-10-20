// Input limits shared by the server schemas and the UI. No zod here, so the
// client bundle can import them without pulling in the validator.

/** Longest question /api/chat (and /api/search) accepts, in characters. */
export const MAX_QUESTION_LENGTH = 1000
