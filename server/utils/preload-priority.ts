/**
 * Adds fetchpriority="low" to every `<link rel="modulepreload">` in `head`
 * except the one for the entry module (`<script type="module" src>`).
 */
export function lowerModulePreloads(head: string): string {
  const entry = head.match(/<script\b[^>]*\btype="module"[^>]*\bsrc="([^"]+)"/)?.[1]
  return head.replace(/<link\b[^>]*\brel="modulepreload"[^>]*>/g, (tag) => {
    if (/\bfetchpriority=/.test(tag) || (entry && tag.includes(`href="${entry}"`))) return tag
    return tag.replace('rel="modulepreload"', 'rel="modulepreload" fetchpriority="low"')
  })
}
