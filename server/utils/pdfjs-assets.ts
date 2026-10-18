import type { PdfAssetReader } from '../ingest/pdf-assets'

// PDF.js CMap / standard-font files from Nitro server assets (registered in
// nuxt.config.ts `nitro.serverAssets`), so a deployed bundle carries them
// instead of resolving node_modules at runtime (server/ingest/pdf-assets.ts).
// Auto-imported by Nitro.

const STORAGE_BY_DIR: Record<string, string> = {
  cmaps: 'assets:pdfjs-cmaps',
  standard_fonts: 'assets:pdfjs-standard-fonts',
}

export function nitroPdfAssets(): PdfAssetReader {
  return async (path) => {
    const [dir, ...rest] = path.split('/')
    const storage = STORAGE_BY_DIR[dir ?? '']
    const raw = storage ? await useStorage(storage).getItemRaw(rest.join('/')) : null
    if (!raw) throw new Error(`PDF.js asset not bundled: ${path}`)
    return raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer)
  }
}
