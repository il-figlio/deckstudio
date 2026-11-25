// PluginHost: finds plugin manifests (deckstudio.json), detects whether their tool is installed, polls their
// status (argv command / loopback http / file / built-in), turns it into template vars ({id.value}), and runs
// their declared actions. Plugin code never runs in this process: only the commands, urls and files a
// manifest declares, while the user has the plugin enabled, within what the user granted (src/plugin-schema.mjs).
//
// Where plugins live (first one with an id wins):
//   builtin  <repo>/plugins/<id>/            shipped with DeckStudio (may wrap DeckStudio actions: "builtin")
//   local    <repo>/plugins/local/<id>/      this Mac's own (gitignored), on by default like built-ins
//   user     ~/.deckstudio/plugins/<id>/     installed plugins: off until the user enables them
//   linked   ~/.deckstudio/plugins/<name> → a symlink to a dev folder (deckctl plugin link): off until enabled like user,
//            but the user's own folder, so manifest edits don't need re-approval (docs/PLUGINS.md, trust)
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawn, execFile } from 'node:child_process'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runAction as defaultRunAction } from './actions.mjs'
import {
  MANIFEST, LIMITS, validateManifest, pluginTrust, missingGrants, extractValues, pluginVars, parseStatus, heartbeatAt,
  cmdAllowed, httpAllowed, urlAllowed, fillArg, pluginRecipes, pluginSettings, settingsVars, publicSettings, PLUGIN_ID_RE,
} from './plugin-schema.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// HOME, DECKSTUDIO_HOME and PATH are read when used, not at import (tests and tools set them after importing)
const home = () => os.homedir()
const homeDir = () => process.env.DECKSTUDIO_HOME || path.join(home(), '.deckstudio')
/** Where plugins live: { builtin, local, user } (user follows $DECKSTUDIO_HOME at the time of the call). */
export const pluginDirs = () => ({ builtin: path.join(ROOT, 'plugins'), local: path.join(ROOT, 'plugins/local'), user: path.join(homeDir(), 'plugins') })
/** Detached action output: <DECKSTUDIO_HOME>/plugins-logs/<id>-<action>.log */
export const logsDir = () => path.join(homeDir(), 'plugins-logs')
const HELPER = path.join(ROOT, 'bin/deckhelper')
const IDLE_MS = 30e3       // status of a plugin nothing on the current page shows: at most this often
const DETECT_MS = 60e3     // re-check installed-ness
const MAX_MANIFEST = 256 << 10
// Status files: an allowlist (allowedRoots below), with this denylist kept as defense in depth. Both are compared on the
// canonical path (realpathSync.native) and case-insensitively: APFS is usually case-insensitive, so ~/.SSH is ~/.ssh.
const deny = () => ['.ssh', '.gnupg', '.aws', '.kube', '.netrc', '.docker', '.config/gh', '.config/gcloud', '.git-credentials', '.npmrc', '.pypirc',
  'Library/Keychains', 'Library/Cookies', 'Library/Messages', 'Library/Mail', 'Library/Application Support/AddressBook'].map(p => path.join(home(), p))
// and in DeckStudio's home: the token, server.json, the profile with its backups / temp files (other plugins' settings,
// secrets included) and the logs (every action's args and errors)
const DS_DENY = /^(token|server\.json|profile.*\.json.*)$/i
const searchPaths = () => [...(process.env.PATH || '').split(':'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(home(), '.local/bin'), path.join(home(), 'bin')].filter(Boolean)
const errOf = (msg, code = 400) => Object.assign(new Error(msg), { code })
const isExec = p => { try { const s = fs.statSync(p); fs.accessSync(p, fs.constants.X_OK); return s.isFile() } catch { return false } }
// A status `pid` is the tool's own process, running as this user, so EPERM (a process of another user that reused
// the pid) means "not ours": the tool is gone. Same rule as the SDKs (DeckKit isAlive / DeckStatusReader.alive).
const alive = pid => { try { process.kill(pid, 0); return true } catch { return false } }
const expand = (p, dir) => (p === '$dir' || p.startsWith('$dir/') ? path.join(dir, p.slice(4)) : p.startsWith('~/') ? path.join(home(), p.slice(2)) : p)
const canon = p => { try { return fs.realpathSync.native(p) } catch { return path.resolve(p) } }
const lc = p => p.normalize('NFC').toLowerCase()
const under = (p, root) => { const a = lc(p), b = lc(root); return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep) }
const statusDir = id => path.join(homeDir(), 'status', id)
const denied = p => deny().some(d => under(p, d) || under(p, canon(d)))
  || [homeDir(), canon(homeDir())].some(h => under(p, h) && (/\.log(\.\d+)?$/i.test(p) || (lc(path.dirname(p)) === lc(path.resolve(h)) && DS_DENY.test(path.basename(p)))))
const APP_SUPPORT = () => path.join(home(), 'Library/Application Support')
/**
 * Where a plugin's status `file` may live: its own folder, ~/.deckstudio/status/<id>/ (not all of DeckStudio's home: that
 * holds profile backups and logs), ~/Library/Application Support/<dir> for an app dir the manifest declares (detect.paths
 * or a literal status.file there), and the exact file a literal status.file names (the user sees it before enabling).
 * A path that comes from a setting must be inside one of the folders.
 */
function allowedStatusFile(r, real) {
  if (denied(real)) return false
  const roots = [r.dir, statusDir(r.id)]
  const declared = [...(r.m.detect?.paths || []), ...(typeof r.m.status?.file === 'string' && !r.m.status.file.startsWith('{') ? [r.m.status.file] : [])]
  for (const d of declared) {
    const abs = path.resolve(expand(d, r.dir))
    if (under(abs, APP_SUPPORT()) && abs !== APP_SUPPORT()) roots.push(path.join(APP_SUPPORT(), path.relative(APP_SUPPORT(), abs).split(path.sep)[0]))
  }
  if (roots.some(x => under(real, canon(x)))) return true
  const lit = r.m.status?.file
  if (typeof lit !== 'string' || lit.startsWith('{')) return false
  const abs = path.resolve(expand(lit, r.dir)) // the declared file itself (its folders' symlinks followed, not the file's own)
  return lc(real) === lc(path.join(canon(path.dirname(abs)), path.basename(abs)))
}
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

/** Run argv (no shell) or a shell string (zsh -lc), in its own process group: a timeout kills the whole group. */
export function runProcess(file, args, { timeout = 10e3, env, cwd, max = LIMITS.out, track } = {}) {
  return new Promise(resolve => {
    let child
    try { child = spawn(file, args, { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env, cwd }) }
    catch (e) { return resolve({ ok: false, stdout: '', stderr: e.message, why: e.message }) }
    track?.add(child)
    const out = [], errs = []
    let size = 0, why = '', done = false
    const kill = w => { why ||= w; try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    const t = setTimeout(() => kill(`timed out after ${Math.round(timeout / 1000)} s`), timeout)
    child.stdout.on('data', d => { size += d.length; if (size > max) kill(`output over ${max >> 10} KB`); else out.push(d) })
    child.stderr.on('data', d => { if (errs.length < 20) errs.push(d) })
    const fin = (code, e) => {
      if (done) return
      done = true; clearTimeout(t); track?.delete(child)
      const ok = !e && !why && code === 0
      resolve({ ok, code, why, stdout: String(Buffer.concat(out)), stderr: ok ? '' : (why || String(Buffer.concat(errs)).trim().split('\n')[0] || e?.message || `exit ${code}`).slice(0, 200) })
    }
    child.on('error', e => fin(null, e))
    child.on('close', c => fin(c))
  })
}
async function readCapped(res, max = LIMITS.out) {
  const chunks = []
  let n = 0
  for await (const c of res.body) { n += c.length; if (n > max) throw new Error(`response over ${max >> 10} KB`); chunks.push(c) }
  return Buffer.concat(chunks).toString('utf8')
}
const bundlesInstalled = ids => new Promise(resolve => {
  if (!fs.existsSync(HELPER)) return resolve({})
  execFile(HELPER, ['installed', ...ids], { timeout: 5000 }, (e, out) => { try { resolve(e ? {} : JSON.parse(out)) } catch { resolve({}) } })
})

export class PluginHost {
  /**
   * opts: dirs ({ builtin, local, user }), cfg () → profile.plugins, onChange (), runAction (action, ctx),
   * bundles (ids) → { id: bool }, builtins { name: () → status doc }, onBots (id, { doc, error, stale, trust } | null)
   */
  constructor(opts = {}) {
    this.dirs = { ...pluginDirs(), ...opts.dirs }
    this.cfg = opts.cfg || (() => ({}))
    this.onChange = opts.onChange || (() => {})
    this.runAction = opts.runAction || defaultRunAction
    this.bundles = opts.bundles || bundlesInstalled
    this.builtins = opts.builtins || {}
    this.onBots = opts.onBots || (() => {})
    this.plugins = new Map()   // id → record
    this.extra = []            // duplicates and unreadable manifests (listed with their error)
    this.wanted = new Set()    // ids the current page shows: polled at their own interval
    this.stopped = true        // until start()
  }
  start() {
    this.stopped = false
    try { fs.mkdirSync(this.dirs.user, { recursive: true, mode: 0o700 }) } catch {}
    this.scan(); this.sync()
    this.timer = setInterval(() => { if (this.scan()) this.onChange(); this.sync() }, 3000)
  }
  stop() {
    this.stopped = true
    clearInterval(this.timer)
    for (const r of this.plugins.values()) this.halt(r)
  }

  // ---------- discovery ----------
  candidates() {
    const out = []
    const read = (dir, source, skip = []) => {
      let names = []
      try { names = fs.readdirSync(dir).filter(n => !n.startsWith('.') && !skip.includes(n)).sort() } catch { return }
      for (const n of names) {
        const p = path.join(dir, n)
        let st, link = false
        try { link = fs.lstatSync(p).isSymbolicLink(); st = fs.statSync(p) } catch { continue }
        if (!st.isDirectory()) continue
        out.push({ dir: link ? fs.realpathSync(p) : p, source: source === 'user' && link ? 'linked' : source, name: n })
      }
    }
    read(this.dirs.builtin, 'builtin', ['local'])
    if (this.dirs.local) read(this.dirs.local, 'local')
    read(this.dirs.user, 'user')
    return out
  }
  /** Re-read manifests that changed. Returns true when anything changed. */
  scan() {
    const prev = this.plugins
    const next = new Map(), extra = []
    let changed = false
    for (const c of this.candidates()) {
      const file = path.join(c.dir, MANIFEST)
      let st
      try { st = fs.statSync(file) } catch { continue } // a folder without a manifest isn't a plugin
      const old = [...prev.values()].find(r => r.file === file && r.source === c.source)
      let r = old && old.mtime === st.mtimeMs && old.size === st.size ? old : null
      if (!r) {
        changed = true
        let res
        let sha = null
        if (st.size > MAX_MANIFEST) res = { ok: false, manifest: null, errors: [`${MANIFEST} over ${MAX_MANIFEST >> 10} KB`], warnings: [] }
        else try { const buf = fs.readFileSync(file); sha = sha256(buf); res = validateManifest(buf.toString('utf8'), { source: c.source }) } catch (e) { res = { ok: false, manifest: null, errors: [e.message], warnings: [] } }
        const id = res.manifest?.id && PLUGIN_ID_RE.test(res.manifest.id) ? res.manifest.id : null
        if (!id) { extra.push({ id: c.name, name: c.name, source: c.source, dir: c.dir, valid: false, errors: res.errors, warnings: res.warnings, state: 'invalid' }); continue }
        if (c.name !== id) res.warnings.push(`folder "${c.name}" differs from id "${id}"`)
        r = { id, m: res.manifest, sha, errors: res.errors, warnings: res.warnings, dir: c.dir, file, source: c.source, mtime: st.mtimeMs, size: st.size, inst: null, rt: { state: 'starting', values: {} } }
        if (old) { this.halt(old); r.inst = old.inst }
      }
      if (next.has(r.id)) { extra.push({ id: r.id, name: r.m.name, source: c.source, dir: c.dir, valid: false, errors: [`duplicate: "${r.id}" already comes from ${next.get(r.id).dir}`], warnings: [], state: 'invalid' }); continue }
      next.set(r.id, r)
    }
    for (const [id, r] of prev) if (next.get(id) !== r) { this.halt(r, { jobs: !next.has(id) }); if (next.has(id)) next.get(id).jobs = r.jobs; changed = true; this.onBots(id, null) }
    if (JSON.stringify(extra) !== JSON.stringify(this.extra)) changed = true
    this.plugins = next; this.extra = extra
    return changed
  }
  async detect(r) {
    const d = r.m.detect
    let bin = null
    for (const b of d.bin) {
      const p = b.includes('/') ? expand(b, r.dir) : searchPaths().map(x => path.join(x, b)).find(isExec)
      if (p && isExec(p)) { bin = p; break }
    }
    const found = d.paths.find(p => fs.existsSync(expand(p, r.dir))) || null
    let app = null
    if (d.bundle.length) { const res = await this.bundles(d.bundle).catch(() => ({})); app = d.bundle.find(b => res[b] === true) || null }
    const none = !d.bin.length && !d.bundle.length && !d.paths.length
    const inst = { installed: none || !!(bin || app || found), bin, app, path: found, at: Date.now() }
    const changed = JSON.stringify({ ...inst, at: 0 }) !== JSON.stringify({ ...r.inst, at: 0 })
    r.inst = inst
    return changed
  }

  // ---------- lifecycle ----------
  /** Enabled + effective grants. An installed (user) plugin counts only for the manifest the user approved (its sha256). */
  trust(r) { return pluginTrust(this.cfg(), r.m, r.sha) }
  /** The plugin's settings (profile.plugins[id].settings over the manifest defaults). */
  settings(r) { return pluginSettings(this.cfg(), r.m) }
  active(r) { return !this.stopped && !r.errors.length && r.inst?.installed && this.trust(r).enabled }
  halt(r, { jobs = false } = {}) {
    clearTimeout(r.rt.timer); clearTimeout(r.rt.botTimer); r.rt.timer = r.rt.botTimer = null; r.rt.on = false
    for (const c of r.kids || []) try { process.kill(-c.pid, 'SIGKILL') } catch {} // in-flight status / action processes
    // detached jobs (long builds) survive grant changes and a DeckStudio restart, not the plugin being switched off / removed
    if (jobs) for (const c of r.jobs || []) try { process.kill(-c.pid, 'SIGTERM') } catch {}
  }
  /** Follow profile edits (enable / grants) and installs: start or stop each plugin's pollers. */
  sync() {
    for (const r of this.plugins.values()) {
      if (r.errors.length) continue
      if (!r.inst || Date.now() - r.inst.at > DETECT_MS) { if (!r.detecting) { r.detecting = true; this.detect(r).then(ch => { if (ch) { this.sync(); this.onChange() } }).finally(() => { r.detecting = false }) } if (!r.inst) continue }
      const t = this.trust(r)
      const sig = JSON.stringify([t, this.settings(r)])
      const on = this.active(r)
      if (on && (!r.rt.on || r.rt.sig !== sig)) {
        this.halt(r); r.rt.on = true; r.rt.sig = sig
        if (r.m.status) this.poll(r)
        if (r.m.bots && r.m.bots.kind !== 'builtin') this.pollBots(r)
        this.onChange()
      } else if (!on && r.rt.on) {
        this.halt(r, { jobs: true }); r.rt = { state: 'off', values: {} }; this.onBots(r.id, null); this.onChange()
      }
    }
  }
  /** The plugins a page uses (from referencedPlugins): polled at their own interval; the rest at most every 30 s. */
  focus(ids) {
    const prev = this.wanted
    this.wanted = new Set(ids)
    for (const id of this.wanted) {
      const r = this.plugins.get(id)
      if (!prev.has(id) && r?.rt.on && r.m.status && Date.now() - (r.rt.polledAt || 0) > r.m.status.interval * 1000) { clearTimeout(r.rt.timer); this.poll(r) }
    }
  }
  delay(r, t) { const iv = t.interval * 1000; return this.wanted.has(r.id) ? iv : Math.max(iv, IDLE_MS) }

  // ---------- transports ----------
  env(r, vars = {}) {
    const extra = Object.fromEntries(Object.entries(vars).filter(([, v]) => v != null && typeof v !== 'object').map(([k, v]) => [`DECK_${k.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, String(v)]))
    return { ...process.env, ...extra, DECK_PLUGIN: r.id, DECK_PLUGIN_DIR: r.dir, DECKSTUDIO_HOME: homeDir(), ...(r.inst?.bin ? { DECK_BIN: r.inst.bin } : {}) }
  }
  argv(r, cmd, vars) {
    return cmd.map((a, i) => {
      if (a === '$bin') { if (!r.inst?.bin) throw new Error(`${r.m.name}: program not found (detect.bin)`); return r.inst.bin }
      const s = i === 0 ? a : fillArg(a, vars)
      const out = /^(~\/|\$dir(\/|$))/.test(s) ? expand(s, r.dir) : s
      // a "$dir/…" program must really be a file of the plugin (not a symlink out of it)
      if (i === 0 && a.startsWith('$dir/') && !under(canon(out), canon(r.dir))) throw new Error(`${a}: not a file inside the plugin folder`)
      return out
    })
  }
  async exec(r, cmd, { timeout, vars = {} }) {
    const why = cmdAllowed(cmd, this.trust(r).grants, r.m)
    if (why) throw new Error(why)
    const opt = { timeout: timeout * 1000, env: this.env(r, vars), cwd: r.dir, track: (r.kids ??= new Set()) }
    if (typeof cmd === 'string') return runProcess('/bin/zsh', ['-lc', cmd], opt) // shell: values only via env ($DECK_VALUE…), never templated in
    const [file, ...args] = this.argv(r, cmd, vars)
    return runProcess(file, args, opt)
  }
  /** One read of a transport → the parsed document (throws with a short reason). */
  async read(r, t, vars) {
    if (t.kind === 'builtin') {
      const f = this.builtins[t.builtin]
      if (!f) throw new Error(`built-in status "${t.builtin}" unavailable`)
      return { doc: await f() }
    }
    if (t.kind === 'cmd') {
      const res = await this.exec(r, t.cmd, { timeout: t.timeout, vars })
      if (!res.ok) throw new Error(res.stderr)
      return { doc: parseStatus(res.stdout, t.parse) }
    }
    if (t.kind === 'http') {
      const why = httpAllowed(t.http, this.trust(r).grants)
      if (why) throw new Error(why)
      const res = await fetch(t.http, { redirect: 'manual', signal: AbortSignal.timeout(t.timeout * 1000), headers: { accept: 'application/json, text/plain' } })
      if (!res.ok) { res.body?.cancel().catch(() => {}); throw new Error(`http ${res.status}`) }
      return { doc: parseStatus(await readCapped(res), t.parse) }
    }
    const filled = fillArg(t.file, settingsVars(this.settings(r)))
    if (!/^(\/|~\/|\$dir\/)/.test(filled) || filled.split('/').includes('..') || /[\u0000-\u001f]/.test(filled)) throw new Error('status file: the setting must be an absolute or ~/ path')
    const file = path.resolve(expand(filled, r.dir))
    if (denied(file)) throw new Error('that file is off limits')
    let real
    try { real = fs.realpathSync.native(file) } catch (e) { if (e.code === 'ENOENT') return { doc: undefined, missing: true }; throw new Error(`status file: ${e.code || e.message}`) }
    if (!allowedStatusFile(r, real)) throw new Error(`that file is off limits (status files live in the plugin folder, ~/.deckstudio/status/${r.id}/, the app's own Application Support folder, or the exact file the manifest names)`)
    const st = fs.statSync(real)
    if (!st.isFile() || st.size > LIMITS.out) throw new Error('not a file (or over 1 MB)')
    const c = r.rt.fileCache
    if (c && c.real === real && c.mtime === st.mtimeMs && c.size === st.size) return { doc: c.doc, mtime: st.mtimeMs }
    const doc = parseStatus(fs.readFileSync(real, 'utf8'), t.parse)
    r.rt.fileCache = { real, mtime: st.mtimeMs, size: st.size, doc }
    return { doc, mtime: st.mtimeMs }
  }
  async poll(r) {
    clearTimeout(r.rt.timer)
    if (!r.rt.on || r.rt.busy) return
    const rt = r.rt
    rt.busy = true
    try { const { doc, mtime, missing } = await this.read(r, r.m.status, { ...this.ctxVars(), ...settingsVars(this.settings(r)) }); rt.doc = doc; rt.mtime = mtime; rt.missing = !!missing; rt.at = Date.now(); rt.error = null }
    catch (e) { rt.error = this.scrubber(r)(String(e.message || e).slice(0, 200)) } // shown by /api/plugins and MCP
    finally { rt.busy = false; rt.polledAt = Date.now() }
    if (r.rt !== rt || !rt.on) return
    if (this.update(r)) this.onChange()
    rt.timer = setTimeout(() => this.poll(r), this.delay(r, r.m.status))
  }
  /**
   * Lifecycle ({id._state}) and values from the last read:
   * - stale: no good read within status.stale s, a heartbeat / file mtime older than that, the doc says `stale: true`,
   *   or its `pid` (while `running` isn't false) is gone: a crash;
   * - stopped: the tool isn't running, cleanly: its doc says `running: false` (values from the doc, whatever its age),
   *   or a `file` status doesn't exist yet (never ran: values at their defaults).
   */
  update(r) {
    const rt = r.rt, st = r.m.status, now = Date.now(), win = st.stale * 1000
    const doc = rt.doc && typeof rt.doc === 'object' ? rt.doc : null
    const hb = heartbeatAt(doc) ?? (st.kind === 'file' ? rt.mtime : null)
    const stopped = !!rt.at && !rt.error && (rt.missing || (doc?.running === false && doc.stale !== true))
    const stale = !!rt.at && !stopped && (now - rt.at > win || (hb != null && now - hb > win) || doc?.stale === true || (Number.isInteger(doc?.pid) && doc.pid > 1 && doc.running !== false && !alive(doc.pid)))
    const state = !rt.at ? (rt.error ? 'error' : 'starting') : stale ? 'stale' : rt.error ? 'error' : stopped ? 'stopped' : 'ok'
    const values = extractValues(r.m, rt.at && !rt.missing ? rt.doc : undefined, { stale, settings: this.settings(r) })
    const sig = JSON.stringify([state, values, rt.error])
    if (sig === rt.sig2) return false
    rt.sig2 = sig; rt.state = state; rt.values = values
    return true
  }
  async pollBots(r) {
    clearTimeout(r.rt.botTimer)
    const rt = r.rt
    if (!rt.on) return
    const t = r.m.bots
    let doc = null, error = null
    try { doc = (await this.read(r, t)).doc; if (typeof doc === 'string') throw new Error('bots output is not json') } catch (e) { error = String(e.message || e).slice(0, 200) }
    if (r.rt !== rt || !rt.on) return
    const g = this.trust(r).grants
    if (doc || error) { rt.bots = doc ? { doc, at: Date.now() } : rt.bots; rt.botsError = error }
    this.onBots(r.id, { name: r.m.name, doc: rt.bots?.doc || null, error, stale: !!error && !!rt.bots, trust: { allowShell: g.shell, schemes: g.schemes } })
    rt.botTimer = setTimeout(() => this.pollBots(r), this.delay(r, t))
  }
  /** Re-read a plugin's status now (after an action, or POST /api/plugins/:id/refresh). */
  refresh(id) {
    const r = this.get(id)
    if (r.rt.on && r.m.status) { clearTimeout(r.rt.timer); return this.poll(r) }
  }

  // ---------- template vars ----------
  ctxVars() { return this.cache ?? {} }
  vars() {
    const out = {}
    for (const r of this.plugins.values()) {
      if (r.errors.length) continue
      Object.assign(out, pluginVars(r.id, r.rt.on ? r.rt.values : {}, this.state(r), publicSettings(r.m, this.settings(r)))) // secret settings never become vars
    }
    this.cache = out
    return out
  }
  state(r) {
    if (r.errors.length) return 'invalid'
    if (!r.inst) return 'detecting'
    if (!r.inst.installed) return 'missing'
    if (!this.trust(r).enabled) return 'disabled'
    return r.m.status ? r.rt.state || 'starting' : 'ok'
  }

  // ---------- actions ----------
  get(id) {
    const r = this.plugins.get(String(id || ''))
    if (!r) throw errOf(`no plugin "${id}"`, 404)
    return r
  }
  /** Why a plugin can't act right now (null: it can). */
  blocked(r) {
    if (r.errors.length) return `${r.id}: invalid manifest (${r.errors[0]})`
    const t = this.trust(r)
    if (!t.enabled) return t.updated ? `plugin ${r.m.name} was updated: review the changes and switch it on again in the editor (plugins)` : `plugin ${r.m.name} is off: switch it on in the editor (plugins)`
    if (r.inst && !r.inst.installed) return `${r.m.name} isn't installed${r.m.install?.brew ? ` (brew install ${r.m.install.brew})` : r.m.install?.url ? ` (${r.m.install.url})` : ''}`
    return null
  }
  /** { type: 'plugin', plugin, action, args? } from a key / dial / strip, or POST /api/plugins/:id/action. */
  async run(ref, ctx = {}) {
    const r = this.get(ref?.plugin)
    const why = this.blocked(r)
    if (why) throw new Error(why)
    if (!r.inst) await this.detect(r)
    if (!r.inst.installed) throw new Error(this.blocked(r))
    const name = String(ref.action || '')
    const a = Object.hasOwn(r.m.actions, name) ? r.m.actions[name] : null
    if (!a) throw new Error(`${r.id} has no action "${name}" (${Object.keys(r.m.actions).join(', ') || 'none'})`)
    // args are filled from this plugin's own {id.value} / {id.settings.x} / {settings.x} and the control's {value} {index} {page}…,
    // never from other plugins' values or settings (a plugin can't read another plugin's data through its args).
    // Args come from the caller (a key, the API, MCP), so they only see public settings: a secret one ({vault.settings.api_key}
    // as an arg) would land in argv / a url and come back in the error. The manifest's own cmd / url / body get every setting.
    const all = this.settings(r), pub = publicSettings(r.m, all), values = r.rt.on ? r.rt.values : {}
    const ctrl = Object.fromEntries(Object.entries(ctx.vars || {}).filter(([k]) => !k.includes('.')))
    const base = { ...ctrl, ...pluginVars(r.id, values, this.state(r), pub), ...settingsVars(pub) }
    const scrub = this.scrubber(r)
    let res
    try {
      const args = Object.fromEntries(Object.entries(ref.args && typeof ref.args === 'object' ? ref.args : {})
        .filter(([k, v]) => a.params.includes(k) && ['string', 'number', 'boolean'].includes(typeof v)).map(([k, v]) => [k, typeof v === 'string' ? fillArg(v, base).slice(0, 500) : v]))
      const vars = { ...ctrl, ...pluginVars(r.id, values, this.state(r), all), ...settingsVars(all), ...args }
      res = await this.dispatch(r, name, a, args, vars, ctx)
    } catch (e) { throw e instanceof Error ? Object.assign(e, { message: scrub(e.message) }) : new Error(scrub(String(e))) }
    for (const k of ['stderr', 'error']) if (typeof res?.[k] === 'string') res[k] = scrub(res[k])
    if (a.refresh && r.m.status && r.rt.on) setTimeout(() => this.refresh(r.id)?.catch?.(() => {}), 150)
    return res
  }
  /** s → s with this plugin's secret setting values masked: action errors and status errors reach the API, MCP and actions.log. */
  scrubber(r) {
    const all = this.settings(r)
    const secrets = Object.keys(r.m.settings || {}).filter(k => r.m.settings[k].secret && typeof all[k] === 'string' && all[k].length >= 4).map(k => all[k])
    // also a secret's start at the very end: stderr is cut at 200 characters, maybe mid-secret
    const cut = t => { for (const x of secrets) for (let n = x.length - 1; n >= 4; n--) if (t.endsWith(x.slice(0, n))) return t.slice(0, -n) + '[secret]'; return t }
    return s => (typeof s === 'string' && secrets.length ? cut(secrets.reduce((t, x) => t.split(x).join('[secret]'), s)) : s)
  }
  async dispatch(r, name, a, args, vars, ctx) {
    const g = this.trust(r).grants
    let res
    if (a.kind === 'cmd' && a.detach) {
      res = await this.detached(r, name, a, vars, ctx)
    } else if (a.kind === 'cmd') {
      res = await this.exec(r, a.cmd, { timeout: a.timeout, vars })
      if (res.ok && a.toast && res.stdout.trim()) ctx.engine?.toast(res.stdout.trim().split('\n')[0].slice(0, 120))
    } else if (a.kind === 'http') {
      const url = fillArg(a.http, vars, encodeURIComponent)
      const why2 = httpAllowed(url, g)
      if (why2) throw new Error(why2)
      const out = await fetch(url, { method: a.method, redirect: 'manual', signal: AbortSignal.timeout(a.timeout * 1000), headers: a.body ? { 'content-type': 'application/json' } : undefined,
        body: a.body && a.method !== 'GET' ? fillArg(a.body, vars, v => JSON.stringify(v).slice(1, -1)) : undefined })
      out.body?.cancel().catch(() => {})
      res = { ok: out.ok, stderr: out.ok ? '' : `http ${out.status}` }
    } else if (a.kind === 'url') {
      const url = fillArg(a.url, vars, encodeURIComponent)
      const why2 = urlAllowed(url, g)
      if (why2) throw new Error(why2)
      res = await runProcess('/usr/bin/open', [url], { timeout: 10e3 })
    } else if (a.kind === 'app') {
      const target = a.target === 'bundle' ? r.inst.app || r.m.detect.bundle[0] : a.target
      res = await this.runAction({ type: 'app', target }, ctx)
    } else if (a.kind === 'builtin') {
      res = await this.runAction({ ...a.action, ...args }, ctx)
    }
    return res
  }
  /**
   * A `detach: true` cmd action (a long build): started in its own process group with output to
   * <DECKSTUDIO_HOME>/plugins-logs/<id>-<action>.log (0600, rewritten each run), reported as started at once.
   * Killed after its timeout (default 30 min) or when the plugin is switched off; it outlives a DeckStudio restart.
   * When it ends, the status is re-read and, with toast: true, the strip says "done" / "failed (exit n)".
   */
  async detached(r, name, a, vars, ctx) {
    const why = cmdAllowed(a.cmd, this.trust(r).grants, r.m)
    if (why) throw new Error(why)
    const [file, ...args] = typeof a.cmd === 'string' ? ['/bin/zsh', '-lc', a.cmd] : this.argv(r, a.cmd, vars)
    const jobs = (r.jobs ??= new Set())
    if ([...jobs].some(c => c.action === name)) return { ok: false, stderr: `${a.title || name} is still running (see ${path.join(logsDir(), `${r.id}-${name}.log`)})` }
    fs.mkdirSync(logsDir(), { recursive: true, mode: 0o700 })
    const log = path.join(logsDir(), `${r.id}-${name}.log`)
    const fd = fs.openSync(log, 'w', 0o600)
    fs.fchmodSync(fd, 0o600)
    fs.writeSync(fd, `# ${new Date().toISOString()} ${r.id}.${name}\n`)
    let child
    try { child = spawn(file, args, { detached: true, stdio: ['ignore', fd, fd], env: this.env(r, vars), cwd: r.dir }) }
    catch (e) { fs.closeSync(fd); return { ok: false, stderr: e.message } }
    fs.closeSync(fd)
    const started = await new Promise(res => { child.once('spawn', () => res(null)); child.once('error', e => res(e)) })
    if (started) return { ok: false, stderr: String(started.message).slice(0, 200) }
    child.action = name
    jobs.add(child)
    child.unref()
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, a.timeout * 1000)
    timer.unref?.()
    child.once('exit', (code, signal) => {
      clearTimeout(timer); jobs.delete(child)
      try { fs.appendFileSync(log, `\n# exit ${signal || code} at ${new Date().toISOString()}\n`) } catch {}
      if (a.toast) ctx.engine?.toast(`${a.title || name}: ${code === 0 ? 'done' : `failed (${signal || `exit ${code}`})`}`.slice(0, 120))
      if (a.refresh && r.m.status && r.rt.on) this.refresh(r.id)?.catch?.(() => {})
    })
    if (a.toast) ctx.engine?.toast(`${a.title || name}: started`.slice(0, 120))
    return { ok: true, started: true, pid: child.pid, log, stdout: '', stderr: '' }
  }

  // ---------- for the API / editor / recipes ----------
  info(r) {
    const t = r.errors.length ? null : this.trust(r)
    const m = r.m
    return {
      id: r.id, name: m.name, version: m.version, author: m.author, homepage: m.homepage, description: m.description, icon: m.icon, builtin: m.builtin,
      source: r.source, dir: r.dir, valid: !r.errors.length, errors: r.errors, warnings: r.warnings,
      installed: r.inst ? r.inst.installed : null, bin: r.inst?.bin || null, app: r.inst?.app || null, install: m.install,
      enabled: t?.enabled ?? false, permissions: m.permissions, grants: t?.grants, needs: t ? missingGrants(m, t) : undefined,
      state: this.state(r), error: r.rt.on ? r.rt.error || null : null, values: r.rt.on ? r.rt.values : {}, updatedAt: r.rt.at || null,
      vars: Object.keys(pluginVars(r.id, m.status ? extractValues(m, undefined) : {}, '', publicSettings(m, this.settings(r)))).map(k => `{${k}}`),
      // a secret setting's value never leaves the server (not here, not in vars, not over MCP): only whether it is set
      settings: Object.entries(m.settings || {}).map(([name, s]) => ({ name, ...s, ...(s.secret ? { set: !!this.settings(r)[name] } : { value: this.settings(r)[name] }) })),
      ...(t?.updated ? { updated: true } : {}),
      status: m.status ? { kind: m.status.kind, interval: m.status.interval, stale: m.status.stale } : null,
      bots: m.bots ? { kind: m.bots.kind, error: r.rt.botsError || null } : null,
      actions: Object.entries(m.actions).map(([name, a]) => ({ name, title: a.title, kind: a.kind, params: a.params, blocked: t ? actionBlocked(a, t.grants, m) : 'invalid', ...(a.kind === 'cmd' ? { timeout: a.timeout } : {}), ...(a.detach ? { detach: true, running: [...(r.jobs || [])].some(c => c.action === name) } : {}) })),
      templates: Object.fromEntries(Object.entries(m.templates).map(([k, v]) => [k, Object.keys(v)])),
    }
  }
  summary() {
    return { plugins: [...[...this.plugins.values()].map(r => this.info(r)), ...this.extra], dirs: this.dirs }
  }
  one(id) { const r = this.get(id); return { ...this.info(r), manifest: r.m } }
  recipes(context) {
    return [...this.plugins.values()].filter(r => !r.errors.length).flatMap(r => pluginRecipes(r.m, { context }).map(x => ({ ...x, pluginEnabled: this.trust(r).enabled, pluginInstalled: r.inst?.installed ?? null })))
  }
  /** A png / svg icon file inside the plugin folder (served at /plugin-icon/<id>.<ext>), or null. */
  iconFile(id) {
    const r = this.plugins.get(id)
    if (!r?.m.icon?.file) return null
    const f = path.join(r.dir, r.m.icon.file)
    try { const real = fs.realpathSync(f); return real.startsWith(fs.realpathSync(r.dir) + path.sep) && fs.statSync(real).size <= 512 << 10 ? real : null } catch { return null }
  }
}
function actionBlocked(a, g, m) {
  if (a.kind === 'cmd') return cmdAllowed(a.cmd, g, m)
  if (a.kind === 'http') return httpAllowed(a.http.replace(/\{[^}]*\}/g, 'x'), g)
  if (a.kind === 'url') return urlAllowed(a.url, g)
  return null
}
