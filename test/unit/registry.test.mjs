// The registry that ships in this repo (registry/): default source resolution, install from it into a scratch home,
// and plugin discovery never picking registry/plugins up. Run: node test/unit/registry.test.mjs (touches nothing real)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRATCH = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-registry-')))
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const REG = path.join(ROOT, 'registry')
process.env.HOME = SCRATCH // never read the real home
process.env.DECKSTUDIO_HOME = path.join(SCRATCH, 'home')
delete process.env.DECKSTUDIO_REGISTRY
const I = await import(path.join(ROOT, 'src/plugin-install.mjs'))
const { PluginHost } = await import(path.join(ROOT, 'src/plugins.mjs'))

let pass = 0, fail = 0
const ok = (cond, name, extra = '') => { if (cond) pass++; else fail++; console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`) }
const index = JSON.parse(fs.readFileSync(path.join(REG, 'index.json'), 'utf8'))
const regIds = index.plugins.map(p => p.id)

// ---------- 1. default registry = <repo>/registry, from the module's location (not cwd, not HOME) ----------
{
  const cwd = process.cwd()
  process.chdir(SCRATCH)
  const def = I.registrySource()
  process.chdir(cwd)
  ok(def.kind === 'dir' && def.dir === REG, '1a no DECKSTUDIO_REGISTRY → the repo\'s registry/ folder (cwd elsewhere)', def.dir)
  ok(I.BUNDLED_REGISTRY === REG, '1b BUNDLED_REGISTRY is <repo>/registry', I.BUNDLED_REGISTRY)
  ok(I.registrySource('').dir === REG && I.registrySource('   ').dir === REG, '1c blank DECKSTUDIO_REGISTRY → bundled registry')
  ok(!def.dir.startsWith(SCRATCH), '1d default doesn\'t depend on HOME')
  const other = path.join(SCRATCH, 'other-reg')
  ok(I.registrySource(other).dir === other, '1e a folder overrides it')
  ok(I.registrySource('~/r').dir === path.join(os.homedir(), 'r'), '1f ~/ still expands for an override')
  const u = I.registrySource('https://reg.example.com/deck')
  ok(u.kind === 'url' && u.url === 'https://reg.example.com/deck/index.json', '1g an https url overrides it (index.json appended)', u.url)
  let err = null; try { I.registrySource('http://reg.example.com/index.json') } catch (e) { err = e.message }
  ok(!!err, '1h plain http is still refused', err || '(accepted)')
  process.env.DECKSTUDIO_REGISTRY = other
  ok(I.registrySource().dir === other, '1i DECKSTUDIO_REGISTRY env is read when called')
  delete process.env.DECKSTUDIO_REGISTRY
}

// ---------- 2. the bundled registry lists, verifies and installs (scratch user dir) ----------
{
  const reg = await I.listRegistry()
  ok(reg.ok && reg.source === REG, '2a listRegistry() reads the bundled registry', `${reg.source} ${reg.error || ''}`)
  ok(reg.plugins.length === regIds.length && regIds.includes('hello'), '2b every index entry is listed', reg.plugins.map(p => p.id).join(','))
  const bad = reg.plugins.filter(p => !p.verified || !p.valid)
  ok(!bad.length, '2c every entry is sha256-verified, per-file hashes match, and validates', bad.map(p => `${p.id}: ${p.errors[0]}`).join(' | '))
  const USER = path.join(SCRATCH, 'home/plugins')
  const out = await I.installFromRegistry('hello', { userDir: USER })
  const d = path.join(USER, 'hello')
  ok(out.dir === d && fs.existsSync(path.join(d, 'deckstudio.json')), '2d installFromRegistry("hello") with the default source', out.dir)
  const entry = index.plugins.find(p => p.id === 'hello')
  ok(out.sha256 === entry.sha256 && out.files === Object.keys(entry.files).length, '2e installed exactly the indexed files and manifest', `${out.files} files`)
  const mode = p => (fs.statSync(p).mode & 0o777).toString(8)
  ok(mode(d) === '700' && mode(path.join(d, 'deckstudio.json')) === '600' && mode(path.join(d, 'hello-status')) === '700', '2f owner-only modes (dir 0700, files 0600, scripts 0700)', `${mode(d)} ${mode(path.join(d, 'hello-status'))}`)
  ok(fs.existsSync(path.join(REG, 'plugins/hello/deckstudio.json')), '2g the registry folder itself is untouched')
  let err = null; try { await I.installFromRegistry('../plugins/bots', { userDir: USER }) } catch (e) { err = e.message }
  ok(!!err && /bad plugin id/.test(err), '2h a path-like id is refused', err || '(accepted)')
}

// ---------- 3. discovery: registry/plugins is never a plugin source ----------
{
  const host = new PluginHost({ dirs: { local: '', user: path.join(SCRATCH, 'empty-user') }, cfg: () => ({}), bundles: async () => ({}) })
  const all = Object.values(host.dirs).filter(Boolean)
  ok(all.every(d => d !== REG && !d.startsWith(REG + path.sep)), '3a no plugin dir is inside registry/', all.join(' · '))
  host.scan()
  const found = [...host.plugins.values()]
  ok(found.some(r => r.source === 'builtin') && found.every(r => r.source === 'builtin'), '3b only built-ins are found with an empty user dir', found.map(r => `${r.id}:${r.source}`).join(','))
  ok(!found.some(r => r.dir.startsWith(REG + path.sep)) && !regIds.some(id => host.plugins.has(id)), '3c no registry plugin is discovered', regIds.join(','))
  // once installed it shows up as a user plugin, switched off until the user approves it
  const host2 = new PluginHost({ dirs: { local: '', user: path.join(SCRATCH, 'home/plugins') }, cfg: () => ({}), bundles: async () => ({}) })
  host2.scan()
  const h = host2.plugins.get('hello')
  ok(h?.source === 'user' && !h.dir.startsWith(REG) && !host2.trust(h).enabled && !host2.active(h), '3d an installed registry plugin is a user plugin, off', `${h?.source} ${h?.dir}`)
}

// ---------- 4. the registry scripts use this repo's validator (any cwd, scratch HOME) ----------
{
  let out = '', code = 0
  try { out = execFileSync(process.execPath, [path.join(REG, 'scripts/build-index.mjs'), '--check'], { cwd: SCRATCH, env: { ...process.env, HOME: SCRATCH }, encoding: 'utf8', timeout: 30000 }) } catch (e) { code = e.status || 1; out = String(e.stderr || e.message) }
  ok(code === 0 && /up to date/.test(out), '4a build-index --check passes from another cwd', out.trim().split('\n').at(-1))
}

console.log(`\n${pass}/${pass + fail} passed`)
fs.rmSync(SCRATCH, { recursive: true, force: true })
process.exit(fail ? 1 : 0)
