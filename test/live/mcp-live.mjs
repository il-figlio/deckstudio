// LIVE test: drives bin/deckstudio-mcp against a RUNNING DeckStudio server (your real deck and profile).
// Read-only except a temporary overlay (deck_flash → deck_clear) and dry-run edits, but it is still your real
// device, so it only runs when you ask:   DECKSTUDIO_LIVE_TESTS=1 npm run test:live
// DECKSTUDIO_URL (default http://127.0.0.1:7337) and DECKSTUDIO_HOME (default ~/.deckstudio) are honored.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.DECKSTUDIO_LIVE_TESTS !== '1') { console.log('skipped: live test touches a running DeckStudio; set DECKSTUDIO_LIVE_TESTS=1 to run it'); process.exit(0) }
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/deckstudio-mcp')
const HOME_DIR = process.env.DECKSTUDIO_HOME || path.join(os.homedir(), '.deckstudio')
const URL0 = (process.env.DECKSTUDIO_URL || 'http://127.0.0.1:7337').replace(/\/$/, '')
const HOSTPORT = new URL(URL0).host.replace(/\./g, '\\.')
const TOKEN = fs.readFileSync(path.join(HOME_DIR, 'token'), 'utf8').trim()
let pass = 0, failN = 0
const ok = (c, msg, extra = '') => { if (c) { pass++; console.log(`  ✓ ${msg}`) } else { failN++; console.log(`  ✗ ${msg} ${extra}`) } }

function client(env = {}) {
  const p = spawn(BIN, [], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] })
  let buf = '', raw = '', stderr = ''
  const waiting = new Map(), badLines = []
  p.stdout.on('data', d => {
    raw += d; buf += d
    let i
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1)
      let m; try { m = JSON.parse(line) } catch { badLines.push(line); continue }
      if (m.jsonrpc !== '2.0') badLines.push(line)
      if (m.id != null && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) }
    }
  })
  p.stderr.on('data', d => { stderr += d })
  let id = 0
  const rpc = (method, params) => new Promise((res, rej) => {
    const n = ++id; waiting.set(n, res)
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n')
    setTimeout(() => waiting.has(n) && rej(new Error(`timeout ${method}`)), 20000)
  })
  const notify = (method, params) => p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  const call = async (name, args = {}) => { const r = await rpc('tools/call', { name, arguments: args }); return { isError: !!r.result?.isError, text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error), r } }
  return { p, rpc, notify, call, get raw() { return raw }, get stderr() { return stderr }, badLines, close: () => new Promise(r => { p.on('exit', r); p.stdin.end() }) }
}
const j = t => { try { return JSON.parse(t) } catch { return null } }

console.log('# live server')
const c = client()
const init = await c.rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mcp-tests', version: '0' } })
ok(init.result?.protocolVersion === '2025-06-18', `initialize negotiates 2025-06-18 → ${init.result?.protocolVersion}`)
ok(init.result?.serverInfo?.name === 'deckstudio' && init.result?.capabilities?.tools, 'serverInfo + tools capability')
c.notify('notifications/initialized', {})
const tl = await c.rpc('tools/list', {})
const names = tl.result.tools.map(t => t.name)
console.log('  tools:', names.join(', '))
for (const n of ['deck_status', 'deck_flash', 'deck_clear', 'deck_goto_page', 'deck_get_profile', 'deck_set_key', 'deck_set_dial', 'deck_recipes_list', 'deck_recipe_apply', 'deck_plugins_list', 'deck_plugin_info', 'deck_plugin_run_action', 'deck_plugin_enable', 'deck_log_tail', 'deck_bots_push_status', 'deck_agents_list'])
  ok(names.includes(n), `tool ${n} listed`)
ok(!names.some(n => /grant|install/.test(n)), 'no grant/install tools')
ok(!JSON.stringify(tl.result).includes(TOKEN), 'token not in tool list')
ok(tl.result.tools.every(t => t.inputSchema?.type === 'object'), 'every inputSchema is an object schema')

const profileBefore = await fetch(URL0 + '/api/state', { headers: { 'x-deck-token': TOKEN } }).then(r => r.json())

let r = await c.call('deck_status'); const st = j(r.text)
ok(!r.isError && st && 'connected' in st && st.pages.length > 0, `deck_status → connected=${st?.connected} page=${st?.page} pages=${st?.pages?.length} vars=${JSON.stringify(st?.vars)}`)
r = await c.call('deck_get_profile'); ok(!r.isError && j(r.text)?.pages?.length, `deck_get_profile summary (${r.text.length} chars)`)
r = await c.call('deck_get_profile', { page: st.page, full: true }); ok(!r.isError && j(r.text)?.json?.keys?.length === 8, 'deck_get_profile full page has 8 keys')
r = await c.call('deck_get_profile', { page: 'no-such-page' }); ok(r.isError && /no page/.test(r.text), `bad page → error: ${r.text.slice(0, 60)}`)
r = await c.call('deck_plugins_list', { registry: true }); const pl = j(r.text)
ok(!r.isError && pl?.plugins?.length, `deck_plugins_list → ${pl?.plugins?.map(p => `${p.id}:${p.state}`).join(' ')}; registry: ${JSON.stringify(pl?.registry).slice(0, 80)}`)
r = await c.call('deck_plugin_info', { id: 'capture' }); ok(!r.isError && j(r.text)?.manifest, 'deck_plugin_info capture has manifest')
r = await c.call('deck_plugin_enable', { id: 'capture', reason: 'test' }); ok(!r.isError && new RegExp(HOSTPORT + '/#plugins').test(r.text) && j(r.text)?.changed === false, `deck_plugin_enable changes nothing → ${j(r.text)?.status}`)
r = await c.call('deck_plugin_run_action', { id: 'capture', action: 'nope' }); ok(r.isError, `unknown plugin action refused: ${r.text.slice(0, 70)}`)
r = await c.call('deck_recipes_list'); const rl = j(r.text); ok(!r.isError && rl?.recipes?.length, `deck_recipes_list → ${rl?.recipes?.length} recipes`)
r = await c.call('deck_recipes_list', { where: 'key', query: 'capture' }); ok(!r.isError, `filtered recipes → ${j(r.text)?.recipes?.map(x => x.id).join(', ')}`)
const keyRecipe = rl.recipes.find(x => x.where === 'key' && x.applicable)
r = await c.call('deck_recipes_list', { id: keyRecipe.id }); ok(!r.isError && j(r.text)?.prompt, `recipe ${keyRecipe.id} in full`)
r = await c.call('deck_recipe_apply', { id: keyRecipe.id, key: 8, dry_run: true }); ok(!r.isError && j(r.text)?.saved === false, `deck_recipe_apply dry_run → replaces ${JSON.stringify(j(r.text)?.target?.replaces).slice(0, 80)}`)
r = await c.call('deck_log_tail', { lines: 5 }); ok(!r.isError, `deck_log_tail:\n${r.text.split('\n').map(l => '      ' + l).join('\n')}`)
r = await c.call('deck_log_tail', { lines: 3, errors_only: true }); ok(!r.isError, 'deck_log_tail errors_only')

r = await c.call('deck_goto_page', { page: st.page }); ok(!r.isError && j(r.text)?.page === st.page, 'deck_goto_page to the current page (no-op)')
r = await c.call('deck_goto_page', { page: 'no-such-page' }); ok(r.isError, 'deck_goto_page unknown page refused')
r = await c.call('deck_bots_push_status', { provider: 'grokbot', id: 'x', awaiting: true }); ok(r.isError && /reserved/.test(r.text), 'grokbot provider refused')
r = await c.call('deck_bots_push_status', { provider: 'mcp-test-nonexistent', id: 'x', awaiting: true }); ok(r.isError && /give `name`/.test(r.text), `new bot without name refused (nothing written): ${r.text}`)
ok(!fs.existsSync(path.join(HOME_DIR, 'bots/mcp-test-nonexistent.json')), 'no bots file created')
r = await c.call('deck_agents_list'); ok(!r.isError && j(r.text)?.counts, `deck_agents_list → counts ${JSON.stringify(j(r.text)?.counts)}, shown ${j(r.text)?.agents?.length}/${j(r.text)?.total}`)
// dry runs (never saved)
r = await c.call('deck_set_key', { key: 8, set: { label: 'mcp test', glyph: 'checkmark' }, dry_run: true }); let d = j(r.text)
ok(!r.isError && d?.dry_run && d.saved === false && d.changes.length, `deck_set_key dry_run diff: ${JSON.stringify(d?.changes)}`)
r = await c.call('deck_set_key', { key: 2, set: { onPress: { type: 'shell', cmd: 'echo hi' } }, dry_run: true }); d = j(r.text)
ok(!r.isError && d?.warnings?.some(w => /shell/.test(w)), 'shell action dry run warns')
r = await c.call('deck_set_key', { key: 9, set: { label: 'x' }, dry_run: true }); ok(r.isError && /1–8/.test(r.text), `key 9 rejected: ${r.text}`)
r = await c.call('deck_set_key', { key: 1, set: { onPress: { type: 'bogus' } }, dry_run: true }); ok(r.isError && /unknown action/.test(r.text), 'unknown action type rejected')
r = await c.call('deck_set_key', { key: 1, dry_run: true }); ok(r.isError, 'set/replace required')
r = await c.call('deck_set_dial', { dial: 2, set: { label: 'mcp' }, dry_run: true }); ok(!r.isError && j(r.text)?.saved === false, `deck_set_dial dry_run: ${JSON.stringify(j(r.text)?.changes)}`)
r = await c.call('deck_set_dial', { dial: 5, set: { label: 'x' }, dry_run: true }); ok(r.isError, 'dial 5 rejected')

// temporary overlay
const ovBefore = Object.keys(profileBefore.overlay || {})
r = await c.call('deck_flash', { target: 'key', index: 8, label: 'MCP ✓', bg: '#1d5f3a' }); ok(!r.isError, `deck_flash key 8: ${r.text.replace(/\s+/g, ' ').slice(0, 100)}`)
let s2 = await fetch(URL0 + '/api/state', { headers: { 'x-deck-token': TOKEN } }).then(r => r.json())
ok(s2.overlay?.[s2.page]?.keys?.[7]?.label === 'MCP ✓', 'overlay visible in /api/state')
r = await c.call('deck_flash', { target: 'toast', text: 'mcp test', ms: 800 }); ok(!r.isError, 'deck_flash toast')
r = await c.call('deck_flash', { target: 'key', index: 1, onPress: { type: 'shell' } }); ok(r.isError, 'deck_flash rejects non-appearance fields')
await new Promise(r => setTimeout(r, 700))
r = await c.call('deck_clear', ovBefore.length ? { page: s2.page } : {}); ok(!r.isError, 'deck_clear')
s2 = await fetch(URL0 + '/api/state', { headers: { 'x-deck-token': TOKEN } }).then(r => r.json())
ok(!s2.overlay?.[s2.page]?.keys?.[7], 'overlay gone')
ok(JSON.stringify(s2.profile) === JSON.stringify(profileBefore.profile), 'saved profile unchanged by the whole run')

const rl2 = await c.rpc('resources/list', {}); ok(rl2.result?.resources?.length >= 2, `resources: ${rl2.result?.resources?.map(x => x.uri).join(', ')}`)
const rr = await c.rpc('resources/read', { uri: 'deckstudio://docs/agent-guide' }); ok(rr.result?.contents?.[0]?.text?.includes('DeckStudio'), 'resource read')
const unk = await c.rpc('nonexistent/method', {}); ok(unk.error?.code === -32601, `unknown method → ${unk.error?.code}`)
await c.close()
ok(c.badLines.length === 0, `stdout only JSON-RPC frames (${c.raw.split('\n').filter(Boolean).length} frames, bad: ${c.badLines.length})`)
ok(!c.raw.includes(TOKEN) && !c.stderr.includes(TOKEN), 'token never on stdout/stderr')
console.log('  stderr:', JSON.stringify(c.stderr.trim()))

console.log('# protocol negotiation')
const c3 = client()
const i3 = await c3.rpc('initialize', { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 't', version: '0' } })
ok(/^\d{4}-\d{2}-\d{2}$/.test(i3.result?.protocolVersion || '') && i3.result.protocolVersion !== '1999-01-01', `unknown version → server offers ${i3.result?.protocolVersion}`)
await c3.close()

console.log('# server down (DECKSTUDIO_URL=http://127.0.0.1:7399)')
const c2 = client({ DECKSTUDIO_URL: 'http://127.0.0.1:7399' })
await c2.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } })
c2.notify('notifications/initialized', {})
for (const n of ['deck_status', 'deck_plugins_list', 'deck_recipes_list']) { r = await c2.call(n); ok(r.isError && /not running/.test(r.text) && /deckctl start/.test(r.text), `${n} → ${r.text}`) }
r = await c2.call('deck_log_tail', { lines: 2 }); ok(!r.isError, 'deck_log_tail still works (reads the file)')
await c2.close(); ok(c2.badLines.length === 0, 'stdout clean when down')

console.log('# non-loopback URL refused')
const c4 = client({ DECKSTUDIO_URL: 'http://example.com:7337' })
await c4.rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } })
r = await c4.call('deck_status'); ok(r.isError && /loopback/.test(r.text), `→ ${r.text.slice(0, 90)}`)
await c4.close()

console.log(`\n${pass} passed, ${failN} failed`)
process.exit(failN ? 1 : 0)
