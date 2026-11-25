// One-time editor login codes (src/login.mjs): deckctl open → /#c=<code> → POST /api/login → token.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const { loginCodes } = await import(path.join(ROOT, 'src/login.mjs'))

test('a code works once', () => {
  const L = loginCodes()
  const c = L.issue()
  assert.match(c, /^[0-9a-f]{32}$/)
  assert.equal(L.redeem(c), 'ok')
  assert.equal(L.redeem(c), 'bad')
})

test('a code expires after ttl', () => {
  let t = 1000
  const L = loginCodes({ ttl: 60e3, now: () => t })
  const c = L.issue()
  t += 60e3
  assert.equal(L.redeem(c), 'bad')
})

test('junk is refused; after 10 bad tries in a minute wrong codes get limited, a valid code still works', () => {
  let t = 0
  const L = loginCodes({ now: () => t })
  const c = L.issue()
  for (const junk of [undefined, null, 42, {}, '', 'x'.repeat(5000), c.toUpperCase()]) assert.equal(L.redeem(junk), 'bad')
  for (let i = 0; i < 3; i++) L.redeem('0'.repeat(32))
  assert.equal(L.redeem('1'.repeat(32)), 'limited')
  assert.equal(L.redeem(c), 'ok') // junk POSTs can't lock the owner out
  const c2 = L.issue()
  t += 61e3
  assert.equal(L.redeem(c2), 'bad') // expired by now
  assert.equal(L.redeem(L.issue()), 'ok')
})

test('only hashes are kept; at most 16 live codes', () => {
  const L = loginCodes()
  const codes = Array.from({ length: 20 }, () => L.issue())
  assert.equal(L.redeem(codes[0]), 'bad') // evicted
  assert.equal(L.redeem(codes[19]), 'ok')
})

test('the server and deckctl use the code flow, never #t=<token>', () => {
  const ctl = fs.readFileSync(path.join(ROOT, 'bin/deckctl'), 'utf8')
  assert.doesNotMatch(ctl, /#t=/)
  assert.match(ctl, /\/api\/login-code/)
  const srv = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8')
  assert.match(srv, /'POST \/api\/login-code'/)
  assert.doesNotMatch(srv, /searchParams\.get\('token'\)/) // the WebSocket token isn't read from the URL
  const store = fs.readFileSync(path.join(ROOT, 'editor/src/app/store.ts'), 'utf8')
  assert.doesNotMatch(store, /ws\?token=/)
})

// ---------- deckctl open: the code never in argv; POST /api/login only from the editor's own origin ----------
// A stub with server.mjs's login, hello and icon logic (same modules), so no device is touched.
const os = await import('node:os')
const http = await import('node:http')
const { execFile } = await import('node:child_process')
const { helloProof } = await import(path.join(ROOT, 'src/hello.mjs'))
const { loginRequestOk, assetRequestOk } = await import(path.join(ROOT, 'src/same-origin.mjs'))

async function stub() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-login-'))
  const TOKEN = 'a'.repeat(48), L = loginCodes()
  fs.writeFileSync(path.join(home, 'token'), TOKEN, { mode: 0o600 })
  const tokenOk = t => t === TOKEN
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x'), send = (c, b) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(b ?? {})) }
    if (u.pathname === '/api/hello') return send(200, { deckstudio: 'hello/v1', id: 's1', proof: helloProof(TOKEN, u.searchParams.get('nonce'), 's1') })
    if (u.pathname === '/api/login') {
      if (!loginRequestOk(req, hosts)) return send(403)
      let s = ''; for await (const c of req) s += c
      const r = L.redeem(JSON.parse(s || '{}').code)
      return r === 'ok' ? send(200, { token: TOKEN }) : send(401, { error: r })
    }
    if (u.pathname.startsWith('/logos/')) return assetRequestOk(req, tokenOk) ? send(200) : send(403)
    if (!tokenOk(req.headers['x-deck-token'])) return send(401)
    if (u.pathname === '/api/login-code') return send(200, { code: L.issue() })
    send(200, {})
  })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port, hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  return { home, port, L, close: () => { srv.close(); fs.rmSync(home, { recursive: true, force: true }) } }
}
// a raw request (fetch may not let us set Sec-Fetch-Site / Origin): → status
const req = (port, method, p, headers = {}, body) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, res => { let s = ''; res.on('data', c => s += c); res.on('end', () => resolve({ status: res.statusCode, body: s })) })
  r.on('error', reject); r.end(body)
})
const login = (port, code, headers) => req(port, 'POST', '/api/login', { 'content-type': 'application/json', ...headers }, JSON.stringify({ code }))

test('deckctl open hands the link to osascript on stdin: no 32-hex code in any argv, and it redeems exactly once', async () => {
  const s = await stub()
  try {
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-fakebin-')), log = path.join(bin, 'log')
    for (const name of ['open', 'osascript']) // record argv and stdin of whatever deckctl starts
      fs.writeFileSync(path.join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> "${log}.argv"\ncat >> "${log}.stdin"\n`, { mode: 0o755 })
    const run = (...args) => new Promise(resolve => execFile(process.execPath, [path.join(ROOT, 'bin/deckctl'), 'open', ...args],
      { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: s.home, DECKSTUDIO_HOME: s.home, DECKSTUDIO_PORT: String(s.port) } }, (e, out, err) => resolve({ code: e?.code ?? 0, out, err })))
    const r = await run()
    assert.equal(r.code, 0, r.err)
    const argv = fs.readFileSync(`${log}.argv`, 'utf8'), stdin = fs.readFileSync(`${log}.stdin`, 'utf8')
    assert.equal(argv.trim(), 'osascript -') // only osascript, never `open <url>`
    assert.doesNotMatch(argv, /[0-9a-f]{32}/)
    const m = /^open location "http:\/\/127\.0\.0\.1:(\d+)\/#c=([0-9a-f]{32})"\n$/.exec(stdin)
    assert.ok(m, stdin); assert.equal(Number(m[1]), s.port)
    const origin = { origin: `http://127.0.0.1:${s.port}`, 'sec-fetch-site': 'same-origin' }
    assert.equal((await login(s.port, m[2], origin)).status, 200)
    assert.equal((await login(s.port, m[2], origin)).status, 401) // single use
    // --dev only prints the link (another user could squat the Vite port); nothing is started
    fs.rmSync(`${log}.argv`)
    const d = await run('--dev')
    assert.equal(d.code, 0, d.err); assert.match(d.out, /^http:\/\/localhost:5610\/#c=[0-9a-f]{32}\n$/); assert.ok(!fs.existsSync(`${log}.argv`))
    fs.rmSync(bin, { recursive: true, force: true })
  } finally { s.close() }
})

test('POST /api/login is refused without the editor\'s own Origin (curl with a leaked code gets 403, the code survives)', async () => {
  const s = await stub()
  try {
    const code = s.L.issue(), own = `http://127.0.0.1:${s.port}`
    for (const h of [{}, { origin: 'null' }, { origin: 'https://evil.example' }, { origin: `https://127.0.0.1:${s.port}` }, { origin: 'http://127.0.0.1:1' },
      { origin: own, 'sec-fetch-site': 'cross-site' }, { origin: own, 'sec-fetch-site': 'same-site' }, { origin: own, 'sec-fetch-site': 'none' }])
      assert.equal((await login(s.port, code, h)).status, 403, JSON.stringify(h))
    assert.equal((await login(s.port, code, { origin: `http://localhost:${s.port}`, 'sec-fetch-site': 'same-origin' })).status, 200)
  } finally { s.close() }
})

test('icons (/logos, /plugin-icon, /botavatar): only same-origin page loads or a token holder', async () => {
  const s = await stub()
  try {
    for (const h of [{}, { 'sec-fetch-site': 'cross-site' }, { 'sec-fetch-site': 'same-site' }, { 'sec-fetch-site': 'none' }, { 'x-deck-token': 'wrong' }])
      assert.equal((await req(s.port, 'GET', '/logos/app-x.png', h)).status, 403, JSON.stringify(h))
    assert.equal((await req(s.port, 'GET', '/logos/app-x.png', { 'sec-fetch-site': 'same-origin' })).status, 200)
    assert.equal((await req(s.port, 'GET', '/logos/app-x.png', { 'x-deck-token': 'a'.repeat(48) })).status, 200)
  } finally { s.close() }
})

test('server.mjs uses these checks for /api/login and the icon routes', () => {
  const srv = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8')
  assert.match(srv, /async function login\(req, res\) \{\n\s+if \(!loginRequestOk\(req, ALLOWED_HOSTS\)\) return json\(res, 403/)
  assert.match(srv, /\/\^\\\/\(logos\|plugin-icon\|botavatar\)\\\/\/\.test\(pathname\) && !assetRequestOk\(req, tokenOk\)\) \{ res\.writeHead\(403/)
  assert.doesNotMatch(srv, /crossSite/)
  const ctl = fs.readFileSync(path.join(ROOT, 'bin/deckctl'), 'utf8')
  assert.doesNotMatch(ctl, /spawn\('open'/)
  assert.match(fs.readFileSync(path.join(ROOT, 'SECURITY.md'), 'utf8'), /osascript/)
})
