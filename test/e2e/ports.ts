// Ports of the E2E servers (playwright.config.ts): override them with
// E2E_PORT / E2E_STUB_PORT when the defaults are taken. The config never
// reuses a server already listening there, so a stale build can't answer.

export const PORT = Number(process.env.E2E_PORT || 3100)
export const STUB_PORT = Number(process.env.E2E_STUB_PORT || 3101)
/** The Supabase stub (./supabase-stub.ts): REST for SSR, Storage for the PDFs. */
export const STUB_ORIGIN = `http://127.0.0.1:${STUB_PORT}`
