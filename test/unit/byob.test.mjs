// Bring-your-own-bots tests. Run: node test/unit/byob.test.mjs (own DECKSTUDIO_HOME / HOME in a temp dir)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import https from 'node:https'
import http from 'node:http'
import zlib from 'node:zlib'
import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-byob-'))
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
process.env.DECKSTUDIO_HOME = SCRATCH
process.env.HOME = SCRATCH // never read the real home
const DS = path.join(ROOT, 'src')
const S = await import(path.join(DS, 'bot-schema.mjs'))
const { BotHub, BOTS_DIR, fetchAvatar, blockedAddress } = await import(path.join(DS, 'bots.mjs'))
const R = await import(path.join(DS, 'render-spec.mjs'))
const { normalizeProfile } = await import(path.join(DS, 'engine.mjs'))
const { createCanvas, loadImage } = await import('@napi-rs/canvas')

let pass = 0, fail = 0
const ok = (cond, name, extra = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }
const rejects = async (p, re, name) => { try { await p; ok(false, name, '(resolved)') } catch (e) { ok(re.test(e.message), name, `→ ${e.message}`) } }
const throwsSync = (f, re, name) => { try { f(); ok(false, name, '(no throw)') } catch (e) { ok(re.test(e.message) || re.test(String(e.code)), name, `→ ${e.code || ''} ${e.message}`) } }
const hub = () => { const h = new BotHub(); h.cfg = () => h._cfg; h._cfg = []; return h }

// ---------- 14. bots dir created 0700 at startup ----------
{
  const h = hub(); h.start(() => {}); h.stop()
  const st = fs.statSync(BOTS_DIR)
  ok(st.isDirectory() && (st.mode & 0o777) === 0o700, '14 bots dir created at start with mode 0700', (st.mode & 0o777).toString(8))
}

// ---------- 1. trust model ----------
{
  const doc = {
    provider: 'acme', name: 'Acme', app: '/Applications/Calculator.app', schemes: ['acme', 'javascript', 'smb'],
    allowShell: true, botProviders: [{ id: 'acme', allowShell: true, enabled: true }], // a doc can't trust itself
    bots: [
      { id: 'h', name: 'Https', open: { type: 'url', url: 'https://example.com/x' } },
      { id: 's', name: 'Shell', open: { type: 'shell', cmd: 'touch /tmp/pwned' } },
      { id: 'c', name: 'Custom', open: { type: 'url', url: 'acme://bot/c' } },
      { id: 'u', name: 'Undeclared', open: { type: 'url', url: 'shortcuts://run-shortcut?name=x' } },
      { id: 'v', name: 'ViewSrc', open: { type: 'url', url: 'view-source:file:///etc/passwd' } },
      { id: 'j', name: 'Jar', open: 'jar:file:///x.jar!/' },
      { id: 'a', name: 'AppPath', open: { type: 'app', target: '/System/Applications/Utilities/Terminal.app' } },
      { id: 'b', name: 'AppId', open: { type: 'app', target: 'com.apple.Notes' } },
    ],
  }
  const [d] = S.parseBotDocs(doc)
  ok(d.app === undefined, '1 doc.app must be a bundle id (path dropped)')
  ok(JSON.stringify(d.schemes) === '["acme","smb"]', '1 declared schemes: javascript never allowed', JSON.stringify(d.schemes))
  const by = Object.fromEntries(d.bots.map(b => [b.id, b]))
  ok(by.v.open === null && by.j.open === null, '1 view-source:/jar: opens dropped at parse')
  ok(by.a.open === null && by.b.open?.target === 'com.apple.Notes', '1 app open: bundle ids only')
  const h = hub()
  h.push(doc)
  ok(!h.all().some(b => b.provider === 'acme'), '1 new file provider is off the deck until enabled')
  ok(h.providers().find(p => p.id === 'acme')?.enabled === false, '1 provider list reports enabled:false')
  ok(!h.find('acme:h'), '1 disabled provider bots are not findable for keys')
  h._cfg = [{ id: 'acme', enabled: true }]
  ok(h.all().filter(b => b.provider === 'acme').length === 8, '1 enabled (profile) → bots show')
  const act = id => h.openAction(h.find(`acme:${id}`))
  ok(act('h').type === 'internal' && !/blocked/.test(act('h').desc), '1 https opens')
  const sh = act('s')
  ok(sh.type === 'internal' && /blocked/.test(sh.desc), '1 shell blocked without profile allowShell (doc allowShell ignored)')
  let threw = ''; try { sh.run() } catch (e) { threw = e.message }
  ok(/shell commands are off/.test(threw), '1 blocked press explains itself', threw)
  ok(/blocked/.test(act('c').desc), '1 declared scheme still blocked until the user approves it')
  ok(/blocked/.test(act('u').desc), '1 undeclared scheme (shortcuts:) blocked')
  h._cfg = [{ id: 'acme', enabled: true, allowShell: true, schemes: ['acme', 'shortcuts'] }]
  ok(act('s').type === 'shell' && act('s').cmd === 'touch /tmp/pwned', '1 shell runs only with profile allowShell')
  ok(!/blocked/.test(act('c').desc), '1 declared + approved scheme opens')
  ok(/blocked/.test(act('u').desc), '1 approved but undeclared scheme stays blocked')
  const p = h.providers().find(x => x.id === 'acme')
  ok(p.shell === 1 && JSON.stringify(p.blockedSchemes) === '["shortcuts"]', '1 provider row reports shell bots and blocked schemes', JSON.stringify({ shell: p.shell, blocked: p.blockedSchemes }))
  const sum = h.summary().bots.find(b => b.key === 'acme:s')
  ok(/runs shell/.test(sum.press), '1 summary carries the press text for the chip tooltip', sum.press)
  const t0 = S.providerTrust([], 'acme', d.schemes)
  const txt = S.pressSummary(d.bots.map(b => S.botPress(b, t0, d.app)))
  ok(/1 bot opens? https links/.test(txt) || /https links/.test(txt), '1 import preview summary', txt)
  ok(/needs shell \(blocked until you trust this provider\)/.test(txt), '1 import preview flags shell')
  // grokbot: built-in scheme, enabled by default
  const g = S.parseBotDocs({ provider: 'grokbot', bots: [{ id: '0123456789abcdef', name: 'G' }] })[0].bots[0]
  ok(!S.botPress(g, S.providerTrust([], 'grokbot')).blocked && S.providerTrust([], 'grokbot').enabled, '1 grokbot:// built in, grokbot enabled by default')
  // command provider: on by default (the user added it), its shell bots still blocked
  const c = hub()
  c._cfg = [{ type: 'command', id: 'cmdp', cmd: `printf '%s' '{"bots":[{"id":"x","name":"X","open":{"type":"shell","cmd":"id"}}]}'`, interval: 60 }]
  c.setCommands(c._cfg)
  await new Promise(r => setTimeout(r, 1500))
  const cb = c.find('cmdp:x')
  ok(cb && /blocked/.test(c.openAction(cb).desc), '1 command provider shown by default, its shell bot blocked')
  c.stop()
}

// ---------- 2. avatar fetch ----------
// public IPv4 hosts are allowed (Node's BlockList used to match every IPv4 address against ::ffff:0:0/96)
for (const a of ['8.8.8.8', '1.1.1.1', '::ffff:8.8.8.8', '2606:4700::1111']) ok(!blockedAddress(a), `2 public address ${a} allowed`)
for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fc00::1', 'fd00::1', 'fe80::1', 'fe80::1%en0',
  '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '::127.0.0.1', '::ffff:0:127.0.0.1', '64:ff9b::7f00:1', '2002:7f00:1::', 'localhost', ''])
  ok(blockedAddress(a), `2 private / special address ${JSON.stringify(a)} blocked`)
{
  const certDir = path.join(SCRATCH, 'cert'); fs.mkdirSync(certDir)
  execSync(`openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj /CN=localhost -addext subjectAltName=IP:127.0.0.1`, { cwd: certDir, stdio: 'ignore' })
  const cert = { key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }
  const ca = cert.cert
  const png = (w, h) => { const c = createCanvas(w, h); const x = c.getContext('2d'); x.fillStyle = '#f00'; x.fillRect(0, 0, w, h); return c.toBuffer('image/png') }
  const big = png(600, 400)
  const fakeHuge = Buffer.from(png(8, 8)); fakeHuge.writeUInt32BE(10000, 16); fakeHuge.writeUInt32BE(10000, 20)
  const bomb = zlib.gzipSync(Buffer.alloc(64 << 20), { level: 9 }) // 64 MB of zeros → ~64 KB
  let hits = 0
  const srv = https.createServer(cert, (req, res) => {
    hits++
    const u = req.url
    if (u === '/png') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(big) }
    if (u === '/redir-loop') { res.writeHead(302, { location: `https://127.0.0.1:${port}/png` }); return res.end() }
    if (u === '/redir-v6') { res.writeHead(302, { location: `https://[::1]:${port}/png` }); return res.end() }
    if (u === '/redir-http') { res.writeHead(302, { location: `http://localhost:${hport}/png` }); return res.end() }
    if (u === '/redir-many') { res.writeHead(302, { location: '/redir-many' }); return res.end() }
    if (u === '/fake') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end('<html>not an image</html>') }
    if (u === '/gzip') { res.writeHead(200, { 'content-type': 'image/png', 'content-encoding': 'gzip' }); return res.end(bomb) }
    if (u === '/len') { res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(5 << 20) }); return res.end() }
    if (u === '/stream') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(Buffer.concat([big, Buffer.alloc(2 << 20)])) }
    if (u === '/dims') { res.writeHead(200, { 'content-type': 'image/png' }); return res.end(fakeHuge) }
    res.writeHead(404); res.end()
  })
  const hsrv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'image/png' }); r.end(big) })
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  await new Promise(r => hsrv.listen(0, '127.0.0.1', r))
  const port = srv.address().port, hport = hsrv.address().port
  const allow = { ca, allowLookup: a => a === '127.0.0.1' || a === '::1' } // test-only: lets "localhost" resolve to our server
  const L = p => `https://localhost:${port}${p}`
  await rejects(fetchAvatar(`https://127.0.0.1:${port}/png`, allow), /blocked address 127\.0\.0\.1/, '2 https://127.0.0.1 literal rejected')
  await rejects(fetchAvatar(`https://[::1]:${port}/png`, allow), /blocked address ::1/, '2 https://[::1] rejected')
  await rejects(fetchAvatar(`https://[::ffff:127.0.0.1]:${port}/png`, allow), /blocked/, '2 https://[::ffff:127.0.0.1] rejected')
  await rejects(fetchAvatar(L('/png'), { ca }), /blocked address/, '2 hostname resolving to loopback rejected (DNS checked)')
  await rejects(fetchAvatar(`https://user:pw@localhost:${port}/png`, allow), /user info/, '2 userinfo rejected')
  await rejects(fetchAvatar(`http://localhost:${hport}/png`, allow), /https only/, '2 http rejected')
  const d = await fetchAvatar(L('/png'), allow)
  const im = await loadImage(Buffer.from(d.split(',')[1], 'base64'))
  ok(d.startsWith('data:image/png;base64,') && im.width === 144 && im.height === 96, '2 real png fetched and downscaled to 144 px', `${im.width}×${im.height}`)
  await rejects(fetchAvatar(L('/redir-loop'), allow), /blocked address 127\.0\.0\.1/, '2 redirect to https://127.0.0.1 rejected')
  await rejects(fetchAvatar(L('/redir-v6'), allow), /blocked address ::1/, '2 redirect to https://[::1] rejected')
  await rejects(fetchAvatar(L('/redir-http'), allow), /https only/, '2 redirect to http rejected')
  await rejects(fetchAvatar(L('/redir-many'), allow), /too many redirects/, '2 redirect hops capped at 3')
  await rejects(fetchAvatar(L('/fake'), allow), /not a png/, '2 fake png (content-type lies) rejected by magic bytes')
  const rss0 = process.memoryUsage().rss
  await rejects(fetchAvatar(L('/gzip'), allow), /compressed/, '2 gzip bomb rejected without inflating')
  ok(process.memoryUsage().rss - rss0 < 40 << 20, '2 gzip bomb: memory stays flat', `Δrss ${((process.memoryUsage().rss - rss0) / 1048576).toFixed(1)} MB`)
  await rejects(fetchAvatar(L('/len'), allow), /over 1 MB/, '2 content-length > 1 MB rejected up front')
  await rejects(fetchAvatar(L('/stream'), allow), /over 1 MB/, '2 body > 1 MB cut off while streaming')
  await rejects(fetchAvatar(L('/dims'), allow), /bad size/, '2 10000×10000 png header rejected before decoding')

  // ---------- 6. avatar cache: backoff, LRU, fetch from summary ----------
  const h = hub()
  h.push({ provider: 'pics', bots: [{ id: 'p', name: 'P', avatar: { image: 'https://127.0.0.1:1/x.png' } }] })
  h._cfg = [{ id: 'pics', enabled: true }]
  h.summary()
  ok(h.images.has('https://127.0.0.1:1/x.png'), '6 summary() starts the avatar fetch (no device draw needed)')
  await new Promise(r => setTimeout(r, 300))
  const e = h.images.get('https://127.0.0.1:1/x.png')
  ok(e.fails === 1 && e.retryAt > Date.now() + 20e3 && !e.busy, '6 failure → retry later with backoff (not cached forever)', `retry in ${Math.round((e.retryAt - Date.now()) / 1000)} s`)
  for (let i = 0; i < 100; i++) h.images.set(`https://example.invalid/${i}`, { data: 'x', fails: 0, retryAt: 0 })
  h.image('https://example.invalid/new')
  ok(h.images.size <= 64, '6 avatar cache bounded (LRU)', `size ${h.images.size}`)
  const bs = h.summary().bots.find(b => b.key === 'pics:p')
  ok(bs.avatar && bs.avatar.image === undefined && typeof bs.thumb === 'string', '11 summary omits avatar.image (thumb only)')
  srv.close(); hsrv.close()
}

// ---------- 3. glyph names keep their case ----------
{
  ok(!!R.glyphFile('4K'), '3 glyphFile("4K") resolves')
  ok(R.glyphFile('4k') === null, '3 glyphFile("4k") is exact (no case-insensitive FS match)')
  ok(R.glyphFile('../x') === null && R.glyphFile('rocket') !== null, '3 glyphFile still rejects paths, finds lower-case names')
  const b = S.normalizeBot({ id: 'g', name: 'G', avatar: { glyph: '4K' } }, 'x')
  ok(b.avatar.glyph === '4K' && S.botThumb(b) === '/glyphs/4K.svg', '3 bot glyph avatars keep case', S.botThumb(b))
  const png = await R.renderKeySpec({ glyph: '4K', label: 'x' })
  ok(!!png, '3 renderKeySpec draws an upper-case glyph')
}

// ---------- 4. merge keeps what a row leaves out ----------
{
  const h = hub()
  h.push({ provider: 'mrg', name: 'Merge App', app: 'com.example.merge', schemes: ['mrg'], bots: [
    { id: 'a', name: 'Alpha', subtitle: 'one', avatar: { emoji: '🤖' }, open: { type: 'url', url: 'https://example.com/a' }, unread: 3 },
    { id: 'b', name: 'Beta' },
  ] })
  h.push({ provider: 'mrg', merge: true, bots: [{ id: 'a', awaiting: true }, { id: 'c', name: 'Gamma' }] })
  const raw = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'mrg.json'), 'utf8'))
  const a = raw.bots.find(b => b.id === 'a')
  ok(raw.name === 'Merge App' && raw.app === 'com.example.merge' && JSON.stringify(raw.schemes) === '["mrg"]', '4 merge keeps doc name / app / schemes')
  ok(a.avatar?.emoji === '🤖' && a.open?.url === 'https://example.com/a' && a.unread === 3 && a.awaiting === true && a.subtitle === 'one', '4 merge keeps avatar / open / unread, applies awaiting (id-only row accepted)', JSON.stringify(a))
  ok(raw.bots.map(b => b.id).join() === 'a,b,c', '4 merge keeps unlisted bots and adds new ones')
}

// ---------- 5. bare refs are Grok-only; duplicate providers ----------
{
  const third = S.parseBotDocs({ provider: 'evil', bots: [{ id: 'Scout', name: 'Scout' }] })[0].bots
  ok(S.findBot(third, 'Scout') === null, '5 bare "Scout" does not fall through to another provider')
  ok(S.findBot(third, 'evil:Scout')?.key === 'evil:Scout', '5 provider:id refs still resolve')
  const grok = S.parseBotDocs({ provider: 'grokbot', bots: [{ id: 'g1', name: 'Scout' }] })[0].bots
  ok(S.findBot([...third, ...grok], 'Scout')?.provider === 'grokbot', '5 bare ref resolves to the Grok bot')
  ok(S.listBots([...third, ...grok], { pins: ['scout'] }).map(b => b.provider).join() === 'grokbot', '5 bare pins are Grok-only too')
  fs.writeFileSync(path.join(BOTS_DIR, 'b-second.json'), JSON.stringify({ provider: 'dup', name: 'Second', bots: [{ id: 'x', name: 'From B' }] }))
  fs.writeFileSync(path.join(BOTS_DIR, 'a-first.json'), JSON.stringify({ provider: 'dup', name: 'First', bots: [{ id: 'x', name: 'From A' }] }))
  const h = hub(); h._cfg = [{ id: 'dup', enabled: true }]; h.scanFiles()
  const all = h.all().filter(b => b.provider === 'dup')
  ok(all.length === 1 && all[0].name === 'From A', '5 duplicate provider: first file by name owns it', all.map(b => b.name).join())
  const rows = h.providers().filter(p => p.id === 'dup')
  ok(rows.length === 2 && rows.some(p => p.duplicate && /already comes from a-first\.json/.test(p.error)), '5 the other file is flagged as a duplicate', rows.map(r => r.error || 'ok').join(' | '))
  ok(new Set(h.summary().bots.map(b => b.key)).size === h.summary().bots.length, '5 summary bot keys unique (no duplicate React keys)')
  fs.rmSync(path.join(BOTS_DIR, 'a-first.json')); fs.rmSync(path.join(BOTS_DIR, 'b-second.json'))
}

// ---------- 8. one size limit ----------
{
  const h = hub()
  const avatar = 'data:image/png;base64,' + 'A'.repeat(200 << 10) // ~150 KB decoded: under the inline cap
  const many = { provider: 'fat', bots: Array.from({ length: 15 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, avatar: { image: avatar } })) }
  throwsSync(() => h.push(many), /413|over 2 MB once saved/, '8 doc that would save over 2 MB → 413 (nothing written)')
  ok(!fs.existsSync(path.join(BOTS_DIR, 'fat.json')), '8 nothing written for a rejected push')
  throwsSync(() => h.push({ text: 'x'.repeat((2 << 20) + 10) }), /413/, '8 input over 2 MB → 413')
  const huge = S.normalizeBot({ id: 'x', name: 'X', avatar: { image: 'data:image/png;base64,' + 'A'.repeat(400 << 10) } }, 'p')
  ok(!huge.avatar?.image, '8 inline avatar over 256 KB dropped at parse')
  const r = h.push({ provider: 'fit', bots: [{ id: 'a', name: 'A', avatar: { image: avatar } }] })
  h.scanFiles()
  ok(r.count === 1 && h.providers().find(p => p.id === 'fit' && !p.error), '8 what push accepts, the scanner accepts')
  fs.rmSync(path.join(BOTS_DIR, 'fit.json'))
}

// ---------- 9. remove moves to .removed; shared files are rewritten ----------
{
  const h = hub()
  h.push({ provider: 'solo', bots: [{ id: 'a', name: 'A' }] })
  fs.writeFileSync(path.join(BOTS_DIR, 'team.json'), JSON.stringify({ providers: [{ provider: 'one', bots: [{ id: 'a', name: 'A' }] }, { provider: 'two', bots: [{ id: 'b', name: 'B' }] }] }))
  h.scanFiles()
  const r1 = h.remove('solo')
  const removed = fs.readdirSync(path.join(BOTS_DIR, '.removed'))
  ok(!fs.existsSync(path.join(BOTS_DIR, 'solo.json')) && removed.some(f => f.startsWith('solo.')) && r1.moved[0] === 'solo.json', '9 sole-provider file moved to .removed (not unlinked)', removed.join())
  const r2 = h.remove('one')
  const team = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'team.json'), 'utf8'))
  ok(r2.rewritten[0] === 'team.json' && team.providers.length === 1 && team.providers[0].provider === 'two', '9 shared file rewritten without the removed provider')
  ok(!h.providers().some(p => p.id === 'one') && h.providers().some(p => p.id === 'two'), '9 other provider in that file survives')
}

// ---------- 10. status: coerced values, owner file found via the scan ----------
{
  const h = hub()
  h.status({ provider: 'two', id: 'b', unread: '5000', awaiting: 'yes', hidden: 0, activityAt: '1700000000000' })
  const row = JSON.parse(fs.readFileSync(path.join(BOTS_DIR, 'team.json'), 'utf8')).providers[0].bots[0]
  ok(row.unread === 999 && row.awaiting === false && row.hidden === false && row.activityAt === 1700000000000, '10 status values coerced (unread clamp, booleans strict, numeric activityAt)', JSON.stringify(row))
  ok(/team\.json/.test(h.owners().get('two').file), '10 provider "two" located in team.json (not two.json)')
  throwsSync(() => h.status({ provider: 'two', id: 'nope', unread: 1 }), /no bot/, '10 unknown bot rejected')
  throwsSync(() => h.status({ provider: '../x', id: 'a' }), /no file provider/, '10 bad provider rejected')
  h.remove('two')
}

// ---------- 14. schema edges ----------
{
  const name = 'a'.repeat(58) + '👍🏽'
  const b = S.normalizeBot({ id: 'x', name }, 'p')
  ok(!/[\uD800-\uDBFF]$/.test(b.name) && b.name === 'a'.repeat(58), '14 grapheme-safe truncation (no half emoji)', JSON.stringify(b.name.slice(-4)))
  ok(S.normalizeBot({ id: 'x', name: 'X', activityAt: '1700000000000' }, 'p').activityAt === 1700000000000, '14 numeric-string activityAt')
  ok(S.normalizeBot({ id: 'x', name: 'X', activityAt: '2026-01-01T00:00:00Z' }, 'p').activityAt === Date.parse('2026-01-01T00:00:00Z'), '14 ISO activityAt')
  ok(S.normalizeBot({ name: 'X' }, 'p') === null && S.normalizeBot({ id: '', name: 'X' }, 'p') === null && S.normalizeBot({ id: { a: 1 }, name: 'X' }, 'p') === null, '14 missing / empty / object ids rejected (no auto bot-N)')
  ok(S.normalizeBot({ id: 7, name: 'X' }, 'p')?.id === '7', '14 numeric id accepted as a string')
}

// ---------- 12. normalizeProfile ----------
{
  const p = normalizeProfile({ botProviders: [5, { id: 3 }, { id: 'a', name: 1 }, { id: 'ok', schemes: ['x', 1] }], pages: { b: { source: 'bots', providers: [1, 'grokbot'], bots: 'Scout' } } })
  ok(JSON.stringify(p.botProviders) === '[{"id":"ok","schemes":["x"]}]' && JSON.stringify(p.pages.b.providers) === '["grokbot"]' && JSON.stringify(p.pages.b.bots) === '[]', '12 botProviders / page providers / bots sanitized')
  // runtime-only _press / _rotate (run before onPress, outside the saved-action checks) are never persisted
  const q = normalizeProfile({ pages: { h: { keys: [{ label: 'k', _press: { type: 'plugin', plugin: 'capture', action: 'record' } }], dials: [{ label: 'd', _press: { type: 'shell', cmd: 'x' }, _rotate: 1, onPress: { type: 'page', page: 'h' } }], strip: { mode: 'segments', _press: {} } } } })
  ok(!JSON.stringify(q).includes('_press') && !JSON.stringify(q).includes('_rotate') && q.pages.h.dials[0].label === 'd' && q.pages.h.dials[0].onPress.page === 'h' && q.pages.h.keys[0].label === 'k', '12b normalizeProfile drops _-prefixed internal fields of keys / dials / strip')
}

// ---------- 13. command providers: process group killed on stop ----------
{
  const h = hub()
  h.setCommands([{ type: 'command', id: 'slow', cmd: 'sleep 3001 & sleep 3002; echo {}', interval: 60 }])
  await new Promise(r => setTimeout(r, 600))
  const before = execSync("pgrep -f 'sleep 300[12]' || true").toString().trim().split('\n').filter(Boolean).length
  h.stop()
  await new Promise(r => setTimeout(r, 400))
  const after = execSync("pgrep -f 'sleep 300[12]' || true").toString().trim().split('\n').filter(Boolean).length
  ok(before >= 2 && after === 0, '13 stop kills the whole process group (zsh + background children)', `${before} → ${after}`)
  const e = hub()
  e._cfg = [{ type: 'command', id: 'flaky', cmd: `[ -f ${SCRATCH}/broke ] && exit 3; echo '{"bots":[{"id":"a","name":"A","awaiting":true}]}'`, interval: 5 }]
  e.setCommands(e._cfg)
  await new Promise(r => setTimeout(r, 1200))
  ok(e.all().find(b => b.key === 'flaky:a')?.awaiting === true, '13 command bots call you while it works')
  fs.writeFileSync(path.join(SCRATCH, 'broke'), '')
  await new Promise(r => setTimeout(r, 5600))
  const s = e.all().find(b => b.key === 'flaky:a'), row = e.providers().find(p => p.id === 'flaky')
  ok(s && s.awaiting === false && s.stale && row.stale && /exit 3|last good/.test(row.error), '13 after an error: last good bots kept, stale, no awaiting badge', row.error)
  e.stop()
}

// ---------- half-written file keeps its last good docs ----------
{
  const h = hub()
  const f = path.join(BOTS_DIR, 'half.json')
  fs.writeFileSync(f, JSON.stringify({ provider: 'half', bots: [{ id: 'a', name: 'A' }] })); h.scanFiles()
  fs.writeFileSync(f, '{"provider":"half","bots":[{"id":'); fs.utimesSync(f, new Date(), new Date(Date.now() + 5000)); h.scanFiles()
  const p = h.providers().find(x => x.id === 'half')
  ok(p?.count === 1 && /last good/.test(p.error), 'half-written file: last good docs kept', p?.error)
  fs.rmSync(f)
}

// ---------- 7. decoded images are cached ----------
{
  const c = createCanvas(400, 400), x = c.getContext('2d'); for (let i = 0; i < 400; i += 4) { x.fillStyle = `hsl(${i},80%,50%)`; x.fillRect(i, 0, 4, 400) }
  const src = c.toDataURL('image/jpeg')
  const t = async () => { const t0 = performance.now(); await R.renderKeySpec({ image: src }); return performance.now() - t0 }
  await t()
  const firstOther = await (async () => { const c2 = createCanvas(400, 400); c2.getContext('2d').fillRect(0, 0, 9, 9); const s2 = c2.toDataURL('image/jpeg'); const t0 = performance.now(); await R.renderKeySpec({ image: s2 }); return performance.now() - t0 })()
  let warm = 0; for (let i = 0; i < 10; i++) warm += await t()
  ok(warm / 10 < firstOther, '7 repeated data-URL image renders reuse the decoded image', `cold ${firstOther.toFixed(1)} ms vs warm ${(warm / 10).toFixed(1)} ms`)
}

// leave nothing behind
fs.rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
