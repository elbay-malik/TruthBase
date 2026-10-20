// Phase 12: Lighthouse scores and lab Core Web Vitals for the README.
//
//   pnpm exec playwright-core install --only-shell chromium   # once
//   pnpm build && PORT=3100 NUXT_TRUSTED_IP_HEADER=x-audit-ip node --env-file=.env .output/server/index.mjs
//   pnpm lighthouse [--base http://localhost:3100] [--runs 3] [--chunk <id>] [--out .cache/lighthouse]
//
// Runs Lighthouse (pinned below) with the mobile and desktop presets against
// `/` and the citation deep link `/?chunk=<id>`, `--runs` times each, keeps
// every JSON report in `--out` and prints the medians as a Markdown table.
// Neither page calls /api/chat or /api/search, so no LLM quota is spent.
//
// Measure a production build, not `pnpm dev` (no compression, unbundled
// modules). Chrome for Testing gives NO_FCP in headless mode, so the browser is
// chrome-headless-shell from the Playwright cache, or CHROME_PATH. For a local
// server every run sends its own `x-audit-ip`, so the per-minute limiter does
// not see one client; it only counts when the server trusts that header.

import { spawn } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const LIGHTHOUSE = 'lighthouse@13.5.0'
const ROOT = resolve(import.meta.dirname, '..')
const { values } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://localhost:3100' },
    runs: { type: 'string', default: '3' },
    // A g-020 citation (nist-csf-2.0.pdf, p. 28) in the demo corpus.
    chunk: { type: 'string', default: '664d16ef-4847-4c7f-a74f-d4c6838825b2' },
    out: { type: 'string', default: join(ROOT, '.cache/lighthouse') },
  },
})
const base = values.base.replace(/\/$/, '')
const runs = Number(values.runs)
if (!Number.isInteger(runs) || runs < 1) throw new Error(`--runs must be a positive integer, got ${values.runs}`)
const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)

function chromePath() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH
    ?? (process.platform === 'darwin' ? join(homedir(), 'Library/Caches/ms-playwright') : join(homedir(), '.cache/ms-playwright'))
  const shells = existsSync(cache) ? readdirSync(cache).filter(d => d.startsWith('chromium_headless_shell-')).sort().reverse() : []
  for (const shell of shells) {
    for (const platform of readdirSync(join(cache, shell))) {
      const bin = join(cache, shell, platform, 'chrome-headless-shell')
      if (existsSync(bin)) return bin
    }
  }
  throw new Error('chrome-headless-shell not found: run `pnpm exec playwright-core install --only-shell chromium` or set CHROME_PATH')
}
const chrome = chromePath()

const pages = [['root', '/'], ['deeplink', `/?chunk=${values.chunk}`]]
const presets = ['mobile', 'desktop']

function lighthouse(url, preset, outputPath, ip) {
  const args = ['dlx', LIGHTHOUSE, url, '--quiet', '--output=json', `--output-path=${outputPath}`, '--chrome-flags=--headless --no-sandbox']
  if (preset === 'desktop') args.push('--preset=desktop')
  if (ip) args.push(`--extra-headers=${JSON.stringify({ 'x-audit-ip': ip })}`)
  return new Promise((done, fail) => {
    const child = spawn('pnpm', args, { cwd: ROOT, env: { ...process.env, CHROME_PATH: chrome }, stdio: ['ignore', 'ignore', 'inherit'] })
    child.on('error', fail)
    child.on('exit', code => (code === 0 ? done() : fail(new Error(`lighthouse exited ${code} for ${url} (${preset})`))))
  })
}

function summarise(report) {
  if (report.runtimeError) throw new Error(`${report.finalDisplayedUrl}: ${report.runtimeError.code} ${report.runtimeError.message}`)
  const score = id => Math.round(report.categories[id].score * 100)
  const audit = id => report.audits[id].numericValue
  return {
    perf: score('performance'),
    a11y: score('accessibility'),
    bp: score('best-practices'),
    seo: score('seo'),
    fcp: audit('first-contentful-paint'),
    lcp: audit('largest-contentful-paint'),
    tbt: audit('total-blocking-time'),
    cls: audit('cumulative-layout-shift'),
    si: audit('speed-index'),
    kib: audit('total-byte-weight') / 1024,
  }
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

await mkdir(values.out, { recursive: true })
// One fresh client address per run.
const octet = 1 + Math.floor(Math.random() * 250)
let n = 0
const rows = []
for (const [name, path] of pages) {
  for (const preset of presets) {
    const results = []
    for (let run = 1; run <= runs; run++) {
      const file = join(values.out, `${name}-${preset}-${run}.json`)
      await lighthouse(base + path, preset, file, local ? `100.67.${octet}.${++n}` : undefined)
      const result = summarise(JSON.parse(await readFile(file, 'utf8')))
      console.error(`${name} ${preset} #${run}: perf ${result.perf}, a11y ${result.a11y}, bp ${result.bp}, seo ${result.seo}`)
      results.push(result)
    }
    const m = Object.fromEntries(Object.keys(results[0]).map(k => [k, median(results.map(r => r[k]))]))
    const ms = v => `${Math.round(v)} ms`
    rows.push(`| \`${path === '/' ? '/' : '/?chunk=…'}\` | ${preset} | ${m.perf} | ${m.a11y} | ${m.bp} | ${m.seo} | ${ms(m.fcp)} | ${ms(m.lcp)} | ${ms(m.tbt)} | ${m.cls.toFixed(3)} | ${ms(m.si)} | ${Math.round(m.kib)} |`)
  }
}

console.log(`Lighthouse ${LIGHTHOUSE.split('@')[1]}, ${base}, median of ${runs} run${runs > 1 ? 's' : ''} (reports in ${values.out})\n`)
console.log('| Page | Preset | Perf | A11y | BP | SEO | FCP | LCP | TBT | CLS | SI | KiB |')
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|')
for (const row of rows) console.log(row)
