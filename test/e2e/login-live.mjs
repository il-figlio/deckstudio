// Live check of the editor login (not part of `npm run test:e2e`: it needs a running DeckStudio). Read-only: it
// opens the editor, never edits, presses or saves.
//   node test/e2e/login-live.mjs            (DeckStudio running: bin/deckctl start)
// `deckctl open --print` gives a one-time /#c=<code> link; the editor must trade it for the token, strip the
// fragment, connect; the same link must not work twice; an old-style #t=<token> link must not log in.
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { launch } from './lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const link = () => execFileSync(path.join(ROOT, 'bin/deckctl'), ['open', '--print']).toString().trim()
let fail = 0
const ok = (c, what, note = '') => { if (!c) fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${what}${note ? '  ' + note : ''}`) }

const b = await launch()
try {
  const url = link()
  ok(/^http:\/\/127\.0\.0\.1:\d+\/#c=[0-9a-f]{32}$/.test(url), 'deckctl open --print gives a one-time code link, no token', url.replace(/[0-9a-f]{32}$/, '<code>'))
  const ctx = await b.newContext()
  const page = await ctx.newPage()
  const calls = []
  page.on('request', r => { if (r.url().includes('/api/')) calls.push(`${r.method()} ${new URL(r.url()).pathname}`) })
  let wsProto = null
  page.on('websocket', ws => { wsProto = ws.url() })
  await page.goto(url)
  await page.waitForSelector('[data-ds-key]', { timeout: 15000 })
  ok(!page.url().includes('#'), 'fragment stripped from the address bar', page.url())
  const tok = await page.evaluate(() => sessionStorage.getItem('deckToken'))
  ok(/^[0-9a-f]{48}$/.test(tok || ''), 'token in sessionStorage')
  ok(calls.includes('POST /api/login'), 'editor called POST /api/login')
  await page.waitForFunction(() => !document.body.innerText.includes('not reachable'), null, { timeout: 8000 }).catch(() => {})
  ok(wsProto && !wsProto.includes('token'), 'WebSocket URL carries no token', wsProto || 'no websocket')
  ok(await page.waitForSelector('[data-ds-key] img', { timeout: 10000 }).then(() => true, () => false), 'WebSocket connected (key frames arrived via the subprotocol token)')
  const st = await page.evaluate(async t => (await fetch('/api/state', { headers: { 'x-deck-token': t } })).status, tok)
  ok(st === 200, 'the traded token works for the API', String(st))
  const hist = await page.evaluate(() => location.href)
  ok(!hist.includes(tok), 'token never in the URL')

  // reuse the same code in a fresh browser context: gate, no token
  const ctx2 = await b.newContext(); const p2 = await ctx2.newPage()
  await p2.goto(url); await p2.waitForSelector('[data-ds-gate]', { timeout: 10000 }).catch(() => {})
  ok(await p2.locator('[data-ds-gate]').count() === 1 && !(await p2.evaluate(() => sessionStorage.getItem('deckToken'))), 'a used code does not log in again')
  // an old-style token link: ignored, stripped
  const ctx3 = await b.newContext(); const p3 = await ctx3.newPage()
  await p3.goto(`${new URL(url).origin}/#t=${tok}`); await p3.waitForSelector('[data-ds-gate]', { timeout: 10000 }).catch(() => {})
  ok(await p3.locator('[data-ds-gate]').count() === 1 && !p3.url().includes(tok), '#t=<token> links are refused and stripped')
  // cross-origin login attempt
  const xo = await fetch(`${new URL(url).origin}/api/login`, { method: 'POST', headers: { origin: 'https://evil.example', 'content-type': 'application/json' }, body: JSON.stringify({ code: '0'.repeat(32) }) })
  ok(xo.status === 403, 'cross-origin POST /api/login refused', String(xo.status))
} catch (e) { ok(false, 'script error', e.message.split('\n')[0]) }
await b.close()
console.log(fail ? `${fail} failed` : 'all passed')
process.exit(fail ? 1 : 0)
