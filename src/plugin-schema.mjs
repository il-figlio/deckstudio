// DeckStudio plugins (plugin/v1): the manifest a small macOS tool ships as deckstudio.json, and the rules
// for what it may do. Pure functions only (no node APIs), so the browser demo, the server's PluginHost
// (src/plugins.mjs) and tooling (deckctl plugin validate, an MCP server…) share one validator.
// Spec: docs/PLUGINS.md · JSON Schema: docs/plugin.schema.json
//
// DeckStudio never loads plugin code. A plugin is data: commands (argv), loopback HTTP and files it
// declares, run only while the user has it enabled, and only with the permissions the user granted
// (profile.plugins[id] = { enabled, grants: { shell, schemes, network } }), same trust model as bots (bot-schema.mjs).

export const PLUGIN_SCHEMA = 'plugin/v1'
export const MANIFEST = 'deckstudio.json'
export const PLUGIN_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const RESERVED_IDS = new Set(['self', 'plugin', 'plugins', 'deckstudio', 'deck', 'page', 'value', 'out', 'settings'])
export const SOURCES = ['builtin', 'local', 'user', 'linked'] // scan order: the first plugin with an id wins
export const BUILTINS = { capture: ['capture'], bots: ['page'], grokbot: ['app'] } // built-in plugin → DeckStudio action types its actions may wrap
const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/          // value names ({id.name})
const ACTION_RE = /^[a-z][a-z0-9_-]{0,31}$/
const BUNDLE_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
const SCHEME_RE = /^[a-z][a-z0-9+.-]{1,30}$/
const HOST_RE = /^(\[[0-9a-f:]+\]|[a-z0-9.-]{1,253})(:\d{1,5})?$/i
const NEVER_SCHEMES = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'view-source', 'jar', 'about', 'filesystem'])
// argv[0] (or a detect.bin entry, which "$bin" becomes) that would just run a script or another program: shells,
// interpreters and wrappers (arch, nohup, caffeinate, script, find -exec, awk system()…). These need the shell
// permission, like a "shell string" command. A denylist can't be complete: it backs up the rule that argv[0] is the
// plugin's own program, and enabling a plugin still means trusting its commands (docs/PLUGINS.md).
const INTERPRETERS = /^(sh|bash|zsh|dash|ksh|mksh|fish|csh|tcsh|env|xargs|osascript|osacompile|python[0-9.]*|pythonw|node|nodejs|perl[0-9.]*|ruby|irb|php|lua|luajit|deno|bun|swift|swiftc|tclsh[0-9.]*|wish|expect|open|sudo|su|doas|launchctl|arch|nohup|nice|renice|timeout|gtimeout|time|caffeinate|script|find|awk|gawk|mawk|nawk|sed|gsed|make|gmake|exec|command|builtin|eval|sandbox-exec|login|screen|tmux|watch|parallel|at|batch|crontab|ssh|scp|curl|wget|nc|ncat|git|npx|npm|pnpm|yarn|pip[0-9.]*|uv|uvx|java|jshell|R|Rscript|julia|ghci|runghc|dotnet|pwsh|vim|nvim|vi|emacs|man)$/
export const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
// timeout: status reads and http actions (s); actionTimeout: cmd actions (s, 30 min, for long builds); stale: the default
// stale window max(95, 3 × interval) (s), the SDKs' 95 s: three missed 30 s heartbeats plus slack
export const LIMITS = { values: 32, actions: 32, templates: 32, detect: 8, settings: 32, out: 1 << 20, templateBytes: 64 << 10, timeout: 60, actionTimeout: 1800, stale: 95 }
// Template vars: {name}, {plugin-id.value}, {plugin-id.settings.name} (and {settings.name} inside a plugin's own commands).
// An optional "|path" filter ({repo|path}) keeps "/" when the value goes into a url path (see fillArg).
export const VAR_RE = /\{(\w+|[a-z0-9][a-z0-9-]*\.(?:settings\.)?\w+)(?:\|(path))?\}/g
const SETTING_REF_RE = /\{(?:self\.)?settings\.(\w+)(?:\|path)?\}/g
const SETTING_TYPES = ['string', 'number', 'boolean']
// value tests: the value becomes `then` ("on") when every test holds, else `else` ("")
const TESTS = { above: (x, n) => x > n, below: (x, n) => x < n, atLeast: (x, n) => x >= n, atMost: (x, n) => x <= n }

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)
const str = (v, n) => (typeof v === 'string' || typeof v === 'number' ? String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, n) : '')
const list = v => (Array.isArray(v) ? v : v == null ? [] : [v])
const num = (v, d, lo, hi) => { const n = Number(v); return Math.max(lo, Math.min(hi, Number.isFinite(n) && v !== null && v !== '' ? n : d)) }
const https = u => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password } catch { return false } }
const scheme = u => String(u).slice(0, Math.max(0, String(u).indexOf(':'))).toLowerCase()
const pathLike = s => typeof s === 'string' && s.length <= 512 && !/[\u0000-\u001f]/.test(s) && /^(\/|~\/|\$dir\/)/.test(s) && !s.split('/').includes('..')
const binLike = s => pathLike(s) || /^[\w.+-]{1,64}$/.test(String(s))
// a status file: a path, or one that starts with a setting ({settings.status_file}, checked again once filled)
const filePathLike = s => pathLike(s) || (typeof s === 'string' && s.length <= 512 && /^\{settings\.\w+\}/.test(s) && !/[\u0000-\u001f]/.test(s) && !s.split('/').includes('..'))

// ---------- JSONPath-lite: $ · $.a.b · $.a[0] · $.a[-1] · $['odd key'] · $.a.length ----------
const TOKEN_RE = /\.([A-Za-z_$][\w$-]*)|\[(-?\d+)\]|\[(?:'([^']*)'|"([^"]*)")\]/y
/** Parses a path into steps (strings / numbers); throws on anything else (no wildcards, filters or recursion). */
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

// ---------- the manifest ----------
function normCmd(c, where, e, perms, w = [], bins = []) {
  if (typeof c === 'string') {
    if (!c.trim()) return e.push(`${where}: empty command`), null
    if (!perms.shell) e.push(`${where}: a shell-string command needs "permissions": { "shell": true } (or use an argv array)`)
    if (/\$bin\b/.test(c)) w.push(`${where}: "$bin" isn't replaced inside a shell string: use "$DECK_BIN"`)
    return c.slice(0, 4000)
  }
  if (!Array.isArray(c) || !c.length || c.length > 64 || !c.every(a => typeof a === 'string' && a.length <= 4000)) return e.push(`${where}: cmd must be an argv array of strings (or a shell string)`), null
  if (!(c[0] === '$bin' || binLike(c[0]))) e.push(`${where}: argv[0] must be "$bin", "$dir/…", an absolute or ~/ path, or a bare program name`)
  if (c.some(a => a !== '$bin' && /\$bin\b/.test(a))) w.push(`${where}: "$bin" is only replaced as a whole argv element`)
  if (!perms.shell && INTERPRETERS.test(c[0].split('/').pop())) e.push(`${where}: running ${c[0].split('/').pop()} is a shell in disguise: declare "permissions": { "shell": true }`)
  // Without the shell permission argv[0] is the plugin's own program: "$bin", one of its detect.bin entries, or a file
  // shipped in the plugin ("$dir/…"). Any other program (arch, awk, find, caffeinate, script…) can run arbitrary code
  // through its arguments, so it needs the shell permission like a shell string.
  else if (!perms.shell && !ownProgram(c[0], bins)) e.push(`${where}: argv[0] "${c[0].slice(0, 60)}" isn't this plugin's program ("$bin", a detect.bin entry or "$dir/…"): declare "permissions": { "shell": true }`)
  return c.slice()
}
/** argv[0] that runs the plugin's own program: "$bin", a detect.bin entry (not an interpreter), or a file in the plugin folder. */
const ownProgram = (a0, bins = []) => a0 === '$bin' || (/^\$dir\/[^/]/.test(String(a0)) && !String(a0).split('/').includes('..')) || bins.includes(a0)
function normHttp(u, where, e, perms) {
  let x
  try { x = new URL(String(u)) } catch { return e.push(`${where}: bad url`), null }
  if (!/^https?:$/.test(x.protocol) || x.username || x.password) return e.push(`${where}: http(s) urls only, no user info`), null
  if (!LOOPBACK.has(x.hostname) && !perms.network.some(h => hostMatch(h, x))) e.push(`${where}: ${x.host} is not loopback: declare it in "permissions": { "network": ["${x.host}"] }`)
  return String(u).slice(0, 2000) // as written: URL#href would percent-encode {vars} in the path
}
function normTransport(s, where, e, w, perms, { builtin, defInterval, bins }) {
  if (!isObj(s)) return e.push(`${where} must be an object`), null
  const kinds = ['cmd', 'http', 'file', 'builtin'].filter(k => s[k] != null)
  if (kinds.length !== 1) return e.push(`${where}: exactly one of cmd, http, file${builtin ? ', builtin' : ''}`), null
  const kind = kinds[0]
  const interval = num(s.interval, defInterval[kind], 1, 3600)
  const out = { kind, interval, timeout: num(s.timeout, 10, 1, LIMITS.timeout), stale: num(s.stale, Math.max(LIMITS.stale, interval * 3), interval, 7 * 86400), parse: ['json', 'text'].includes(s.parse) ? s.parse : 'auto' }
  if (kind === 'cmd') out.cmd = normCmd(s.cmd, `${where}.cmd`, e, perms, w, bins)
  if (kind === 'http') out.http = normHttp(s.http, `${where}.http`, e, perms)
  if (kind === 'file') { if (!filePathLike(s.file)) e.push(`${where}.file: an absolute, ~/ or $dir/ path (or one starting with {settings.<name>})`); else out.file = s.file }
  if (kind === 'builtin') { if (!builtin) e.push(`${where}.builtin: only built-in plugins`); else out.builtin = str(s.builtin, 32) }
  for (const k of Object.keys(s)) if (!['cmd', 'http', 'file', 'builtin', 'interval', 'timeout', 'stale', 'parse'].includes(k)) w.push(`${where}.${k}: unknown field`)
  return out
}
function normAction(a, name, e, perms, builtin, w = [], bins = []) {
  const where = `actions.${name}`
  if (!isObj(a)) return e.push(`${where} must be an object`), null
  const base = { title: str(a.title, 60) || undefined, refresh: a.refresh !== false, params: list(a.params).filter(p => typeof p === 'string' && /^[a-z][a-zA-Z0-9_]{0,31}$/.test(p)).slice(0, 16) }
  if (a.detach != null && (a.cmd == null || typeof a.detach !== 'boolean')) e.push(`${where}.detach: true / false, on cmd actions only`)
  if (a.cmd != null) {
    const detach = a.detach === true
    return { ...base, kind: 'cmd', cmd: normCmd(a.cmd, `${where}.cmd`, e, perms, w, bins), timeout: num(a.timeout, detach ? LIMITS.actionTimeout : 15, 1, LIMITS.actionTimeout), toast: a.toast === true, ...(detach ? { detach } : {}) }
  }
  if (a.http != null) return { ...base, kind: 'http', http: normHttp(a.http, `${where}.http`, e, perms), method: /^(GET|POST|PUT|PATCH|DELETE)$/i.test(a.method || '') ? a.method.toUpperCase() : 'POST', body: a.body == null ? undefined : typeof a.body === 'string' ? a.body.slice(0, 8000) : JSON.stringify(a.body).slice(0, 8000), timeout: num(a.timeout, 10, 1, LIMITS.timeout) }
  if (a.builtin != null) {
    const ok = BUILTINS[builtin]
    if (!ok) return e.push(`${where}.builtin: only built-in plugins`), null
    if (!isObj(a.builtin) || !ok.includes(a.builtin.type)) return e.push(`${where}.builtin: must be a ${ok.join(' / ')} action`), null
    return { ...base, kind: 'builtin', action: structuredClone(a.builtin) }
  }
  if (a.type === 'app') {
    const t = str(a.target, 200)
    if (t !== 'bundle' && !BUNDLE_RE.test(t)) return e.push(`${where}.target: "bundle" (the detected app) or a bundle id`), null
    return { ...base, kind: 'app', target: t }
  }
  if (a.type === 'url' || a.url != null) {
    const u = str(a.url, 2000), sc = scheme(u)
    if (!SCHEME_RE.test(sc) || NEVER_SCHEMES.has(sc)) return e.push(`${where}.url: not an openable url`), null
    if (sc !== 'https' && !perms.schemes.includes(sc)) e.push(`${where}.url: ${sc}: links need "permissions": { "schemes": ["${sc}"] }`)
    return { ...base, kind: 'url', url: u }
  }
  return e.push(`${where}: one of cmd, http, url, { type: "app" }${BUILTINS[builtin] ? ', builtin' : ''}`), null
}
function normValue(v, name, e) {
  const o = typeof v === 'string' ? { path: v } : isObj(v) ? v : null
  if (!o) return e.push(`values.${name}: a path string or { path, default?, stale?, round?, map?, above?, below?, atLeast?, atMost?, equals?, then?, else? }`), null
  try { parsePath(String(o.path ?? '').replace(SETTING_REF_RE, 'x')) } catch (x) { return e.push(`values.${name}: ${x.message}`), null }
  const out = { path: String(o.path) }
  if (o.default != null) out.default = str(o.default, 80)
  if (o.stale != null) out.stale = str(o.stale, 80)
  if (o.round != null) out.round = num(o.round, 0, 0, 6)
  if (isObj(o.map)) out.map = Object.fromEntries(Object.entries(o.map).slice(0, 64).map(([k, x]) => [String(k).slice(0, 80), str(x, 80)]))
  const test = {}
  for (const k of Object.keys(TESTS)) {
    if (o[k] == null) continue
    if (typeof o[k] !== 'number' || !Number.isFinite(o[k])) e.push(`values.${name}.${k}: a number`)
    else test[k] = o[k]
  }
  if (o.equals != null) { if (['string', 'number', 'boolean'].includes(typeof o.equals)) test.equals = String(o.equals).slice(0, 80); else e.push(`values.${name}.equals: a string, number or boolean`) }
  if (Object.keys(test).length) { out.test = test; out.then = o.then != null ? str(o.then, 80) : 'on'; out.else = o.else != null ? str(o.else, 80) : '' }
  else if (o.then != null || o.else != null) e.push(`values.${name}: then / else need a test (above, below, atLeast, atMost or equals)`)
  return out
}
function normSettings(s, e) {
  const out = {}
  if (s == null) return out
  if (!isObj(s)) return e.push('settings must be an object'), out
  for (const [k, v] of Object.entries(s).slice(0, LIMITS.settings)) {
    if (!NAME_RE.test(k)) { e.push(`settings.${k}: names start with a-z, then a-z 0-9 _`); continue }
    if (!isObj(v)) { e.push(`settings.${k}: { type?, default?, title?, description? }`); continue }
    const type = v.type ?? 'string'
    if (!SETTING_TYPES.includes(type)) { e.push(`settings.${k}.type: one of ${SETTING_TYPES.join(', ')}`); continue }
    if (v.default != null && typeof v.default !== type) { e.push(`settings.${k}.default: must be a ${type}`); continue }
    const d = v.default ?? (type === 'string' ? '' : type === 'number' ? 0 : false)
    if (v.secret != null && (v.secret !== true || type !== 'string')) { e.push(`settings.${k}.secret: true, on string settings only`); continue }
    if (v.secret && v.default) { e.push(`settings.${k}: a secret setting has no default (the user enters it)`); continue }
    out[k] = { type, default: type === 'string' ? str(d, 500) : d, title: str(v.title, 60) || k, description: str(v.description, 200) || undefined, ...(v.secret ? { secret: true } : {}) }
  }
  return out
}
function normIcon(i, e) {
  if (i == null) return undefined
  if (typeof i === 'string') return /^[\w.-]{1,64}\.(png|svg)$/.test(i) ? { file: i } : (e.push('icon: a png/svg file name in the plugin folder, { glyph } or { logo }'), undefined)
  if (isObj(i) && /^[A-Za-z0-9-]{1,80}$/.test(String(i.glyph || ''))) return { glyph: i.glyph }
  if (isObj(i) && /^[a-z0-9-]{1,80}$/.test(String(i.logo || ''))) return { logo: i.logo }
  e.push('icon: a png/svg file name in the plugin folder, { glyph } or { logo }')
}
const TEMPLATE_KINDS = { keys: 'key', dials: 'dial', pages: 'page' }

// ---------- what a control can run (shared by template validation, the MCP guard and recipe apply) ----------
/** Action types that run code, synthesize input or reach the network (plus `open` of anything but an https url). */
export const EXEC_ACTION_TYPES = ['shell', 'applescript', 'keys', 'hold-keys', 'type', 'http', 'shortcut']
// actions a plugin template may put on a key: its own plugin actions, page navigation, nothing; multi of those
const TEMPLATE_ACTIONS = ['plugin', 'page', 'back', 'none', 'multi']
const httpsTarget = t => typeof t === 'string' && /^https:\/\/[^\s/]/i.test(t.trim())
/**
 * Every executable part of a control, page or template, wherever it sits (inside multi, dials, the strip, a page's keys):
 * a poll / browse command, an action of an EXEC_ACTION_TYPES type, an `open` whose target isn't an https url.
 * → [{ path, what, sig }] (sig: path + JSON of that part, so "added or changed" is a set difference).
 */
export function execParts(json) {
  const out = []
  const walk = (v, p) => {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${p}[${i}]`))
    if (!isObj(v)) return
    for (const k of ['poll', 'browse']) {
      const x = v[k]
      if (x != null && x !== false && (typeof x !== 'object' || x.cmd != null || x.fn != null)) out.push({ path: p ? `${p}.${k}` : k, what: `${k} command`, sig: `${p}.${k}=${JSON.stringify(x)}` })
    }
    if (typeof v.type === 'string') {
      const risky = EXEC_ACTION_TYPES.includes(v.type) ? `${v.type} action` : v.type === 'open' && !httpsTarget(v.target) ? 'open of a non-https target' : null
      if (risky) out.push({ path: p || '(root)', what: risky, sig: `${p}=${JSON.stringify(v)}` })
    }
    for (const [k, x] of Object.entries(v)) if (x && typeof x === 'object') walk(x, p ? `${p}.${k}` : k)
  }
  walk(json, '')
  return out
}
/** Executable parts of `after` that `before` doesn't have at the same place (added or altered). */
export function addedExecParts(before, after) {
  const had = new Set(execParts(before).map(x => x.sig))
  return execParts(after).filter(x => !had.has(x.sig))
}
/** Why a plugin template can't be offered as a recipe: executable parts, actions other than its own / page / back, other plugins' actions. */
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
      // `_press` / `_rotate`… are runtime-only fields the engine runs before onPress: never in a template
      if (k.startsWith('_')) bad.push(`${q}: internal field (fields starting with _ aren't allowed in a template)`)
      else if (/^on[A-Z]\w*$/.test(k)) action(x, q)
      else if (x && typeof x === 'object') walk(x, q)
    }
  }
  walk(tpl, '')
  return [...new Set(bad)]
}
function normTemplates(t, e, id) {
  const out = { keys: {}, dials: {}, pages: {} }
  if (t == null) return out
  if (!isObj(t)) return e.push('templates must be an object'), out
  if (JSON.stringify(t).length > LIMITS.templateBytes) return e.push(`templates over ${LIMITS.templateBytes >> 10} KB`), out
  for (const [kind, where] of Object.entries(TEMPLATE_KINDS)) {
    if (t[kind] == null) continue
    if (!isObj(t[kind])) { e.push(`templates.${kind} must be an object`); continue }
    for (const [name, raw] of Object.entries(t[kind]).slice(0, LIMITS.templates)) {
      if (!ACTION_RE.test(name) || !isObj(raw)) { e.push(`templates.${kind}.${name}: bad name or not an object`); continue }
      const wrapped = isObj(raw.template)
      const tpl = wrapped ? raw.template : raw
      if (where === 'page' && !Array.isArray(tpl.keys) && !tpl.source) { e.push(`templates.pages.${name}: a page needs keys (or a source)`); continue }
      const bad = templateProblems(tpl, id)
      if (bad.length) { e.push(...bad.slice(0, 4).map(x => `templates.${kind}.${name}.${x}`)); continue }
      out[kind][name] = { title: str(wrapped && raw.title, 60) || name, what: str(wrapped && raw.what, 300), template: structuredClone(tpl) }
    }
  }
  return out
}

/**
 * Validate and normalize a manifest. opts: { source: builtin|local|user|linked, dir }.
 * Returns { ok, manifest, errors, warnings }: errors make the plugin unusable (listed with its errors), warnings don't.
 */
export function validateManifest(raw, { source = 'user' } = {}) {
  const e = [], w = []
  let d = raw
  if (typeof raw === 'string') try { d = JSON.parse(raw) } catch (x) { return { ok: false, manifest: null, errors: [`not json: ${x.message}`], warnings: [] } }
  if (!isObj(d)) return { ok: false, manifest: null, errors: ['manifest must be a JSON object'], warnings: [] }
  if (d.deckstudio !== PLUGIN_SCHEMA) e.push(`"deckstudio" must be "${PLUGIN_SCHEMA}"`)
  const id = String(d.id ?? '')
  if (!PLUGIN_ID_RE.test(id) || RESERVED_IDS.has(id)) e.push('id: a-z 0-9 -, up to 32, starting with a letter or digit (not a reserved word)')
  const builtin = source === 'builtin' && typeof d.builtin === 'string' && BUILTINS[d.builtin] ? d.builtin : undefined
  if (d.builtin != null && !builtin) e.push(source === 'builtin' ? `builtin: one of ${Object.keys(BUILTINS).join(', ')}` : 'builtin: only plugins shipped with DeckStudio')
  const p = isObj(d.permissions) ? d.permissions : {}
  const perms = {
    shell: p.shell === true,
    schemes: [...new Set(list(p.schemes).map(s => String(s).toLowerCase().replace(/:$/, '')))].filter(s => SCHEME_RE.test(s) && !NEVER_SCHEMES.has(s) && s !== 'https').slice(0, 8),
    network: [...new Set(list(p.network).map(h => String(h).toLowerCase()))].filter(h => HOST_RE.test(h)).slice(0, 8),
  }
  if (d.permissions != null && !isObj(d.permissions)) e.push('permissions must be an object')
  const m = {
    deckstudio: PLUGIN_SCHEMA, id, source, builtin,
    name: str(d.name, 40) || id, version: str(d.version, 20) || '0.0.0', author: str(d.author, 80) || undefined,
    homepage: https(String(d.homepage || '')) ? String(d.homepage).slice(0, 300) : undefined, description: str(d.description, 300) || undefined,
    icon: normIcon(d.icon, e), permissions: perms,
  }
  if (d.homepage != null && !m.homepage) w.push('homepage: https urls only (ignored)')
  if (!str(d.version, 20)) w.push('version: missing')
  const det = isObj(d.detect) ? d.detect : {}
  m.detect = {
    bundle: list(det.bundle).map(String).filter(b => BUNDLE_RE.test(b)).slice(0, LIMITS.detect),
    bin: list(det.bin).filter(binLike).slice(0, LIMITS.detect),
    paths: list(det.paths).filter(pathLike).slice(0, LIMITS.detect),
  }
  if (list(det.bundle).length + list(det.bin).length + list(det.paths).length !== m.detect.bundle.length + m.detect.bin.length + m.detect.paths.length) w.push('detect: some entries were not bundle ids / paths / program names (ignored)')
  if (isObj(d.install)) m.install = { brew: /^[\w@./+ -]{1,100}$/.test(String(d.install.brew || '')) ? String(d.install.brew) : undefined, url: https(String(d.install.url || '')) ? String(d.install.url) : undefined, note: str(d.install.note, 200) || undefined }
  const defInterval = { cmd: 30, http: 10, file: 2, builtin: 1 }
  // detect.bin entries are what "$bin" can become: an interpreter there would be a shell in disguise
  for (const b of m.detect.bin) if (!perms.shell && INTERPRETERS.test(String(b).split('/').pop())) e.push(`detect.bin: ${String(b).split('/').pop()} is a shell or interpreter: declare "permissions": { "shell": true }`)
  const bins = m.detect.bin.filter(b => !INTERPRETERS.test(String(b).split('/').pop()))
  if (d.status != null) m.status = normTransport(d.status, 'status', e, w, perms, { builtin, defInterval, bins })
  if (d.bots != null) m.bots = normTransport(d.bots, 'bots', e, w, perms, { builtin, defInterval: { ...defInterval, cmd: 15, file: 3 }, bins })
  m.values = {}
  if (d.values != null && !isObj(d.values)) e.push('values must be an object')
  for (const [k, v] of Object.entries(isObj(d.values) ? d.values : {}).slice(0, LIMITS.values)) {
    if (!NAME_RE.test(k)) { e.push(`values.${k}: names start with a-z, then a-z 0-9 _`); continue }
    const x = normValue(v, k, e); if (x) m.values[k] = x
  }
  if (Object.keys(m.values).length && !m.status) e.push('values need a status source')
  m.actions = {}
  if (d.actions != null && !isObj(d.actions)) e.push('actions must be an object')
  for (const [k, a] of Object.entries(isObj(d.actions) ? d.actions : {}).slice(0, LIMITS.actions)) {
    if (!ACTION_RE.test(k)) { e.push(`actions.${k}: names are a-z 0-9 _ -`); continue }
    const x = normAction(a, k, e, perms, builtin, w, bins); if (x) m.actions[k] = x
  }
  m.templates = normTemplates(d.templates, e, id)
  m.settings = normSettings(d.settings, e)
  // {settings.x} / {self.settings.x} anywhere must name a declared setting
  const refs = new Set([...JSON.stringify([d.status, d.bots, d.values, d.actions, d.templates] ?? null).matchAll(SETTING_REF_RE)].map(x => x[1]))
  for (const k of refs) if (!Object.hasOwn(m.settings, k)) e.push(`{settings.${k}}: "${k}" isn't declared in settings`)
  // "$bin" is only replaced as a whole argv element, so only argv arrays can need it
  const usesBin = c => Array.isArray(c) && c.includes('$bin')
  if ((usesBin(m.status?.cmd) || usesBin(m.bots?.cmd) || Object.values(m.actions).some(a => usesBin(a.cmd))) && !m.detect.bin.length) e.push('"$bin" needs detect.bin (where to find the program)')
  if (Object.values(m.actions).some(a => a.target === 'bundle') && !m.detect.bundle.length) e.push('{ type: "app", target: "bundle" } needs detect.bundle')
  const known = ['deckstudio', 'id', 'name', 'version', 'author', 'homepage', 'description', 'icon', 'detect', 'install', 'status', 'values', 'actions', 'templates', 'settings', 'bots', 'permissions', 'builtin', '$schema']
  for (const k of Object.keys(d)) if (!known.includes(k)) w.push(`${k}: unknown field (ignored)`)
  return { ok: !e.length, manifest: m, errors: e, warnings: w }
}

// ---------- trust: what the user enabled / granted (profile.plugins), never the manifest ----------
/** profile.plugins sanitized: { id: { enabled?, grants: { shell?, schemes?, network? }, settings? } } (used by normalizeProfile). */
export function cleanPluginsConfig(v) {
  const out = {}
  if (!isObj(v)) return out
  for (const [id, c] of Object.entries(v)) {
    if (!PLUGIN_ID_RE.test(id) || !isObj(c)) continue
    const g = isObj(c.grants) ? c.grants : {}
    const strs = a => (Array.isArray(a) ? [...new Set(a.filter(x => typeof x === 'string').map(x => x.toLowerCase().slice(0, 260)))].slice(0, 16) : [])
    out[id] = { ...(typeof c.enabled === 'boolean' ? { enabled: c.enabled } : {}), ...(typeof c.approved === 'string' && /^[0-9a-f]{64}$/.test(c.approved) ? { approved: c.approved } : {}), grants: { shell: g.shell === true, schemes: strs(g.schemes), network: strs(g.network) } }
    const st = cleanSettings(c.settings)
    if (Object.keys(st).length) out[id].settings = st
  }
  return out
}
/** User setting values (profile.plugins[id].settings): name → string (≤ 500, no control characters) / finite number / boolean. */
export function cleanSettings(v) {
  if (!isObj(v)) return {}
  return Object.fromEntries(Object.entries(v).filter(([k, x]) => NAME_RE.test(k) && (typeof x === 'string' || typeof x === 'boolean' || (typeof x === 'number' && Number.isFinite(x))))
    .slice(0, LIMITS.settings).map(([k, x]) => [k, typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) : x]))
}
/** A plugin's settings: the user's value (profile.plugins[id].settings) coerced to the declared type, else the manifest default. */
export function pluginSettings(cfg, m) {
  const user = isObj(cfg) && isObj(cfg[m.id]) && isObj(cfg[m.id].settings) ? cfg[m.id].settings : {}
  const out = {}
  for (const [k, s] of Object.entries(m.settings || {})) {
    const u = Object.hasOwn(user, k) ? user[k] : undefined
    if (s.type === 'number') { const n = typeof u === 'number' ? u : typeof u === 'string' && u.trim() ? Number(u) : NaN; out[k] = Number.isFinite(n) ? n : s.default }
    else if (s.type === 'boolean') out[k] = typeof u === 'boolean' ? u : u === 'true' ? true : u === 'false' ? false : s.default
    else out[k] = u == null ? s.default : String(u).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500)
  }
  return out
}
/** Settings safe to show outside the plugin's own commands (vars, /api/plugins, MCP): every setting except `secret: true` ones. */
export function publicSettings(m, settings) {
  return Object.fromEntries(Object.entries(settings || {}).filter(([k]) => !m?.settings?.[k]?.secret))
}
/** { 'settings.x': text } for filling a plugin's own commands, urls, status file and value paths. */
export const settingsVars = settings => Object.fromEntries(Object.entries(settings || {}).map(([k, v]) => [`settings.${k}`, String(v)]))
/** A settings patch checked against the manifest: declared names only, each of its type. Returns the cleaned patch (null removes). */
export function checkSettings(m, req) {
  if (!isObj(req)) throw new Error('settings: an object { name: value }')
  const out = {}
  for (const [k, v] of Object.entries(req)) {
    const s = Object.hasOwn(m.settings || {}, k) ? m.settings[k] : null
    if (!s) throw new Error(`${m.id} has no setting "${k}"`)
    if (v === null) { out[k] = null; continue }
    if (s.type === 'number' ? !(typeof v === 'number' && Number.isFinite(v)) : typeof v !== s.type) throw new Error(`setting ${k}: a ${s.type}`)
    out[k] = typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 500) : v
  }
  return out
}
/**
 * Enabled + effective grants (declared ∩ granted). Built-in and local (this Mac's own) plugins start enabled; user / linked ones off.
 * `sha` (the manifest file's sha256, given by the server): an installed (user) plugin is enabled, with its grants, only for the
 * manifest the user approved (profile.plugins[id].approved, saved when they switch it on). An update with another manifest
 * reads as off with no grants and `updated: true` until the user reviews it and switches it on again.
 */
export function pluginTrust(cfg, m, sha) {
  const c = isObj(cfg) && isObj(cfg[m.id]) ? cfg[m.id] : {}
  if (sha && m.source === 'user' && c.enabled === true && c.approved !== sha) return { enabled: false, updated: true, grants: { shell: false, schemes: [], network: [] } }
  const g = isObj(c.grants) ? c.grants : {}
  const has = (a, x) => Array.isArray(a) && a.includes(x)
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : m.source === 'builtin' || m.source === 'local',
    grants: { shell: m.permissions.shell && g.shell === true, schemes: m.permissions.schemes.filter(s => has(g.schemes, s)), network: m.permissions.network.filter(h => has(g.network, h)) },
  }
}
/** What the plugin declared but the user hasn't granted yet (for the editor's "allow" prompt). */
export function missingGrants(m, t) {
  return { shell: m.permissions.shell && !t.grants.shell, schemes: m.permissions.schemes.filter(s => !t.grants.schemes.includes(s)), network: m.permissions.network.filter(h => !t.grants.network.includes(h)) }
}
/** A grant request ({ shell?, schemes?, network? }) checked against the manifest: you can only grant what it declares. */
export function checkGrant(m, req) {
  const r = isObj(req) ? req : {}
  const bad = []
  if (r.shell === true && !m.permissions.shell) bad.push('shell')
  for (const s of list(r.schemes)) if (!m.permissions.schemes.includes(String(s).toLowerCase())) bad.push(`scheme ${s}`)
  for (const h of list(r.network)) if (!m.permissions.network.includes(String(h).toLowerCase())) bad.push(`network ${h}`)
  if (bad.length) throw new Error(`${m.id} doesn't declare ${bad.join(', ')}`)
  return { shell: r.shell === true, schemes: list(r.schemes).map(s => String(s).toLowerCase()), network: list(r.network).map(h => String(h).toLowerCase()) }
}
export function hostMatch(h, url) { const x = url instanceof URL ? url : new URL(url); return h === x.host.toLowerCase() || (!h.includes(':') && h === x.hostname.toLowerCase()) }
/** May this http url be fetched? Loopback always; anything else only if declared and granted. */
export function httpAllowed(url, grants) {
  let x
  try { x = new URL(url) } catch { return 'bad url' }
  if (!/^https?:$/.test(x.protocol)) return 'http(s) only'
  if (LOOPBACK.has(x.hostname)) return null
  return (grants?.network || []).some(h => hostMatch(h, x)) ? null : `${x.host} isn't allowed (grant network access to this plugin)`
}
export function urlAllowed(url, grants) {
  const sc = scheme(url)
  if (sc === 'https') return null
  if (NEVER_SCHEMES.has(sc)) return `${sc}: never opens`
  return (grants?.schemes || []).includes(sc) ? null : `${sc}: links are off until you allow them for this plugin`
}
/** Why a command can't run with these grants (null: it can). */
export function cmdAllowed(cmd, grants, m) {
  if (typeof cmd === 'string') return grants?.shell ? null : 'shell commands are off until you allow shell for this plugin'
  if (grants?.shell) return null
  if (INTERPRETERS.test(String(cmd?.[0] || '').split('/').pop())) return `${String(cmd[0]).split('/').pop()} needs the shell permission`
  if (m && !ownProgram(cmd?.[0], (m.detect?.bin || []).filter(b => !INTERPRETERS.test(String(b).split('/').pop())))) return `${String(cmd?.[0]).slice(0, 60)} isn't this plugin's own program: it needs the shell permission`
  return null
}

// ---------- status → values → template vars ----------
/** Raw status output → a document: JSON when it parses (or parse: json), else the first line of text. */
export function parseStatus(text, parse = 'auto') {
  const s = String(text ?? '')
  if (parse !== 'text') { try { return JSON.parse(s) } catch (x) { if (parse === 'json') throw new Error(`status isn't json: ${x.message}`) } }
  return s.trim().split('\n')[0].slice(0, 200)
}
const fmt = v => (v == null ? undefined : typeof v === 'object' ? JSON.stringify(v).slice(0, 80) : String(v).slice(0, 80))
/** The heartbeat age (ms) a status document reports (updated_at / updatedAt / heartbeat: ISO or ms), or null. */
export function heartbeatAt(doc) {
  if (!isObj(doc)) return null
  const v = doc.updated_at ?? doc.updatedAt ?? doc.heartbeat
  const n = typeof v === 'number' ? v : typeof v === 'string' ? (/^\d+$/.test(v) ? Number(v) : Date.parse(v)) : NaN
  return Number.isFinite(n) && n > 0 ? (n < 1e11 ? n * 1000 : n) : null
}
const asNumber = x => (typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN)
/** Does a raw value pass a value's tests ({ above, below, atLeast, atMost, equals }, all must hold)? */
export function valueTest(x, test) {
  if (x == null) return false
  const n = asNumber(x)
  for (const [k, lim] of Object.entries(test)) {
    if (k === 'equals') { if (fmt(x) !== lim) return false }
    else if (!Number.isFinite(n) || !TESTS[k](n, lim)) return false
  }
  return true
}
/**
 * Values for one plugin from its status document. Without declared values a plugin still gets
 * {id.status}: the text, or the document's own `state` / `status` field. Stale: each value's `stale`, else its default, else ''.
 * A value with tests (above / below / atLeast / atMost / equals) shows `then` ("on") when they all hold, else `else` ("").
 * `settings` fills {settings.x} in value paths ($['{settings.target}'].status).
 */
export function extractValues(m, doc, { stale = false, settings } = {}) {
  const out = {}
  const decl = Object.keys(m.values || {}).length ? m.values : { status: { path: typeof doc === 'object' && doc ? (doc.state != null ? '$.state' : '$.status') : '$' } }
  const sv = settingsVars(settings ?? pluginSettings(null, m))
  for (const [k, v] of Object.entries(decl)) {
    if (stale) { out[k] = v.stale ?? v.default ?? ''; continue }
    let x
    if (doc !== undefined) { try { x = jsonPath(doc, v.path.includes('{settings.') ? fillArg(v.path, sv) : v.path) } catch { x = undefined } }
    let s
    if (v.test) s = x == null ? undefined : valueTest(x, v.test) ? v.then : v.else
    else { if (typeof x === 'number' && v.round != null) x = Number(x.toFixed(v.round)); s = fmt(x) }
    if (s != null && v.map && Object.hasOwn(v.map, s)) s = v.map[s]
    out[k] = s ?? v.default ?? ''
  }
  return out
}
/** { 'id.name': value, …, 'id._state': lifecycle, 'id.settings.x': setting } for templates ({codexbar.claude_5h}, {codexbar._state}). */
export function pluginVars(id, values, state, settings) {
  const out = { [`${id}._state`]: state }
  for (const [k, v] of Object.entries(values || {})) out[`${id}.${k}`] = v
  for (const [k, v] of Object.entries(settings || {})) out[`${id}.settings.${k}`] = String(v)
  return out
}
/**
 * argv / url templating: {value} {delta} {index} {page} {param} {id.value} {settings.x}. argv elements are never split or shell-parsed.
 * `esc` encodes each value (encodeURIComponent for urls, so "/" "?" "#" ":" can't change the url's shape). {name|path} keeps "/"
 * between segments (each segment still escaped) for a url path like github.com/{repo|path}; a value with an empty, "." or ".."
 * segment is refused (throws).
 */
export function fillArg(s, vars, esc = v => v) {
  return String(s).replace(VAR_RE, (m, k, filter) => {
    if (vars[k] == null) return m
    const v = String(vars[k])
    if (filter !== 'path') return esc(v)
    const segs = v.split('/')
    if (segs.some(x => x === '' || x === '.' || x === '..')) throw new Error(`{${k}|path}: "${v.slice(0, 60)}" isn't a relative path (empty, . or .. segment)`)
    return segs.map(esc).join('/')
  })
}

// ---------- templates → recipes ----------
/** A template made concrete for plugin `id`: {self.x} → {id.x}, plugin actions without `plugin` → this one, keys/dials tagged plugin: id. */
export function bindTemplate(tpl, id, { tag = false } = {}) {
  const walk = v => {
    if (typeof v === 'string') return v.replace(/\{self\./g, `{${id}.`)
    if (Array.isArray(v)) return v.map(walk)
    if (!isObj(v)) return v
    const o = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    if (o.type === 'plugin' && !o.plugin) o.plugin = id
    return o
  }
  const out = walk(tpl)
  if (tag && isObj(out) && !out.plugin) out.plugin = id
  return out
}
/** The recipes a plugin's templates become (ids "plugin-<id>-<name>"). */
export function pluginRecipes(m, { context = '' } = {}) {
  if (!m?.templates) return []
  const out = []
  for (const [kind, where] of Object.entries(TEMPLATE_KINDS)) {
    for (const [name, t] of Object.entries(m.templates[kind] || {})) {
      const template = bindTemplate(t.template, m.id, { tag: where !== 'page' })
      out.push({
        id: `plugin-${m.id}-${name}`, category: `plugin · ${m.name.toLowerCase()}`, where, title: t.title, plugin: m.id,
        what: t.what || `${m.name}: ${where} template "${name}".`, needs: [`the ${m.name} plugin (enabled)`], template,
        prompt: `Add the "${t.title}" ${where} from the ${m.name} DeckStudio plugin (recipe plugin-${m.id}-${name}; GET /api/plugins shows its values and actions). Template:\n${JSON.stringify(template)}${context ? `\n\n---\n${context}` : ''}`,
      })
    }
  }
  return out
}
/** Plugin ids a page (or any control JSON) refers to: {id.value} vars, { type: plugin, plugin: id }, plugin: id. */
export function referencedPlugins(json) {
  const s = typeof json === 'string' ? json : JSON.stringify(json ?? null)
  const ids = new Set()
  for (const m of s.matchAll(/\{([a-z0-9][a-z0-9-]*)\.(?:settings\.)?\w+(?:\|path)?\}/g)) if (m[1] !== 'settings') ids.add(m[1])
  for (const m of s.matchAll(/"plugin":"([a-z0-9][a-z0-9-]*)"/g)) ids.add(m[1])
  return ids
}
