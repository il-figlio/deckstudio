// deckstudio.json (plugin/v1): a builder and an offline validator.
// validate() mirrors DeckStudio's validateManifest (src/plugin-schema.mjs) rule for rule, with the same messages, but
// imports nothing from DeckStudio. test/parity.test.js runs both on the same manifests when DeckStudio is checked out.
import { mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { STALE_MS } from './status.js'

export const PLUGIN_SCHEMA = 'plugin/v1'
export const MANIFEST = 'deckstudio.json'
export const RESERVED_IDS = Object.freeze(['self', 'plugin', 'plugins', 'deckstudio', 'deck', 'page', 'value', 'out', 'settings'])
const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/
const ACTION_RE = /^[a-z][a-z0-9_-]{0,31}$/
const BUNDLE_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
const SCHEME_RE = /^[a-z][a-z0-9+.-]{1,30}$/
const HOST_RE = /^(\[[0-9a-f:]+\]|[a-z0-9.-]{1,253})(:\d{1,5})?$/i
const NEVER_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'view-source', 'jar', 'about', 'filesystem'])
const INTERPRETERS = /^(sh|bash|zsh|dash|ksh|mksh|fish|csh|tcsh|env|xargs|osascript|osacompile|python[0-9.]*|pythonw|node|nodejs|perl[0-9.]*|ruby|irb|php|lua|luajit|deno|bun|swift|swiftc|tclsh[0-9.]*|wish|expect|open|sudo|su|doas|launchctl|arch|nohup|nice|renice|timeout|gtimeout|time|caffeinate|script|find|awk|gawk|mawk|nawk|sed|gsed|make|gmake|exec|command|builtin|eval|sandbox-exec|login|screen|tmux|watch|parallel|at|batch|crontab|ssh|scp|curl|wget|nc|ncat|git|npx|npm|pnpm|yarn|pip[0-9.]*|uv|uvx|java|jshell|R|Rscript|julia|ghci|runghc|dotnet|pwsh|vim|nvim|vi|emacs|man)$/
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
const BUILTINS = { capture: ['capture'], bots: ['page'], grokbot: ['app'] }
const LIMITS = { values: 32, actions: 32, templates: 32, detect: 8, settings: 32, templateBytes: 64 << 10, timeout: 60, actionTimeout: 1800 }
const KNOWN = ['deckstudio', 'id', 'name', 'version', 'author', 'homepage', 'description', 'icon', 'detect', 'install', 'status', 'values', 'actions', 'templates', 'settings', 'bots', 'permissions', 'builtin', '$schema']
const SETTING_REF_RE = /\{(?:self\.)?settings\.(\w+)(?:\|path)?\}/g
const SETTING_TYPES = ['string', 'number', 'boolean']
const TESTS = ['above', 'below', 'atLeast', 'atMost']

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)
const str = (v, n) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '')
const list = v => (Array.isArray(v) ? v : v == null ? [] : [v])
const https = u => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password } catch { return false } }
const scheme = u => String(u).slice(0, Math.max(0, String(u).indexOf(':'))).toLowerCase()
const pathLike = s => typeof s === 'string' && s.length <= 512 && !/[\u0000-\u001f]/.test(s) && /^(\/|~\/|\$dir\/)/.test(s) && !s.split('/').includes('..')
const binLike = s => pathLike(s) || /^[\w.+-]{1,64}$/.test(String(s))
const filePathLike = s => pathLike(s) || (typeof s === 'string' && s.length <= 512 && /^\{settings\.\w+\}/.test(s) && !/[\u0000-\u001f]/.test(s) && !s.split('/').includes('..'))
const hostMatch = (h, x) => h === x.host.toLowerCase() || (!h.includes(':') && h === x.hostname.toLowerCase())

const TOKEN_RE = /\.([A-Za-z_$][\w$-]*)|\[(-?\d+)\]|\[(?:'([^']*)'|"([^"]*)")\]/y
/** Parses a JSONPath-lite path ($, $.a.b, $.a[0], $.a[-1], $['k'], $.a.length) into steps; throws on anything else. */
export function parsePath(p) {
  const s = String(p ?? '').trim()
  if (!s.startsWith('$')) throw new Error(`path must start with $: ${s.slice(0, 40)}`)
  const steps = []
  TOKEN_RE.lastIndex = 1
  while (TOKEN_RE.lastIndex < s.length) {
    const at = TOKEN_RE.lastIndex
    const m = TOKEN_RE.exec(s)
    if (!m || m.index !== at) throw new Error(`bad path at "${s.slice(at, at + 20)}" (supported: $.a.b, $.a[0], $['k'])`)
    steps.push(m[1] ?? (m[2] != null ? Number(m[2]) : m[3] ?? m[4]))
    if (steps.length > 16) throw new Error('path too deep')
  }
  return steps
}
/** Evaluates a JSONPath-lite path against a document (what DeckStudio does for `values`). */
export function jsonPath(doc, p) {
  let v = doc
  for (const k of Array.isArray(p) ? p : parsePath(p)) {
    if (v == null) return undefined
    if (k === 'length' && (Array.isArray(v) || typeof v === 'string')) { v = v.length; continue }
    if (typeof k === 'number') v = Array.isArray(v) ? v[k < 0 ? v.length + k : k] : undefined
    else v = typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined
  }
  return v
}

function checkCmd(c, where, e, perms, w, bins = []) {
  if (typeof c === 'string') {
    if (!c.trim()) return e.push(`${where}: empty command`)
    if (!perms.shell) e.push(`${where}: a shell-string command needs "permissions": { "shell": true } (or use an argv array)`)
    if (/\$bin\b/.test(c)) w.push(`${where}: "$bin" isn't replaced inside a shell string: use "$DECK_BIN"`)
    return
  }
  if (!Array.isArray(c) || !c.length || c.length > 64 || !c.every(a => typeof a === 'string' && a.length <= 4000)) return e.push(`${where}: cmd must be an argv array of strings (or a shell string)`)
  if (!(c[0] === '$bin' || binLike(c[0]))) e.push(`${where}: argv[0] must be "$bin", "$dir/…", an absolute or ~/ path, or a bare program name`)
  if (c.some(a => a !== '$bin' && /\$bin\b/.test(a))) w.push(`${where}: "$bin" is only replaced as a whole argv element`)
  if (!perms.shell && INTERPRETERS.test(c[0].split('/').pop())) e.push(`${where}: running ${c[0].split('/').pop()} is a shell in disguise: declare "permissions": { "shell": true }`)
  // without the shell permission argv[0] is the plugin's own program: "$bin", a detect.bin entry or "$dir/…"
  else if (!perms.shell && !ownProgram(c[0], bins)) e.push(`${where}: argv[0] "${c[0].slice(0, 60)}" isn't this plugin's program ("$bin", a detect.bin entry or "$dir/…"): declare "permissions": { "shell": true }`)
}
const ownProgram = (a0, bins = []) => a0 === '$bin' || (/^\$dir\/[^/]/.test(String(a0)) && !String(a0).split('/').includes('..')) || bins.includes(a0)
function checkHttp(u, where, e, perms) {
  let x
  try { x = new URL(String(u)) } catch { return e.push(`${where}: bad url`) }
  if (!/^https?:$/.test(x.protocol) || x.username || x.password) return e.push(`${where}: http(s) urls only, no user info`)
  if (!LOOPBACK.has(x.hostname) && !perms.network.some(h => hostMatch(h, x))) e.push(`${where}: ${x.host} is not loopback: declare it in "permissions": { "network": ["${x.host}"] }`)
}
function checkTransport(s, where, e, w, perms, builtin, bins) {
  if (!isObj(s)) return e.push(`${where} must be an object`)
  const kinds = ['cmd', 'http', 'file', 'builtin'].filter(k => s[k] != null)
  if (kinds.length !== 1) return e.push(`${where}: exactly one of cmd, http, file${builtin ? ', builtin' : ''}`)
  const kind = kinds[0]
  if (kind === 'cmd') checkCmd(s.cmd, `${where}.cmd`, e, perms, w, bins)
  if (kind === 'http') checkHttp(s.http, `${where}.http`, e, perms)
  if (kind === 'file' && !filePathLike(s.file)) e.push(`${where}.file: an absolute, ~/ or $dir/ path (or one starting with {settings.<name>})`)
  if (kind === 'builtin' && !builtin) e.push(`${where}.builtin: only built-in plugins`)
  for (const k of Object.keys(s)) if (!['cmd', 'http', 'file', 'builtin', 'interval', 'timeout', 'stale', 'parse'].includes(k)) w.push(`${where}.${k}: unknown field`)
}
function checkAction(a, name, e, perms, builtin, w, bins) {
  const where = `actions.${name}`
  if (!isObj(a)) return e.push(`${where} must be an object`)
  if (a.detach != null && (a.cmd == null || typeof a.detach !== 'boolean')) e.push(`${where}.detach: true / false, on cmd actions only`)
  if (a.cmd != null) return checkCmd(a.cmd, `${where}.cmd`, e, perms, w, bins)
  if (a.http != null) return checkHttp(a.http, `${where}.http`, e, perms)
  if (a.builtin != null) {
    const ok = BUILTINS[builtin]
    if (!ok) return e.push(`${where}.builtin: only built-in plugins`)
    if (!isObj(a.builtin) || !ok.includes(a.builtin.type)) e.push(`${where}.builtin: must be a ${ok.join(' / ')} action`)
    return
  }
  if (a.type === 'app') {
    const t = str(a.target, 200)
    if (t !== 'bundle' && !BUNDLE_RE.test(t)) e.push(`${where}.target: "bundle" (the detected app) or a bundle id`)
    return
  }
  if (a.type === 'url' || a.url != null) {
    const u = str(a.url, 2000), sc = scheme(u)
    if (!SCHEME_RE.test(sc) || NEVER_SCHEMES.has(sc)) return e.push(`${where}.url: not an openable url`)
    if (sc !== 'https' && !perms.schemes.includes(sc)) e.push(`${where}.url: ${sc}: links need "permissions": { "schemes": ["${sc}"] }`)
    return
  }
  e.push(`${where}: one of cmd, http, url, { type: "app" }${BUILTINS[builtin] ? ', builtin' : ''}`)
}
function checkIcon(i, e) {
  if (i == null) return
  if (typeof i === 'string') { if (!/^[\w.-]{1,64}\.(png|svg)$/.test(i)) e.push('icon: a png/svg file name in the plugin folder, { glyph } or { logo }'); return }
  if (isObj(i) && (/^[A-Za-z0-9-]{1,80}$/.test(String(i.glyph || '')) || /^[a-z0-9-]{1,80}$/.test(String(i.logo || '')))) return
  e.push('icon: a png/svg file name in the plugin folder, { glyph } or { logo }')
}
// templates: presentation + this plugin's actions (+ page / back / none, multi of those); nothing that runs code
const EXEC_ACTION_TYPES = ['shell', 'applescript', 'keys', 'hold-keys', 'type', 'http', 'shortcut']
const TEMPLATE_ACTIONS = ['plugin', 'page', 'back', 'none', 'multi']
const httpsTarget = t => typeof t === 'string' && /^https:\/\/[^\s/]/i.test(t.trim())
function execParts(json) {
  const out = []
  const walk = (v, p) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`))
    if (!isObj(v)) return
    for (const k of ['poll', 'browse']) {
      const x = v[k]
      if (x != null && x !== false && (typeof x !== 'object' || x.cmd != null || x.fn != null)) out.push({ path: p ? `${p}.${k}` : k, what: `${k} command` })
    }
    if (typeof v.type === 'string') {
      const risky = EXEC_ACTION_TYPES.includes(v.type) ? `${v.type} action` : v.type === 'open' && !httpsTarget(v.target) ? 'open of a non-https target' : null
      if (risky) out.push({ path: p || '(root)', what: risky })
    }
    for (const [k, x] of Object.entries(v)) if (x && typeof x === 'object') walk(x, p ? `${p}.${k}` : k)
  }
  walk(json, '')
  return out
}
function templateProblems(tpl, id) {
  const bad = execParts(tpl).map(x => `${x.path}: no ${x.what} in a template (templates may only use this plugin's actions and page / back)`)
  const action = (a, p) => {
    if (!isObj(a)) return
    if (!TEMPLATE_ACTIONS.includes(a.type)) return bad.push(`${p}: action "${String(a.type ?? '').slice(0, 20)}" isn't allowed in a template (use { "type": "plugin", "action": … })`)
    if (a.type === 'plugin' && a.plugin != null && a.plugin !== id) bad.push(`${p}: templates may only run this plugin's own actions (not "${String(a.plugin).slice(0, 32)}")`)
    if (a.type === 'multi') (Array.isArray(a.actions) ? a.actions : []).forEach((x, i) => action(x, `${p}.actions[${i}]`))
  }
  const walk = (v, p) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`))
    if (!isObj(v)) return
    for (const [k, x] of Object.entries(v)) {
      const q = p ? `${p}.${k}` : k
      if (/^on[A-Z]\w*$/.test(k)) action(x, q)
      else if (x && typeof x === 'object') walk(x, q)
    }
  }
  walk(tpl, '')
  return [...new Set(bad)]
}
function checkTemplates(t, e, id) {
  if (t == null) return
  if (!isObj(t)) return e.push('templates must be an object')
  if (JSON.stringify(t).length > LIMITS.templateBytes) return e.push(`templates over ${LIMITS.templateBytes >> 10} KB`)
  for (const kind of ['keys', 'dials', 'pages']) {
    if (t[kind] == null) continue
    if (!isObj(t[kind])) { e.push(`templates.${kind} must be an object`); continue }
    for (const [name, raw] of Object.entries(t[kind]).slice(0, LIMITS.templates)) {
      if (!ACTION_RE.test(name) || !isObj(raw)) { e.push(`templates.${kind}.${name}: bad name or not an object`); continue }
      const tpl = isObj(raw.template) ? raw.template : raw
      if (kind === 'pages' && !Array.isArray(tpl.keys) && !tpl.source) { e.push(`templates.pages.${name}: a page needs keys (or a source)`); continue }
      const bad = templateProblems(tpl, id)
      if (bad.length) e.push(...bad.slice(0, 4).map(x => `templates.${kind}.${name}.${x}`))
    }
  }
}

function checkSettings(s, e) {
  const ok = new Set()
  if (s == null) return ok
  if (!isObj(s)) { e.push('settings must be an object'); return ok }
  for (const [k, v] of Object.entries(s).slice(0, LIMITS.settings)) {
    if (!NAME_RE.test(k)) { e.push(`settings.${k}: names start with a-z, then a-z 0-9 _`); continue }
    if (!isObj(v)) { e.push(`settings.${k}: { type?, default?, title?, description? }`); continue }
    const type = v.type ?? 'string'
    if (!SETTING_TYPES.includes(type)) { e.push(`settings.${k}.type: one of ${SETTING_TYPES.join(', ')}`); continue }
    if (v.default != null && typeof v.default !== type) { e.push(`settings.${k}.default: must be a ${type}`); continue }
    if (v.secret != null && (v.secret !== true || type !== 'string')) { e.push(`settings.${k}.secret: true, on string settings only`); continue }
    if (v.secret && v.default) { e.push(`settings.${k}: a secret setting has no default (the user enters it)`); continue }
    ok.add(k)
  }
  return ok
}

/**
 * Validates a manifest offline (object or JSON text), with DeckStudio's rules for a user / linked plugin.
 * Errors make DeckStudio refuse the plugin; warnings don't.
 * @returns {{ ok: boolean, errors: string[], warnings: string[] }}
 */
export function validate(raw) {
  const e = [], w = []
  let d = raw
  if (typeof raw === 'string') try { d = JSON.parse(raw) } catch (x) { return { ok: false, errors: [`not json: ${x.message}`], warnings: [] } }
  if (!isObj(d)) return { ok: false, errors: ['manifest must be a JSON object'], warnings: [] }
  if (d.deckstudio !== PLUGIN_SCHEMA) e.push(`"deckstudio" must be "${PLUGIN_SCHEMA}"`)
  const id = String(d.id ?? '')
  if (!PLUGIN_ID_RE.test(id) || RESERVED_IDS.includes(id)) e.push('id: a-z 0-9 -, up to 32, starting with a letter or digit (not a reserved word)')
  if (d.builtin != null) e.push('builtin: only plugins shipped with DeckStudio')
  const p = isObj(d.permissions) ? d.permissions : {}
  const perms = {
    shell: p.shell === true,
    schemes: [...new Set(list(p.schemes).map(s => String(s).toLowerCase().replace(/:$/, '')))].filter(s => SCHEME_RE.test(s) && !NEVER_SCHEMES.has(s) && s !== 'https').slice(0, 8),
    network: [...new Set(list(p.network).map(h => String(h).toLowerCase()))].filter(h => HOST_RE.test(h)).slice(0, 8),
  }
  if (d.permissions != null && !isObj(d.permissions)) e.push('permissions must be an object')
  checkIcon(d.icon, e)
  if (d.homepage != null && !https(String(d.homepage || ''))) w.push('homepage: https urls only (ignored)')
  if (!str(d.version, 20)) w.push('version: missing')
  const det = isObj(d.detect) ? d.detect : {}
  const detect = {
    bundle: list(det.bundle).map(String).filter(b => BUNDLE_RE.test(b)).slice(0, LIMITS.detect),
    bin: list(det.bin).filter(binLike).slice(0, LIMITS.detect),
    paths: list(det.paths).filter(pathLike).slice(0, LIMITS.detect),
  }
  if (list(det.bundle).length + list(det.bin).length + list(det.paths).length !== detect.bundle.length + detect.bin.length + detect.paths.length) w.push('detect: some entries were not bundle ids / paths / program names (ignored)')
  for (const b of detect.bin) if (!perms.shell && INTERPRETERS.test(String(b).split('/').pop())) e.push(`detect.bin: ${String(b).split('/').pop()} is a shell or interpreter: declare "permissions": { "shell": true }`)
  const bins = detect.bin.filter(b => !INTERPRETERS.test(String(b).split('/').pop()))
  if (d.status != null) checkTransport(d.status, 'status', e, w, perms, false, bins)
  if (d.bots != null) checkTransport(d.bots, 'bots', e, w, perms, false, bins)
  if (d.values != null && !isObj(d.values)) e.push('values must be an object')
  let nValues = 0
  for (const [k, v] of Object.entries(isObj(d.values) ? d.values : {}).slice(0, LIMITS.values)) {
    if (!NAME_RE.test(k)) { e.push(`values.${k}: names start with a-z, then a-z 0-9 _`); continue }
    const o = typeof v === 'string' ? { path: v } : isObj(v) ? v : null
    if (!o) { e.push(`values.${k}: a path string or { path, default?, stale?, round?, map?, above?, below?, atLeast?, atMost?, equals?, then?, else? }`); continue }
    try { parsePath(String(o.path ?? '').replace(SETTING_REF_RE, 'x')); nValues++ } catch (x) { e.push(`values.${k}: ${x.message}`); continue }
    let tests = 0
    for (const t of TESTS) {
      if (o[t] == null) continue
      if (typeof o[t] !== 'number' || !Number.isFinite(o[t])) e.push(`values.${k}.${t}: a number`); else tests++
    }
    if (o.equals != null) { if (['string', 'number', 'boolean'].includes(typeof o.equals)) tests++; else e.push(`values.${k}.equals: a string, number or boolean`) }
    if (!tests && (o.then != null || o.else != null)) e.push(`values.${k}: then / else need a test (above, below, atLeast, atMost or equals)`)
  }
  if (nValues && d.status == null) e.push('values need a status source')
  if (d.actions != null && !isObj(d.actions)) e.push('actions must be an object')
  const actions = Object.entries(isObj(d.actions) ? d.actions : {}).slice(0, LIMITS.actions)
  for (const [k, a] of actions) {
    if (!ACTION_RE.test(k)) { e.push(`actions.${k}: names are a-z 0-9 _ -`); continue }
    checkAction(a, k, e, perms, undefined, w, bins)
  }
  checkTemplates(d.templates, e, id)
  const settings = checkSettings(d.settings, e)
  const refs = new Set([...JSON.stringify([d.status, d.bots, d.values, d.actions, d.templates]).matchAll(SETTING_REF_RE)].map(x => x[1]))
  for (const k of refs) if (!settings.has(k)) e.push(`{settings.${k}}: "${k}" isn't declared in settings`)
  // "$bin" is only replaced as a whole argv element
  const usesBin = c => Array.isArray(c) && c.includes('$bin')
  const goodActions = actions.filter(([k, a]) => ACTION_RE.test(k) && isObj(a))
  const oneKind = t => isObj(t) && ['cmd', 'http', 'file', 'builtin'].filter(x => t[x] != null).length === 1
  if ((oneKind(d.status) && usesBin(d.status.cmd) || oneKind(d.bots) && usesBin(d.bots.cmd) || goodActions.some(([, a]) => a.cmd != null && usesBin(a.cmd))) && !detect.bin.length) e.push('"$bin" needs detect.bin (where to find the program)')
  if (goodActions.some(([, a]) => a.cmd == null && a.http == null && a.builtin == null && a.type === 'app' && str(a.target, 200) === 'bundle') && !detect.bundle.length) e.push('{ type: "app", target: "bundle" } needs detect.bundle')
  for (const k of Object.keys(d)) if (!KNOWN.includes(k)) w.push(`${k}: unknown field (ignored)`)
  return { ok: !e.length, errors: e, warnings: w }
}

/**
 * A chainable manifest builder. `build()` returns the plain object; `write(dir)` writes `<dir>/deckstudio.json`.
 * @param {string} id
 * @param {{ name?: string, version?: string, description?: string }} [init]
 */
export function manifest(id, init = {}) {
  const m = { deckstudio: PLUGIN_SCHEMA, id, name: init.name ?? id, version: init.version ?? '0.1.0' }
  if (init.description) m.description = init.description
  const obj = k => (m[k] ??= {})
  const tpl = kind => (name, template, meta = {}) => { (obj('templates')[kind] ??= {})[name] = meta.title || meta.what ? { ...meta, template } : template; return b }
  const b = {
    /** Sets any top-level field (schema url, author, homepage, …). */
    set(k, v) { m[k] = v; return b },
    name(v) { m.name = v; return b },
    version(v) { m.version = v; return b },
    description(v) { m.description = v; return b },
    author(v) { m.author = v; return b },
    homepage(v) { m.homepage = v; return b },
    icon(v) { m.icon = v; return b },
    detect(v) { m.detect = { ...m.detect, ...v }; return b },
    install(v) { m.install = v; return b },
    permissions(v) { m.permissions = { ...m.permissions, ...v }; return b },
    /** A status file written by createStatus(). `stale` defaults to 95 s, matching readStatus(). */
    statusFile(file, o = {}) { m.status = { file, stale: STALE_MS / 1000, ...o }; return b },
    /** A command printing the status, e.g. `['$bin', 'status', '--json']`. */
    statusCmd(cmd, o = {}) { m.status = { cmd, ...o }; return b },
    /** A loopback URL returning the status. */
    statusHttp(http, o = {}) { m.status = { http, ...o }; return b },
    /** A template value: `value('left', '$.values.left')` or `value('state', { path: '$.state', stale: 'off' })`. */
    value(name, spec) { obj('values')[name] = spec; return b },
    /** A user-editable setting: `setting('config', { title: 'Config file', default: '~/app/config.json' })`. */
    setting(name, spec) { obj('settings')[name] = spec; return b },
    action(name, spec) { obj('actions')[name] = spec; return b },
    /** Shorthand for an argv action. */
    cmd(name, argv, o = {}) { obj('actions')[name] = { cmd: argv, ...o }; return b },
    key: tpl('keys'),
    dial: tpl('dials'),
    page: tpl('pages'),
    build() { const { $schema, ...rest } = m; return structuredClone($schema ? { $schema, ...rest } : rest) },
    toJSON() { return b.build() },
    validate() { return validate(m) },
    /** Validates, then writes `<dir>/deckstudio.json` (pretty JSON). Throws with the errors when invalid. Returns the path. */
    write(dir) {
      const r = validate(m)
      if (!r.ok) throw new Error(`invalid manifest:\n- ${r.errors.join('\n- ')}`)
      let file = dir
      try { if (statSync(dir).isDirectory()) file = join(dir, MANIFEST) } catch { if (!String(dir).endsWith('.json')) { mkdirSync(dir, { recursive: true }); file = join(dir, MANIFEST) } }
      writeFileSync(file, `${JSON.stringify(b.build(), null, 2)}\n`)
      return file
    },
  }
  return b
}
