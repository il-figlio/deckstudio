// Browser audits against the static demo. Builds the demo into a temp dir (never touches web/site or web/dist),
// serves it on a free port with test/e2e/static.mjs (which applies the site's _headers, CSP included, like the public
// host does), runs every audit, tears down.
//   npm run test:e2e              build + serve + audit
//   E2E_URL=http://host:port npm run test:e2e   audit an already-running demo instead
//   E2E_SHOTS=./shots             keep screenshots there
//   PW_CHANNEL=chrome             use installed Google Chrome instead of Playwright's Chromium
import fs from 'node:fs'
import os from 'node:os'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const EDITOR = path.join(ROOT, 'editor')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-e2e-'))
const AUDITS = ['audit', 'studio', 'dials', 'plugins-demo']
let server
const cleanup = () => { try { server?.kill('SIGTERM') } catch {} fs.rmSync(TMP, { recursive: true, force: true }) }
process.on('exit', cleanup); for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(130))

const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)) }); s.on('error', rej) })
const up = async url => { for (let i = 0; i < 100; i++) { try { if ((await fetch(url)).ok) return true } catch {} await new Promise(r => setTimeout(r, 200)) } return false }

let url = process.env.E2E_URL
if (!url) {
  if (!fs.existsSync(path.join(EDITOR, 'node_modules'))) { console.log('installing editor dependencies…'); execFileSync('npm', ['ci'], { cwd: EDITOR, stdio: 'inherit' }) }
  const site = path.join(TMP, 'site'), reg = path.join(TMP, 'registry')
  // a fixture marketplace, so the demo's plugin audit has entries and nothing depends on a registry on this machine
  execFileSync('node', [path.join(ROOT, 'test/fixtures/mkreg.mjs'), reg, path.join(ROOT, 'test/fixtures/plugin-scaffold')], { stdio: 'ignore' })
  console.log('building demo…')
  const b = spawnSync('npx', ['vite', 'build', '--mode', 'demo', '--outDir', site, '--emptyOutDir'], { cwd: EDITOR, stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, DECKSTUDIO_REGISTRY: reg } })
  if (b.status) { console.error('demo build failed'); process.exit(1) }
  const port = await freePort()
  server = spawn('node', [path.join(ROOT, 'test/e2e/static.mjs'), site, String(port)], { stdio: 'ignore' })
  url = `http://127.0.0.1:${port}/`
  if (!(await up(url))) { console.error('static server did not start'); process.exit(1) }
  // the hosting headers must be what the browser gets
  const h = (await fetch(url)).headers
  for (const [k, re] of [['content-security-policy', /default-src 'self'/], ['x-frame-options', /^DENY$/], ['permissions-policy', /hid=\(self\)/]])
    if (!re.test(h.get(k) || '')) { console.error(`hosting header ${k} missing or wrong: ${h.get(k)}`); process.exit(1) }
}
console.log('auditing', url)
const shots = process.env.E2E_SHOTS ? path.resolve(process.env.E2E_SHOTS) : ''
let failed = 0
for (const a of AUDITS) {
  console.log(`\n=== ${a}`)
  const r = spawnSync('node', [path.join(ROOT, 'test/e2e', a + '.mjs'), url, ...(shots ? [shots] : [])], { stdio: 'inherit', cwd: ROOT, timeout: 300000 })
  if (r.status) { failed++; console.log(`--- ${a} FAILED (exit ${r.status ?? r.signal})`) }
}
console.log(failed ? `\n${failed} audit(s) failed` : '\nall audits passed')
process.exit(failed ? 1 : 0)
