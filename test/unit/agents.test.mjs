// Agent alerting tests: schema/trust, file provider, push/status, hook script (Claude Code + Codex payloads), Rex CLI missing.
// Runs against a scratch DECKSTUDIO_HOME and a tiny HTTP server that serves the same routes as server.mjs (no device).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-agents-'))
process.env.DECKSTUDIO_HOME = HOME
process.env.HOME = HOME // never read the real home
process.env.DECKSTUDIO_REX_CLI = path.join(HOME, 'no-such-rex') // Rex "not installed"
fs.writeFileSync(path.join(HOME, 'token'), 'testtoken', { mode: 0o600 })

const S = await import(`${ROOT}/src/agent-schema.mjs`)
const { AgentHub } = await import(`${ROOT}/src/agents.mjs`)
const RexMod = await import(`${ROOT}/src/rex.mjs`)
const { locateRex, RexAgents } = RexMod
let pass = 0
const t = async (name, fn) => { try { await fn(); pass++; console.log('ok  ', name) } catch (e) { console.log('FAIL', name, '\n    ', e.stack.split('\n').slice(0, 3).join('\n     ')); process.exitCode = 1 } }
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---------- schema / trust ----------
await t('normalizeSession: states, needs kinds, apps, limits', () => {
  const s = S.normalizeSession({ id: 'a1', name: 'web', state: 'blocked', kind: 'permission', app: 'Claude', message: 'x'.repeat(500) }, 'p')
  assert.equal(s.state, 'needs'); assert.equal(s.needs, 'permission'); assert.equal(s.app, 'claude-code'); assert.equal(s.message.length, 200)
  assert.equal(S.normalizeSession({ id: 'b', state: 'needs' }, 'p').needs, 'question')
  assert.equal(S.normalizeSession({ id: 'b', state: 'weird' }, 'p').state, 'idle')
  assert.equal(S.normalizeSession({ id: 'b', app: 'whatever' }, 'p').app, 'custom')
  assert.equal(S.normalizeSession({ name: 'no id' }, 'p'), null)
  assert.equal(S.normalizeSession({ id: 'bad id with spaces' }, 'p'), null)
  assert.equal(S.normalizeSession({ id: 'c', state: 'done' }, 'p').needs, undefined)
})
await t('open: https / declared schemes / bundle ids only, never shell or javascript:', () => {
  const o = r => S.normalizeSession({ id: 'x', open: r }, 'p').open
  assert.deepEqual(o({ type: 'url', url: 'https://example.com' }), { type: 'url', url: 'https://example.com' })
  assert.equal(o({ type: 'url', url: 'javascript:alert(1)' }), null)
  assert.equal(o({ type: 'url', url: 'file:///etc/passwd' }), null)
  assert.equal(o({ type: 'shell', cmd: 'rm -rf ~' }), null)
  assert.equal(o({ type: 'app', target: '/Applications/X.app' }), null)
  assert.deepEqual(o({ type: 'app', target: 'com.apple.Terminal' }), { type: 'app', target: 'com.apple.Terminal' })
})
await t('trust: builtins on, others off; schemes need declaration + user ok', () => {
  assert.equal(S.agentTrust([], 'rex').enabled, true)
  assert.equal(S.agentTrust([], 'claude-code').enabled, true)
  assert.equal(S.agentTrust([], 'codex').enabled, true)
  assert.equal(S.agentTrust([], 'my-app').enabled, false)
  assert.equal(S.agentTrust([{ id: 'rex', enabled: false }], 'rex').enabled, false)
  const [d] = S.parseAgentDocs({ provider: 'my-app', schemes: ['myapp', 'javascript', 'https'], sessions: [{ id: 'a', open: 'myapp://x' }] })
  assert.deepEqual(d.schemes, ['myapp'])
  const s = d.sessions[0]
  assert.ok(S.agentPress(s, S.agentTrust([], 'my-app', d.schemes)).blocked)
  assert.ok(S.agentPress(s, S.agentTrust([{ id: 'my-app', schemes: ['myapp'] }], 'my-app', [])).blocked) // allowed but not declared
  assert.equal(S.agentPress(s, S.agentTrust([{ id: 'my-app', schemes: ['myapp'] }], 'my-app', d.schemes)).blocked, undefined)
  assert.equal(S.agentPress({ open: null }, {}, 'com.example.app').kind, 'app')
})
await t('attention: needs until seen, done → review only after start, sorting', () => {
  const now = Date.now()
  assert.equal(S.attentionOf({ state: 'needs', updatedAt: now }, { baseline: now + 1 }), 'needs')
  assert.equal(S.attentionOf({ state: 'needs', updatedAt: now }, { seen: now + 5 }), 'working')
  assert.equal(S.attentionOf({ state: 'done', updatedAt: now }, { baseline: now + 1 }), 'idle')
  assert.equal(S.attentionOf({ state: 'done', updatedAt: now + 2 }, { baseline: now + 1 }), 'review')
  assert.equal(S.attentionOf({ state: 'error', updatedAt: now + 2 }, { baseline: now + 1 }), 'needs')
  const list = S.sortAgents([{ key: 'a', attention: 'idle' }, { key: 'b', attention: 'needs' }, { key: 'c', attention: 'review' }])
  assert.deepEqual(list.map(x => x.key), ['b', 'c', 'a'])
})
await t('cleanAgentStatus: validation', () => {
  assert.throws(() => S.cleanAgentStatus({ provider: 'rex', id: 'a', state: 'done' }))
  assert.throws(() => S.cleanAgentStatus({ provider: 'Bad Id', id: 'a' }))
  assert.throws(() => S.cleanAgentStatus({ provider: 'ok', id: '' }))
  assert.deepEqual(S.cleanAgentStatus({ provider: 'ok', id: 'a', state: 'gone' }), { provider: 'ok', id: 'a', remove: true })
  assert.equal(S.cleanAgentStatus({ provider: 'ok', id: 'a', state: 'running' }).state, 'working')
})

// ---------- hook mapping ----------
const CC = (ev, extra = {}) => ({ session_id: 'cc-123', transcript_path: '/Users/x/.claude/projects/p/cc-123.jsonl', cwd: '/Users/x/code/web-app', permission_mode: 'default', hook_event_name: ev, ...extra })
await t('hookStatus: Claude Code events', () => {
  const env = { __CFBundleIdentifier: 'com.apple.Terminal' }
  assert.deepEqual(S.hookStatus('claude-code', CC('UserPromptSubmit', { prompt: 'SECRET PROMPT' }), env), { provider: 'claude-code', id: 'cc-123', app: 'claude-code', name: 'web-app', open: { type: 'app', target: 'com.apple.Terminal' }, state: 'working', message: 'working' })
  const perm = S.hookStatus('claude-code', CC('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' }))
  assert.equal(perm.state, 'needs'); assert.equal(perm.needs, 'permission')
  assert.equal(S.hookStatus('claude-code', CC('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'SECRET' } })).message, 'allow Bash?')
  assert.equal(S.hookStatus('claude-code', CC('PreToolUse', { tool_name: 'Edit', tool_input: { x: 'SECRET' } })).state, 'working')
  assert.equal(S.hookStatus('claude-code', CC('Stop', { stop_hook_active: false, last_assistant_message: 'SECRET' })).state, 'done')
  assert.equal(S.hookStatus('claude-code', CC('Notification', { notification_type: 'idle_prompt', message: 'Claude is waiting for your input' })).state, 'done')
  assert.equal(S.hookStatus('claude-code', CC('SessionEnd', { reason: 'other' })).state, 'gone')
  assert.equal(S.hookStatus('claude-code', CC('SubagentStop')), null)
  assert.equal(S.hookStatus('claude-code', { hook_event_name: 'Stop' }), null) // no session id
  for (const ev of ['UserPromptSubmit', 'PermissionRequest', 'PreToolUse', 'Stop']) assert.ok(!JSON.stringify(S.hookStatus('claude-code', CC(ev, { prompt: 'SECRET', tool_input: { a: 'SECRET' }, last_assistant_message: 'SECRET', tool_name: 'Bash' }))).includes('SECRET'))
})
const CODEX = { type: 'agent-turn-complete', 'thread-id': 'b5f6c1c2-1111-2222-3333-444455556666', 'turn-id': '12345', cwd: '/Users/x/code/data-pipeline', 'input-messages': ['SECRET'], 'last-assistant-message': 'SECRET' }
await t('hookStatus: Codex notify', () => {
  const s = S.hookStatus('codex', CODEX, { TERM_PROGRAM: 'iTerm.app' })
  assert.deepEqual(s, { provider: 'codex', id: CODEX['thread-id'], app: 'codex', name: 'data-pipeline', open: { type: 'app', target: 'com.googlecode.iterm2' }, state: 'done', message: 'turn complete' })
  assert.equal(S.hookStatus('codex', { ...CODEX, type: 'approval-requested' }).state, 'needs')
  assert.equal(S.hookStatus('codex', { type: 'something-else', 'thread-id': 'x' }), null)
})

// ---------- Rex CLI missing ----------
await t('Rex CLI missing: not installed, no error, no spam', async () => {
  assert.equal(locateRex({ DECKSTUDIO_REX_CLI: path.join(HOME, 'nope') }), null)
  const fake = path.join(HOME, 'fake-rex'); fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  assert.equal(locateRex({ DECKSTUDIO_REX_CLI: fake }), fake)
  const r = new RexAgents()
  r.start()
  assert.equal(r.installed, false); assert.equal(r.error, null); assert.equal(r.proc, undefined)
  r.stop()
})
await t('Rex discovery (M2): known paths need a verified signature; Spotlight only on opt-in; env overrides as is', () => {
  const { verifyRex, rexCandidates } = RexMod
  const fake = path.join(HOME, 'Applications/Rex.app/Contents/MacOS/rex') // a known-path-like candidate, unsigned
  fs.mkdirSync(path.dirname(fake), { recursive: true }); fs.writeFileSync(fake, '#!/bin/sh\necho pwned\n', { mode: 0o755 })
  assert.ok(rexCandidates({}, HOME).includes(fake), 'the ~/Applications path is a candidate')
  assert.equal(verifyRex(fake), null, 'an unsigned binary fails codesign')
  assert.equal(locateRex({}, { candidates: [fake] }), null, 'unsigned known-path candidate refused')
  assert.equal(locateRex({}, { candidates: [fake], verify: p => p }), fake, 'a verified candidate is used')
  // ad-hoc signed (codesign -s -) verifies but carries no team id → still refused
  const signed = path.join(HOME, 'adhoc-rex'); fs.copyFileSync('/usr/bin/true', signed); fs.chmodSync(signed, 0o755)
  try { execFileSync('/usr/bin/codesign', ['-f', '-s', '-', signed], { stdio: 'ignore' }); assert.equal(verifyRex(signed), null, 'ad-hoc signature has the wrong team') } catch (e) { if (e.code === 'ERR_ASSERTION') throw e }
  // a team-signed system binary passes only when that team is expected (DECKSTUDIO_REX_TEAM)
  assert.equal(verifyRex('/usr/bin/true'), null, 'Apple-signed binary is not Rex')
  // the team id codesign -dv prints is signer-chosen: --verify must also get a requirement anchored at Apple + the team's OU
  const argsLog = path.join(HOME, 'codesign-args'), stub = path.join(HOME, 'codesign-stub'), cand = path.join(HOME, 'req-rex')
  fs.writeFileSync(stub, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${argsLog}'\n[ "$1" = -dv ] && echo TeamIdentifier=ABCDE12345 >&2\nexit 0\n`, { mode: 0o755 })
  fs.writeFileSync(cand, '#!/bin/sh\n', { mode: 0o755 })
  assert.equal(verifyRex(cand, { codesign: stub, team: 'ABCDE12345' }), fs.realpathSync(cand))
  assert.ok(fs.readFileSync(argsLog, 'utf8').split('\n').some(a => a.startsWith('-R=') && a.includes('anchor apple generic') && a.includes('leaf[subject.OU] = "ABCDE12345"')), 'codesign --verify gets -R=anchor apple generic … team')
  let md = 0
  const mdfind = () => { md++; return [fake] }
  assert.equal(locateRex({}, { candidates: [], mdfind }), null); assert.equal(md, 0, 'no Spotlight without DECKSTUDIO_REX_SPOTLIGHT=1')
  assert.equal(locateRex({ DECKSTUDIO_REX_SPOTLIGHT: '1' }, { candidates: [], mdfind }), null, 'Spotlight hit still needs a signature')
  assert.equal(md, process.platform === 'darwin' ? 1 : 0)
  assert.equal(locateRex({ REX_BIN: fake }, { candidates: [] }), fake, 'REX_BIN override used as is')
  assert.equal(locateRex({ DECKSTUDIO_REX_CLI: fake, REX_BIN: '/nope' }), fake, 'DECKSTUDIO_REX_CLI wins')
})

// ---------- hub: file provider, push, status ----------
const profile = { agentProviders: [] }
const hub = new AgentHub({ cfg: () => profile.agentProviders })
hub.start()
const alerts = []
hub.on('alert', a => alerts.push(a))
const DIR = path.join(HOME, 'agents')
await t('rex provider row: not installed, list empty, no error', () => {
  const p = hub.providers()[0]
  assert.equal(p.id, 'rex'); assert.equal(p.installed, false); assert.equal(p.error, null)
  assert.ok(hub.providers().some(x => x.id === 'claude-code' && x.waiting))
  assert.equal(hub.summary().error, null)
})
await t('file provider: off until enabled, then listed, alerts on needs', async () => {
  fs.writeFileSync(path.join(DIR, 'my-app.json'), JSON.stringify({ deckstudio: 'agents/v1', provider: 'my-app', name: 'My App', schemes: ['myapp'], sessions: [
    { id: 's1', name: 'proj', state: 'working', updatedAt: new Date().toISOString() },
    { id: 's2', name: 'proj2', state: 'done', open: 'myapp://s2' },
  ] }))
  hub.scan()
  assert.equal(hub.list().length, 0)
  const row = hub.providers().find(p => p.id === 'my-app')
  assert.equal(row.enabled, false); assert.equal(row.count, 2)
  profile.agentProviders = [{ id: 'my-app', enabled: true }]
  assert.equal(hub.list().length, 2)
  assert.deepEqual(hub.providers().find(p => p.id === 'my-app').blockedSchemes, ['myapp'])
  assert.match(hub.get('my-app:s2').press, /blocked/)
  await assert.rejects(hub.go('my-app:s2'), /links are off/)
  await sleep(20)
  fs.writeFileSync(path.join(DIR, 'my-app.json'), JSON.stringify({ provider: 'my-app', sessions: [{ id: 's1', name: 'proj', state: 'needs', needs: 'question', updatedAt: Date.now() }] }))
  hub.scan()
  assert.equal(alerts.at(-1)?.key, 'my-app:s1')
  assert.equal(hub.counts().needs, 1)
  hub.markSeen('my-app:s1')
  assert.equal(hub.counts().needs, 0)
})
await t('stale sessions (over a day) drop off', () => {
  fs.writeFileSync(path.join(DIR, 'my-app.json'), JSON.stringify({ provider: 'my-app', sessions: [{ id: 'old', state: 'needs', updatedAt: Date.now() - 2 * 86400e3 }] }))
  hub.scan()
  assert.equal(hub.list().filter(a => a.provider === 'my-app').length, 0)
  assert.equal(hub.providers().find(p => p.id === 'my-app').stale, 1)
})
await t('push: doc + merge; rex reserved; status upsert/remove', () => {
  assert.throws(() => hub.push({ provider: 'rex', sessions: [] }), /rex/)
  hub.push({ provider: 'tool-x', name: 'Tool X', sessions: [{ id: 'a', state: 'working' }, { id: 'b', state: 'idle' }] })
  hub.push({ provider: 'tool-x', merge: true, sessions: [{ id: 'a', state: 'done' }] })
  const raw = JSON.parse(fs.readFileSync(path.join(DIR, 'tool-x.json'), 'utf8'))
  assert.equal(raw.deckstudio, 'agents/v1'); assert.equal(raw.name, 'Tool X')
  assert.deepEqual(raw.sessions.map(s => [s.id, s.state]).sort(), [['a', 'done'], ['b', 'idle']])
  hub.status({ provider: 'tool-x', id: 'c', state: 'needs', needs: 'auth', message: 'log in' })
  hub.status({ provider: 'tool-x', id: 'a', state: 'gone' })
  const raw2 = JSON.parse(fs.readFileSync(path.join(DIR, 'tool-x.json'), 'utf8'))
  assert.deepEqual(raw2.sessions.map(s => s.id).sort(), ['b', 'c'])
  assert.equal(raw2.sessions.find(s => s.id === 'c').needs, 'auth')
  assert.equal((fs.statSync(path.join(DIR, 'tool-x.json')).mode & 0o777), 0o600)
  const r = hub.remove('tool-x')
  assert.equal(r.removed, 1); assert.ok(!fs.existsSync(path.join(DIR, 'tool-x.json')))
})

await t('Codex setup warns that notify puts the prompt in argv, visible to other users (docs, editor, recipe)', async () => {
  assert.match(S.CODEX_ARGV_WARNING, /command-line argument/); assert.match(S.CODEX_ARGV_WARNING, /other users/); assert.match(S.CODEX_ARGV_WARNING, /prompt/)
  const guide = fs.readFileSync(path.join(ROOT, 'docs/AGENT-GUIDE.md'), 'utf8')
  const codex = guide.slice(guide.indexOf('**Codex**'), guide.indexOf('**Anything else**'))
  assert.match(codex, /Shared Mac\?/); assert.match(codex, /ps -axww/); assert.match(codex, /prompt/)
  const ui = fs.readFileSync(path.join(ROOT, 'editor/src/app/Agents.tsx'), 'utf8')
  const setup = ui.slice(ui.indexOf('function CodexSetup'), ui.indexOf('function RexSetup'))
  assert.match(setup, /\{CODEX_ARGV_WARNING\}/)
  assert.match(ui, /const codexPrompt = [^\n]*\$\{CODEX_ARGV_WARNING\}/)
  const { RECIPES } = await import(`${ROOT}/src/recipes.mjs`)
  assert.ok(RECIPES.find(r => r.id === 'codex-notify').prompt.includes(S.CODEX_ARGV_WARNING))
  assert.match(fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8'), /Codex, though, hands its notify program/)
})

// ---------- hook script end to end (a mini server with server.mjs's agent routes) ----------
const routes = {
  'POST /api/agents/status': b => hub.status(b),
  'POST /api/agents/hook': b => { const st = S.hookStatus(String(b.source), b.payload, b.env || {}); return st ? hub.status(st) : { ignored: true } },
}
const seenBodies = []
const { helloProof } = await import(`${ROOT}/src/hello.mjs`)
const srv = http.createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c
  const u = new URL(req.url, 'http://x')
  if (u.pathname === '/api/hello') { res.writeHead(200); return res.end(JSON.stringify({ deckstudio: 'hello/v1', id: 'srv1', proof: helloProof('testtoken', u.searchParams.get('nonce'), 'srv1') })) }
  if (req.headers['x-deck-token'] !== 'testtoken') { res.writeHead(401); return res.end('{}') }
  try { const b = JSON.parse(body || '{}'); seenBodies.push(b); const out = await routes[`${req.method} ${req.url}`](b); res.writeHead(200); res.end(JSON.stringify(out)) }
  catch (e) { res.writeHead(400); res.end(JSON.stringify({ error: e.message })) }
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const URL_ = `http://127.0.0.1:${srv.address().port}`
const hook = (args, stdin, env = {}) => new Promise(resolve => {
  const c = execFile(`${ROOT}/bin/deck-agent-hook`, args, { env: { PATH: process.env.PATH, HOME: process.env.HOME, DECKSTUDIO_HOME: HOME, DECKSTUDIO_URL: URL_, ...env }, timeout: 5000 }, (e, so, se) => resolve({ code: e ? e.code ?? 1 : 0, so, se }))
  if (stdin != null) c.stdin.end(stdin); else c.stdin.end()
})
await t('hook script: Claude Code payloads on stdin', async () => {
  let r = await hook(['claude-code'], JSON.stringify(CC('UserPromptSubmit', { prompt: 'SECRET' })), { __CFBundleIdentifier: 'com.apple.Terminal' })
  assert.equal(r.code, 0); assert.equal(r.so, ''); assert.equal(r.se, '')
  assert.equal(hub.get('claude-code:cc-123').state, 'working')
  assert.equal(hub.get('claude-code:cc-123').name, 'web-app')
  r = await hook(['claude-code'], JSON.stringify(CC('Notification', { message: 'Claude needs your permission to use Bash', notification_type: 'permission_prompt' })))
  const a = hub.get('claude-code:cc-123')
  assert.equal(a.attention, 'needs'); assert.equal(a.kind, 'permission')
  assert.deepEqual(a.open, { type: 'app', target: 'com.apple.Terminal' }) // kept from the first event
  await hook(['claude-code'], JSON.stringify(CC('Stop', { last_assistant_message: 'SECRET' })))
  assert.equal(hub.get('claude-code:cc-123').attention, 'review')
  assert.ok(!JSON.stringify(seenBodies).includes('SECRET'), 'no prompt / transcript text leaves the machine… or even the hook')
  await hook(['claude-code'], JSON.stringify(CC('SessionEnd', { reason: 'other' })))
  assert.equal(hub.get('claude-code:cc-123'), null)
})
await t('hook script: Codex notify payload as last argv', async () => {
  const r = await hook(['codex', JSON.stringify(CODEX)], null)
  assert.equal(r.code, 0)
  const a = hub.get(`codex:${CODEX['thread-id']}`)
  assert.equal(a.state, 'done'); assert.equal(a.name, 'data-pipeline'); assert.equal(a.app, 'codex')
})
await t('hook script: generic status + never fails the agent', async () => {
  await hook(['status', 'claude-code', 'manual-1', 'needs', 'look', 'at', 'me'], null)
  assert.equal(hub.get('claude-code:manual-1').message, 'look at me')
  let r = await hook(['claude-code'], 'not json')
  assert.equal(r.code, 0); assert.equal(r.se, '')
  r = await hook(['claude-code'], JSON.stringify(CC('Stop')), { DECKSTUDIO_URL: 'http://127.0.0.1:1' }) // server down
  assert.equal(r.code, 0); assert.equal(r.se, '')
  r = await hook(['claude-code'], JSON.stringify(CC('Stop')), { DECKSTUDIO_HOME: path.join(HOME, 'nowhere') }) // no token
  assert.equal(r.code, 0)
  r = await hook(['claude-code'], JSON.stringify(CC('Stop')), { DECKSTUDIO_TOKEN: 'wrong' })
  assert.equal(r.code, 0)
})
await t('hook script fallback: copied elsewhere → server-side mapping, trimmed payload', async () => {
  const copy = path.join(HOME, 'deck-agent-hook'); fs.copyFileSync(`${ROOT}/bin/deck-agent-hook`, copy); fs.chmodSync(copy, 0o755)
  seenBodies.length = 0
  await new Promise(res => { const c = execFile(copy, ['claude-code'], { env: { PATH: process.env.PATH, DECKSTUDIO_HOME: HOME, DECKSTUDIO_URL: URL_ } }, res); c.stdin.end(JSON.stringify(CC('PermissionRequest', { session_id: 'cc-9', tool_name: 'Bash', tool_input: { command: 'SECRET' } }))) })
  assert.equal(hub.get('claude-code:cc-9').state, 'needs')
  assert.ok(seenBodies.some(b => b.source === 'claude-code' && b.payload))
  assert.ok(!JSON.stringify(seenBodies).includes('SECRET'))
})

await t('hook script: never imports ../src next to it unless ../package.json is deckstudio', async () => {
  const fake = path.join(HOME, 'fake'), marker = path.join(HOME, 'imported')
  fs.mkdirSync(path.join(fake, 'bin'), { recursive: true }); fs.mkdirSync(path.join(fake, 'src'))
  fs.copyFileSync(`${ROOT}/bin/deck-agent-hook`, path.join(fake, 'bin/deck-agent-hook')); fs.chmodSync(path.join(fake, 'bin/deck-agent-hook'), 0o755)
  fs.writeFileSync(path.join(fake, 'src/agent-schema.mjs'), `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'x'); export const hookStatus = () => null`)
  const runIt = () => new Promise(res => { const c = execFile(path.join(fake, 'bin/deck-agent-hook'), ['claude-code'], { env: { PATH: process.env.PATH, DECKSTUDIO_HOME: HOME, DECKSTUDIO_URL: URL_ } }, res); c.stdin.end(JSON.stringify(CC('PermissionRequest', { session_id: 'cc-10' }))) })
  for (const pkg of [null, '{"name":"evil"}', 'not json']) {
    fs.rmSync(path.join(fake, 'package.json'), { force: true })
    if (pkg) fs.writeFileSync(path.join(fake, 'package.json'), pkg)
    seenBodies.length = 0
    await runIt()
    assert.ok(!fs.existsSync(marker), `imported ../src with package.json ${pkg}`)
    // (a package.json that isn't JSON stops Node itself from loading the script: nothing runs, nothing is sent)
    if (pkg !== 'not json') assert.ok(seenBodies.some(b => b.source === 'claude-code' && b.payload), 'fell back to /api/agents/hook')
  }
  fs.writeFileSync(path.join(fake, 'package.json'), '{"name":"deckstudio"}') // a real checkout (by name) does load it
  await runIt()
  assert.ok(fs.existsSync(marker))
})

await t('hook script: the token goes only to loopback, and only to a server that proves it knows it (L5, M1)', async () => {
  const tokens = []
  const squat = http.createServer((req, res) => { tokens.push(req.headers['x-deck-token'] || null); res.writeHead(200); res.end(req.url.startsWith('/api/hello') ? JSON.stringify({ id: 'x', proof: '0'.repeat(64) }) : '{}') })
  await new Promise(r => squat.listen(0, '127.0.0.1', r))
  let r = await hook(['claude-code'], JSON.stringify(CC('Stop')), { DECKSTUDIO_URL: `http://127.0.0.1:${squat.address().port}`, DECK_AGENT_HOOK_DEBUG: '1' })
  assert.equal(r.code, 0); assert.ok(tokens.length >= 1 && tokens.every(x => x === null), `squatter saw a token: ${tokens}`); assert.match(r.se, /did not prove/)
  squat.close()
  r = await hook(['claude-code'], JSON.stringify(CC('Stop')), { DECKSTUDIO_URL: 'http://evil.example:7337', DECK_AGENT_HOOK_DEBUG: '1' })
  assert.equal(r.code, 0); assert.match(r.se, /loopback/)
  r = await hook(['claude-code'], JSON.stringify(CC('Stop')), { DECKSTUDIO_URL: 'https://127.0.0.1:7337', DECK_AGENT_HOOK_DEBUG: '1' })
  assert.match(r.se, /loopback/)
})

srv.close(); hub.stop()
fs.rmSync(HOME, { recursive: true, force: true })
console.log(`\n${pass} passed${process.exitCode ? ', some FAILED' : ''}`)
