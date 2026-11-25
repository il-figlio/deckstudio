// Plugin installer vs a fixture registry with good and hostile entries (bad sha, symlinks, traversal, size/count caps).
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { execFileSync } from 'node:child_process'; import { fileURLToPath } from 'node:url'
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-install-'))
const R = path.join(TMP, 'registry'), USER = path.join(TMP, 'user-plugins')
execFileSync('node', [path.join(ROOT, 'test/fixtures/mkreg.mjs'), R, path.join(ROOT, 'test/fixtures/plugin-scaffold')], { stdio: 'ignore' })
const I = await import(path.join(ROOT, 'src/plugin-install.mjs'))
const src = I.registrySource(R)
let pass = 0, fail = 0
const ok = (what, cond, note = '') => { cond ? pass++ : fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${what.padEnd(48)} ${note}`) }
const reg = await I.listRegistry({ src })
const by = Object.fromEntries(reg.plugins.map(p => [p.id, p]))
ok('registry lists all entries', reg.ok && reg.plugins.length === 11, `${reg.plugins.length}`)
ok('fake-good verified + valid', by['fake-good'].verified && by['fake-good'].valid)
ok('fake-good icon inlined', /^data:image\/svg\+xml;base64,/.test(by['fake-good'].iconUrl || ''))
ok('fake-sha flagged sha mismatch', !by['fake-sha'].verified && /sha256 mismatch/.test(by['fake-sha'].errors[0]))
ok('fake-trav path outside refused', !by['fake-trav'].verified && /bad path|outside/.test(by['fake-trav'].errors[0]), by['fake-trav'].errors[0])
ok('fake-dirlink symlinked folder refused', /symlink/.test(by['fake-dirlink'].errors[0]), by['fake-dirlink'].errors[0])
ok('fake-tamper flagged (file hash)', !by['fake-tamper'].valid && by['fake-tamper'].errors.some(e => /status\.sh: sha256 mismatch/.test(e)), by['fake-tamper'].errors.join(' | '))
ok('fake-extra flagged (unlisted file)', !by['fake-extra'].valid && by['fake-extra'].errors.some(e => /payload\.sh: not listed/.test(e)))
ok('fake-nofiles flagged (no per-file hashes)', !by['fake-nofiles'].valid && by['fake-nofiles'].errors.some(e => /per-file hashes/.test(e)))
ok('fake-idmix id mismatch flagged', /differs/.test(by['fake-idmix'].errors.join(' ')))
const tryInstall = async id => { try { return { out: await I.installFromRegistry(id, { userDir: USER, src }) } } catch (e) { return { err: e.message } } }
const g = await tryInstall('fake-good')
ok('install fake-good', !!g.out, g.err || g.out.dir)
const d = path.join(USER, 'fake-good')
const mode = p => (fs.statSync(p).mode & 0o777).toString(8)
ok('installed dir is 0700', mode(d) === '700', mode(d))
ok('manifest is 0600', mode(path.join(d, 'deckstudio.json')) === '600', mode(path.join(d, 'deckstudio.json')))
ok('executable script kept owner-only exec (0700)', mode(path.join(d, 'status.sh')) === '700', mode(path.join(d, 'status.sh')))
for (const [id, re] of [['fake-sha', /sha256/], ['fake-link', /symlink/], ['fake-big', /over 2 MB/], ['fake-many', /more than 50/], ['fake-trav', /bad path|outside/], ['fake-dirlink', /symlink/], ['fake-idmix', /differs/], ['fake-tamper', /status\.sh: sha256 mismatch/], ['fake-extra', /payload\.sh: not listed/], ['fake-nofiles', /per-file hashes/], ['nope', /not in the registry/], ['../etc', /bad plugin id/]]) {
  const r = await tryInstall(id)
  ok(`refuse ${id}`, !!r.err && re.test(r.err) && !fs.existsSync(path.join(USER, id)), r.err)
}
ok('no staging leftovers', !fs.readdirSync(USER).some(n => n.startsWith('.staging')), fs.readdirSync(USER).join(','))
// update: same id again replaces and moves the old one to .removed
const g2 = await tryInstall('fake-good')
ok('reinstall replaces (old → .removed)', g2.out?.replaced && fs.existsSync(g2.out.previous), g2.out?.previous)
// URL registries: an entry's path / files must stay under index.json's folder on the same origin (L3)
{
  const us = I.registrySource('https://reg.example.com/deck/index.json')
  ok('entryUrl: normal entry', I.entryUrl(us, { id: 'a', path: 'plugins/a' }, 'deckstudio.json') === 'https://reg.example.com/deck/plugins/a/deckstudio.json')
  for (const [what, e, rel] of [['../x path', { id: 'a', path: '../x' }, 'deckstudio.json'], ['absolute url path', { id: 'a', path: 'https://evil.example/p' }, 'deckstudio.json'],
    ['protocol-relative path', { id: 'a', path: '//evil.example/p' }, 'deckstudio.json'], ['leading / path', { id: 'a', path: '/other/a' }, 'deckstudio.json'],
    ['../ in a file name', { id: 'a', path: 'plugins/a' }, '../../x.sh'], ['query in a file name', { id: 'a', path: 'plugins/a' }, 'x?y']]) {
    let err = null; try { I.entryUrl(us, e, rel) } catch (x) { err = x.message }
    ok(`entryUrl refuses ${what}`, !!err && /bad (file )?path|outside/.test(err), err || '(accepted)')
  }
  // verifyEntry on a url registry with a hostile path never fetches: it fails on the path first
  const v = await I.verifyEntry(us, { id: 'a', path: '../x', sha256: '0'.repeat(64), files: { 'deckstudio.json': '0'.repeat(64) } })
  ok('verifyEntry (url) refuses ../ path', !v.valid && /bad path/.test(v.errors[0]), v.errors[0])
}
// URL registry install (fetch stubbed to serve the fixture registry): exactly the listed files, each hash-checked
{
  const realFetch = globalThis.fetch, fetched = []
  globalThis.fetch = async u => { const p = new URL(u).pathname.replace(/^\/deck\//, ''); fetched.push(p); try { const b = fs.readFileSync(path.join(R, p)); return new Response(b) } catch { return new Response('nope', { status: 404 }) } }
  const us = I.registrySource('https://reg.example.com/deck/index.json'), U2 = path.join(TMP, 'url-user')
  try { const o = await I.installFromRegistry('fake-good', { userDir: U2, src: us }); ok('url install: fetched exactly the listed files', o.files === 4 && fs.existsSync(path.join(U2, 'fake-good/status.sh')) && fetched.every(f => f === 'index.json' || f.startsWith('plugins/fake-good/')), fetched.join(',')) } catch (x) { ok('url install: fetched exactly the listed files', false, x.message) }
  for (const [id, re] of [['fake-tamper', /status\.sh: sha256 mismatch/], ['fake-nofiles', /per-file hashes/]]) {
    let err = null; try { await I.installFromRegistry(id, { userDir: U2, src: us }) } catch (x) { err = x.message }
    ok(`url install refuses ${id}`, !!err && re.test(err) && !fs.existsSync(path.join(U2, id)), err)
  }
  globalThis.fetch = realFetch
}
// local folder install
try { const r = I.installFromDir(path.join(R, 'plugins/fake-link'), { userDir: USER }); ok('installFromDir refuses symlink inside', false, r.dir) } catch (e) { ok('installFromDir refuses symlink inside', /symlink/.test(e.message), e.message) }
// M5: deckctl's offline install (server down) switches the plugin off in the profile too, so an update is reviewed again
{
  const H = path.join(TMP, 'offline-home'); fs.mkdirSync(H, { mode: 0o700 })
  fs.writeFileSync(path.join(H, 'profile.json'), JSON.stringify({ pages: { home: { name: 'Home' } }, plugins: { 'fake-good': { enabled: true, approved: 'f'.repeat(64), grants: { shell: true } } } }), { mode: 0o600 })
  let outText = ''
  try { outText = execFileSync(path.join(ROOT, 'bin/deckctl'), ['plugin', 'install', path.join(R, 'plugins/fake-good')], { env: { ...process.env, DECKSTUDIO_HOME: H, DECKSTUDIO_PORT: '9', DECKSTUDIO_REGISTRY: R }, encoding: 'utf8', timeout: 20000 }) } catch (e) { outText = String(e.stderr || e.message) }
  const prof = JSON.parse(fs.readFileSync(path.join(H, 'profile.json'), 'utf8'))
  ok('offline deckctl install switches the plugin off', /installed fake-good/.test(outText) && prof.plugins['fake-good'].enabled === false && !prof.plugins['fake-good'].approved && prof.pages.home.name === 'Home', JSON.stringify(prof.plugins))
}
const u = I.uninstall('fake-good', { userDir: USER })
ok('uninstall moves to .removed', !fs.existsSync(d) && fs.existsSync(u.movedTo), u.movedTo)
try { I.uninstall('fake-good', { userDir: USER }); ok('uninstall missing refuses', false) } catch (e) { ok('uninstall missing refuses', /not installed/.test(e.message)) }
console.log(`\n${pass}/${pass + fail} passed`)
fs.rmSync(TMP, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
