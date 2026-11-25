#!/usr/bin/env node
// DeckStudio server: owns the Stream Deck+ over HID and serves the editor at http://127.0.0.1:7337
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { WebSocketServer } from 'ws'
import { Engine } from './src/engine.mjs'
import { ACTION_TYPES } from './src/actions.mjs'
import { reapOrphan } from './src/capture.mjs'
import { loginCodes } from './src/login.mjs'
import { loginRequestOk, assetRequestOk } from './src/same-origin.mjs'
import { createRequire } from 'node:module'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const HOME_DIR = process.env.DECKSTUDIO_HOME || path.join(process.env.HOME, '.deckstudio')
const PORT = Number(process.env.DECKSTUDIO_PORT || 7337)
fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 })
fs.chmodSync(HOME_DIR, 0o700)

// A secret guards every API call: shell actions live in the profile, so a random web page must not be able to
// rewrite it via CSRF / DNS rebinding. It is new on every start (written to ~/.deckstudio/token, 0600, once this
// server owns the port), so a token that leaked once stops working at the next restart. `deckctl open` hands the
// editor the current one; deckctl, the MCP server and the agent hook read the file on each call.
// Clients first check that whoever listens on the port is this server (GET /api/hello, src/hello.mjs): it answers
// with HMAC(token, client nonce), which only a process that can read the token file can compute. So a program that
// squats the port while DeckStudio is down never receives the token.
const TOKEN_FILE = path.join(HOME_DIR, 'token')
const TOKEN = crypto.randomBytes(24).toString('hex')
const TOKEN_BUF = Buffer.from(TOKEN)
const SERVER_ID = crypto.randomBytes(16).toString('hex')
function writeSecret(file, text) { // atomic, owner-only: a temp file then rename
  const tmp = `${file}.${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' })
  fs.renameSync(tmp, file)
  const st = fs.statSync(file)
  if (st.uid !== process.getuid() || (st.mode & 0o077)) { console.error(`refusing to run: ${file} must be owned by you with mode 600`); process.exit(1) }
}
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`])
const tokenOk = t => { if (typeof t !== 'string') return false; const b = Buffer.from(t); return b.length === TOKEN_BUF.length && crypto.timingSafeEqual(b, TOKEN_BUF) }

for (const f of fs.readdirSync(HOME_DIR)) try { const p = path.join(HOME_DIR, f); fs.chmodSync(p, fs.statSync(p).isDirectory() ? 0o700 : 0o600) } catch {}
// Never let one stray async error take the device down with the process.
process.on('unhandledRejection', e => console.error('unhandled:', e?.stack || e))
process.on('uncaughtException', e => console.error('uncaught:', e?.stack || e))

const engine = new Engine({ profilePath: path.join(HOME_DIR, 'profile.json') })
const logs = []
engine.on('log', l => { logs.push(l); if (logs.length > 200) logs.shift() })

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
async function readBody(req, limit = 8 << 20) {
  let size = 0; const chunks = []
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error('body too large'), { code: 413 }); chunks.push(c) }
  const s = Buffer.concat(chunks).toString('utf8')
  return s ? JSON.parse(s) : {}
}
const state = () => ({ profile: engine.profile, page: engine.page, status: engine.status, brightness: engine.brightness, actionTypes: ACTION_TYPES, overlay: engine.overlay, logs: logs.slice(-50) })

// Running apps' icons for the editor (64px PNG data URLs). Behind the token like /api/apps: the
// set of installed apps is personal, so there is no public /appicon route.
// An LRU of 300; a failure is retried after a minute; one lookup per id at a time; at most 4 helpers at once.
const APP_ICONS = new Map() // bundle id → { url, at } | { pending }
let iconSlots = 4
const iconWaiters = []
async function appIcon(id) {
  if (!/^[A-Za-z0-9.-]{3,200}$/.test(id)) return null
  const hit = APP_ICONS.get(id)
  if (hit && (hit.pending || hit.url || Date.now() - hit.at < 60e3)) { APP_ICONS.delete(id); APP_ICONS.set(id, hit); return hit.pending || hit.url }
  const pending = (async () => {
    if (iconSlots > 0) iconSlots--; else await new Promise(r => iconWaiters.push(r))
    const tmp = path.join(HOME_DIR, `appicon-${process.pid}-${crypto.randomBytes(4).toString('hex')}.png`)
    let url = null
    try { const { helper } = await import('./src/live.mjs'); await helper(['icon', id, tmp, '64']); url = 'data:image/png;base64,' + fs.readFileSync(tmp).toString('base64') } catch {}
    finally { fs.rm(tmp, { force: true }, () => {}); const next = iconWaiters.shift(); if (next) next(); else iconSlots++ }
    APP_ICONS.delete(id); APP_ICONS.set(id, { url, at: Date.now() })
    if (APP_ICONS.size > 300) APP_ICONS.delete(APP_ICONS.keys().next().value)
    return url
  })()
  APP_ICONS.set(id, { pending })
  return pending
}

// shared recipes, this Mac's own (src/local-profile.mjs, gitignored) and every plugin's templates
const allRecipes = async () => { const R = await import('./src/recipes.mjs'); return [...R.RECIPES, ...(await import('./src/local.mjs')).localRecipes(), ...engine.live.plugins.recipes(R.AGENT_CONTEXT)] }
// plugins (src/plugins.mjs, spec docs/PLUGINS.md): /api/plugins/<id>/<verb>
const pluginCfg = id => { const p = structuredClone(engine.profile); p.plugins ??= {}; p.plugins[id] ??= { grants: {} }; p.plugins[id].grants ??= {}; return p }
const rescanPlugins = () => { const h = engine.live.plugins; if (h.scan()) h.onChange(); for (const r of h.plugins.values()) if (r.inst) r.inst.at = 0; h.sync(); return h.summary() }
// what's installed under an id, for the marketplace's "installed / update available"
const installedPlugin = id => {
  const r = engine.live.plugins.plugins.get(id)
  if (!r) return null
  let sha = null
  try { sha = crypto.createHash('sha256').update(fs.readFileSync(r.file)).digest('hex') } catch {}
  return { source: r.source, version: r.m.version, sha, enabled: engine.live.plugins.trust(r).enabled }
}
// Attribution only: `origin` in a body and the x-deck-client header name who made a change (the editor ignores the echo
// of its own edits, the log says "mcp"). Any token holder can set them to anything, so nothing security-relevant may
// depend on them: every check that matters is the token, the Host / Origin checks, or a rule in the MCP process itself.
const PLUGIN_ROUTES = {
  'GET ': id => engine.live.plugins.one(id),
  // { enabled: true|false }: switch a plugin on / off (saved in profile.plugins). Switching on records the manifest's
  // sha256 as approved: an update with another manifest reads as off (no grants) until the user switches it on again.
  'POST enable': (id, b, req) => {
    const r = engine.live.plugins.get(id)
    const p = pluginCfg(id)
    p.plugins[id].enabled = b.enabled !== false
    if (b.enabled !== false && r.sha) p.plugins[id].approved = r.sha; else delete p.plugins[id].approved
    engine.setProfile(p, String(req.headers['x-deck-client'] || 'api').slice(0, 40))
    return engine.live.plugins.one(id)
  },
  // { shell?, schemes?, network? }: what the user allows, replacing the previous grants; only what the manifest declares
  'POST grant': async (id, b, req) => {
    const { checkGrant } = await import('./src/plugin-schema.mjs')
    const g = checkGrant(engine.live.plugins.get(id).m, b)
    const p = pluginCfg(id)
    p.plugins[id].grants = g
    engine.setProfile(p, String(req.headers['x-deck-client'] || 'api').slice(0, 40))
    return engine.live.plugins.one(id)
  },
  // { settings: { name: value | null } }: the user's plugin settings (profile.plugins[id].settings), merged; null → the default.
  // Only names the manifest declares, each of its type (string / number / boolean).
  'POST settings': async (id, b, req) => {
    const { checkSettings } = await import('./src/plugin-schema.mjs')
    const patch = checkSettings(engine.live.plugins.get(id).m, b.settings)
    const p = pluginCfg(id)
    const next = { ...(p.plugins[id].settings || {}) }
    for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v }
    if (Object.keys(next).length) p.plugins[id].settings = next; else delete p.plugins[id].settings
    engine.setProfile(p, String(req.headers['x-deck-client'] || 'api').slice(0, 40))
    engine.live.plugins.sync() // a new config path / target: re-read the status now
    return engine.live.plugins.one(id)
  },
  // { action, args?, value? }: run one of its actions now (logged like a press)
  'POST action': async (id, b) => {
    const r = await engine.act({ type: 'plugin', plugin: id, action: String(b.action || ''), args: b.args }, { value: b.value }, `api plugin ${id}`)
    if (r && !r.ok) throw Object.assign(new Error(r.error || 'failed'), { code: 400 })
    return { ok: true }
  },
  'POST refresh': async id => { await engine.live.plugins.refresh(id); return engine.live.plugins.one(id) },
}
const routes = {
  'GET /api/state': () => state(),
  // a one-time editor login code (deckctl open → /#c=<code> → POST /api/login): see login() below
  'POST /api/login-code': () => ({ code: LOGIN.issue(), ttl: LOGIN.ttl / 1000 }),
  // Agent alerting (src/agents.mjs, schema src/agent-schema.mjs): every enabled provider merged by attention
  'GET /api/agents': () => engine.live.agentsSummary(),
  // an agents/v1 document → ~/.deckstudio/agents/<provider>.json ("merge": true upserts the listed sessions)
  'POST /api/agents': b => engine.live.agents.push(b),
  // one session: { provider, id, state: idle|working|done|needs|error|gone, needs?, message?, name?, title?, app?, progress?, open? }
  'POST /api/agents/status': b => engine.live.agents.status(b),
  // a hook payload, mapped server-side: { source: "claude-code"|"codex", payload, env?: { __CFBundleIdentifier?, TERM_PROGRAM? } }
  'POST /api/agents/hook': async b => {
    const { hookStatus } = await import('./src/agent-schema.mjs')
    const env = b.env && typeof b.env === 'object' ? { __CFBundleIdentifier: String(b.env.__CFBundleIdentifier || ''), TERM_PROGRAM: String(b.env.TERM_PROGRAM || '') } : {}
    const st = hookStatus(String(b.source || 'claude-code'), b.payload, env)
    return st ? engine.live.agents.status(st) : { ok: true, ignored: true }
  },
  // mark a session seen (what a long press does): { key: "provider:id" }
  'POST /api/agents/seen': b => { const k = String(b.key || ''); if (!engine.live.agents.get(k)) throw Object.assign(new Error('no such session'), { code: 404 }); engine.live.agents.markSeen(k); return { ok: true } },
  // what a press does: Rex jumps to the block; other providers' sessions open their (trusted) target
  'POST /api/agents/open': async b => ({ ok: true, steps: await engine.live.goAgent(String(b.key || '')) ?? null }),
  // { provider, id? }: drop one session, or move the provider's file to agents/.removed
  'POST /api/agents/remove': b => engine.live.agents.remove(String(b.provider || ''), b.id != null ? String(b.id) : undefined),
  'GET /api/apps': async (b, req) => {
    // running apps (for "show this page when … is in front"), plus the current frontmost one
    const { helper } = await import('./src/live.mjs')
    const running = await helper(['apps']).then(JSON.parse).catch(() => [])
    // ?icons=1 (Icon Studio's apps tab): each app's real icon as a small PNG data URL, cached per bundle id
    if (new URL(req.url, 'http://x').searchParams.get('icons') === '1')
      await Promise.all(running.map(async a => { if (a?.bundleId) a.icon = await appIcon(a.bundleId) }))
    return { front: engine.live.front, running }
  },
  'GET /api/audio': () => engine.live.audio,
  'GET /api/recipes': async () => ({ recipes: await allRecipes() }),
  'GET /api/plugins': () => engine.live.plugins.summary(),
  // re-read the plugin folders now (deckctl plugin install / link), then detect again
  'POST /api/plugins/rescan': () => rescanPlugins(),
  // check a manifest without installing it: { manifest } (object or JSON text)
  'POST /api/plugins/validate': async b => { const { validateManifest } = await import('./src/plugin-schema.mjs'); const r = validateManifest(b.manifest, { source: 'user' }); return { ok: r.ok, errors: r.errors, warnings: r.warnings, manifest: r.manifest } },
  // marketplace (src/plugin-install.mjs): the registry (DECKSTUDIO_REGISTRY, default the repo's registry/ folder), each entry sha256-verified
  'GET /api/plugins/registry': async () => (await import('./src/plugin-install.mjs')).listRegistry({ installed: installedPlugin }),
  // { id } from the registry, or { path } to a local folder: copied into ~/.deckstudio/plugins/<id>, switched off until the user enables it
  'POST /api/plugins/install': async (b, req) => {
    const I = await import('./src/plugin-install.mjs')
    const userDir = engine.live.plugins.dirs.user
    const out = b.path ? I.installFromDir(String(b.path), { userDir, expectId: b.id || undefined }) : await I.installFromRegistry(String(b.id || ''), { userDir })
    if (engine.profile.plugins?.[out.id]?.enabled) { const p = pluginCfg(out.id); p.plugins[out.id].enabled = false; engine.setProfile(p, String(req.headers['x-deck-client'] || 'api').slice(0, 40)) }
    rescanPlugins()
    return { ...out, plugin: engine.live.plugins.plugins.has(out.id) ? engine.live.plugins.one(out.id) : null }
  },
  // { id }: user-installed plugins only (not built-in, local or linked); moved to ~/.deckstudio/plugins/.removed/
  'POST /api/plugins/uninstall': async b => {
    const r = engine.live.plugins.plugins.get(String(b.id || ''))
    if (r && r.source !== 'user') throw Object.assign(new Error(`${r.id} is a ${r.source} plugin: only installed (user) plugins can be uninstalled`), { code: 400 })
    const out = (await import('./src/plugin-install.mjs')).uninstall(String(b.id || ''), { userDir: engine.live.plugins.dirs.user })
    rescanPlugins()
    return out
  },
  // Apply a recipe: to a key / dial on a page, or as a new page. vars fill its {{placeholders}}.
  'POST /api/recipes/apply': async (b, req) => {
    const { fillTemplate } = await import('./src/recipes.mjs')
    const r = (await allRecipes()).find(x => x.id === b.id)
    if (!r) throw Object.assign(new Error('no such recipe'), { code: 400 })
    if (!r.template) throw Object.assign(new Error('this recipe is a prompt only — copy it to your agent'), { code: 400 })
    if (r.plugin) { // a plugin's template: only while that plugin is switched on (its templates hold only its own actions: plugin-schema templateProblems)
      const pr = engine.live.plugins.plugins.get(r.plugin)
      if (!pr || pr.errors.length || !engine.live.plugins.trust(pr).enabled) throw Object.assign(new Error(`the ${pr?.m.name || r.plugin} plugin is off: switch it on in the plugins tab before adding its keys`), { code: 400 })
      const { execParts } = await import('./src/plugin-schema.mjs')
      if (execParts(r.template).length) throw Object.assign(new Error('this plugin template runs commands: refused'), { code: 400 })
    }
    const vars = Object.fromEntries(Object.entries(b.vars || {}).map(([k, v]) => [k, String(v).slice(0, 300)]))
    const p = structuredClone(engine.profile)
    if (r.where === 'page') {
      const tpl = typeof r.template === 'string'
        ? structuredClone((await import('./src/local.mjs')).withLocal((await import('./src/default-profile.mjs')).defaultProfile()).pages[r.template])
        : fillTemplate(r.template, vars)
      let id = String(b.pageId || tpl.name || r.id).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'page'
      const base = id; let n = 2
      while (Object.hasOwn(p.pages, id)) id = `${base}-${n++}`
      p.pages[id] = tpl
      engine.setProfile(p, String(b.origin || req.headers['x-deck-client'] || 'api').slice(0, 40))
      return { page: id }
    }
    const page = b.page || engine.page
    if (!Object.hasOwn(p.pages, page)) throw Object.assign(new Error(`no page ${page}`), { code: 400 })
    const i = Number(b.index)
    const max = r.where === 'key' ? 8 : 4
    if (!Number.isInteger(i) || i < 0 || i >= max) throw Object.assign(new Error(`index must be 0–${max - 1}`), { code: 400 })
    const list = r.where === 'key' ? p.pages[page].keys : p.pages[page].dials
    const filled = fillTemplate(r.template, vars)
    // app keys get the app's genuine icon when it's installed
    const target = filled?.onPress?.type === 'app' && !filled.logo ? String(filled.onPress.target || '').split(',')[0].trim() : ''
    if (target && /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(target)) {
      try {
        const { helper } = await import('./src/live.mjs')
        const name = 'app-' + target.toLowerCase().replace(/[^a-z0-9]+/g, '-')
        await helper(['icon', target, userLogo(name + '.png'), '256'])
        filled.logo = name
      } catch {} // not installed: the key keeps its glyph and shows "not installed"
    }
    list[i] = filled
    engine.setProfile(p, String(b.origin || req.headers['x-deck-client'] || 'api').slice(0, 40))
    return { page, index: i }
  },
  // Bring your own bots: every provider (Grok Bot live, ~/.deckstudio/bots/*.json, commands). Schema: src/bot-schema.mjs
  'GET /api/bots': (b, req) => {
    if (engine.live.grok.refresh()) engine.scheduleRender()
    const provider = new URL(req.url, 'http://x').searchParams.get('provider') || undefined
    const logos = logoNames()
    return engine.live.bots.summary({ provider, logoUrl: n => `/logos/${logos.find(f => f.startsWith(n + '.')) || n + '.png'}` })
  },
  // any app / agent: push its bots (a provider doc, or { text } with the JSON); merge: true keeps bots not listed
  'POST /api/bots': b => engine.live.bots.push(b),
  'POST /api/bots/import': b => engine.live.bots.push({ text: String(b.text ?? '') }),
  'POST /api/bots/status': b => engine.live.bots.status(b),
  'POST /api/bots/remove': b => engine.live.bots.remove(String(b.provider || '')),
  // older name: Grok Bot only, same bot shape plus the generic fields
  'GET /api/grokbots': () => { if (engine.live.grok.refresh()) engine.scheduleRender(); const s = engine.live.bots.summary({ provider: 'grokbot' }); return { available: engine.live.grok.available, bots: s.bots } },
  'GET /api/logos': () => ({ logos: logoNames().map(f => ({ name: f.replace(/\.(png|svg)$/, ''), file: f })) }),
  // Pull an installed app's real icon into ~/.deckstudio/logos (never the repo), named app-<bundle id>
  'POST /api/logos/from-app': async b => {
    const id = String(b.bundleId || '')
    if (!/^[A-Za-z0-9.-]{3,200}$/.test(id)) throw Object.assign(new Error('bad bundle id'), { code: 400 })
    const name = 'app-' + id.toLowerCase().replace(/[^a-z0-9]+/g, '-')
    const { helper } = await import('./src/live.mjs')
    await helper(['icon', id, userLogo(name + '.png'), '256'])
    engine.scheduleRender() // the logo cache is keyed by mtime: redraw keys using the new icon
    return { name }
  },
  // Save Icon Studio art (a PNG data URL) into ~/.deckstudio/logos as custom-<name>.png
  'POST /api/logos/save': b => {
    const raw = String(b.name || '')
    if (!/^[a-z0-9-]{1,48}$/.test(raw)) throw Object.assign(new Error('name must be 1–48 of a-z, 0-9, -'), { code: 400 })
    const name = raw.startsWith('custom-') ? raw : 'custom-' + raw
    const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(String(b.dataUrl || ''))
    if (!m) throw Object.assign(new Error('dataUrl must be data:image/png;base64'), { code: 400 })
    if (m[1].length > Math.ceil((2 << 20) / 3) * 4) throw Object.assign(new Error('image over 2 MB'), { code: 400 })
    const buf = Buffer.from(m[1], 'base64')
    const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    if (buf.length > 2 << 20 || buf.length < 8 || !buf.subarray(0, 8).equals(PNG)) throw Object.assign(new Error('not a png (or over 2 MB)'), { code: 400 })
    if (logoNames().includes(name + '.svg')) throw Object.assign(new Error(`an svg logo named ${name} already exists`), { code: 400 })
    fs.writeFileSync(userLogo(name + '.png'), buf, { mode: 0o600 })
    engine.scheduleRender()
    return { name }
  },
  'GET /api/glyphs': (b, req) => {
    const q = new URL(req.url, 'http://x').searchParams.get('q')?.toLowerCase().trim() || ''
    const words = q.split(/[\s-]+/).filter(Boolean)
    const lo = n => n.toLowerCase() // names keep their case (4K, AI); search ignores it
    const hits = GLYPHS.filter(n => words.every(w => lo(n).includes(w)))
    hits.sort((a, b) => (CUSTOM.includes(b) - CUSTOM.includes(a)) || (lo(a).startsWith(q) ? 0 : 1) - (lo(b).startsWith(q) ? 0 : 1) || a.length - b.length)
    return { total: hits.length, names: hits.slice(0, 60) }
  },
  'PUT /api/profile': async (b, req) => { engine.setProfile(b, String(req.headers['x-deck-client'] || '').slice(0, 40)); return { ok: true } },
  // run one action immediately (editor "Test" button); same auth as editing the profile
  'POST /api/run': async b => { await engine.act(b.action, { index: b.index, value: b.value }); return { ok: true } },
  'POST /api/goto': async b => { engine.goto(b.page); return { page: engine.page } },
  'POST /api/control': async b => { engine.setControl(b); return { ok: true } },
  'POST /api/overlay/clear': async b => { engine.clearOverlay(b.page); return { ok: true } },
  'POST /api/toast': async b => { engine.toast(b.text, Math.min(Number(b.ms) || 1500, 30000)); return { ok: true } },
  'POST /api/brightness': async b => ({ brightness: await engine.setBrightness(b.value) }),
  'POST /api/takeover': async () => ({ status: await engine.takeover() }),
  'POST /api/release': async b => ({ status: await engine.release({ launchElgato: b.launchElgato !== false }) }),
  'POST /api/connect': async () => { engine.released = false; await engine.tryConnect(); return { status: engine.status } },
  // Simulated input from the web UI – goes through exactly the same handlers as hardware input.
  'POST /api/sim': async (b, req) => {
    const i = Number(b.index), cid = String(req.headers['x-deck-client'] || '').slice(0, 40)
    switch (b.event) {
      case 'keyDown': engine.keyDown(i); if (cid) (simDown.get(cid) ?? simDown.set(cid, new Set()).get(cid)).add(i); break
      case 'keyUp': engine.keyUp(i); simDown.get(cid)?.delete(i); break
      case 'rotate': await engine.dialRotate(i, Math.max(-10, Math.min(10, Number(b.delta) || 0))); break
      case 'dialDown': engine.dialDown(i); break
      case 'dialUp': engine.dialUp(i); break
      case 'tap': engine.stripTap(b.x, b.y, !!b.long); break
      case 'swipe': engine.stripSwipe({ x: Number(b.fromX), y: 50 }, { x: Number(b.toX), y: 50 }); break
      default: throw Object.assign(new Error('unknown sim event'), { code: 400 })
    }
    return { ok: true }
  },
}

// Carbon glyphs (public icon set, no user data) for the editor's picker: /glyphs/<name>.svg
const CARBON = path.join(path.dirname(createRequire(import.meta.url).resolve('@carbon/icons/package.json')), 'svg/32')
const CUSTOM_GLYPHS = path.join(ROOT, 'assets/glyphs')
const svgNames = d => { try { return fs.readdirSync(d).filter(f => f.endsWith('.svg')).map(f => f.slice(0, -4)) } catch { return [] } }
const CUSTOM = svgNames(CUSTOM_GLYPHS).sort()
const GLYPHS = [...CUSTOM, ...svgNames(CARBON).filter(n => !CUSTOM.includes(n)).sort()]
const GLYPH_SET = new Set(GLYPHS)
// Genuine logos / app icons (full color): shipped ones in assets/logos; ones made on this Mac (app icons pulled at
// runtime, Icon Studio saves) in ~/.deckstudio/logos, outside the repo, winning on a name clash (src/render-spec.mjs)
const LOGO_DIR = path.join(ROOT, 'assets/logos')
const USER_LOGO_DIR = path.join(HOME_DIR, 'logos')
const LOGO_RE = /^[a-z0-9-]+\.(png|svg)$/
const listLogos = d => { try { return fs.readdirSync(d).filter(f => LOGO_RE.test(f)) } catch { return [] } }
const logoNames = () => [...new Set([...listLogos(USER_LOGO_DIR), ...listLogos(LOGO_DIR)])].sort()
const logoPath = f => { const u = path.join(USER_LOGO_DIR, f); return fs.existsSync(u) ? u : path.join(LOGO_DIR, f) }
/** a path in ~/.deckstudio/logos for a new icon (the folder is created 0700) */
const userLogo = f => { fs.mkdirSync(USER_LOGO_DIR, { recursive: true, mode: 0o700 }); return path.join(USER_LOGO_DIR, f) }

// The editor (editor/ → `npm run build` → web/dist) is static and token-free: `deckctl open` gives it a
// one-time login code in the URL fragment, which it trades for the token (POST /api/login). Only files
// inside web/dist are ever served.
const DIST = path.join(ROOT, 'web/dist')
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.ico': 'image/x-icon' }
const CSP = `default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; ` +
  `connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
// App icons, plugin icons and bot avatars reveal which apps / plugins are installed: neither other sites
// (<img src="http://127.0.0.1:7337/…">) nor other local users' processes may probe them. Only the editor's own
// loads (Sec-Fetch-Site: same-origin) or a token holder get them (src/same-origin.mjs).
function serveStatic(pathname, res, req) {
  if (/^\/(logos|plugin-icon|botavatar)\//.test(pathname) && !assetRequestOk(req, tokenOk)) { res.writeHead(403, { 'cache-control': 'no-store' }); return res.end() }
  const am = /^\/botavatar\/([a-z]+)-([a-z]+)\.png$/.exec(pathname) // public: shape + color only, no user data (any provider's shape avatars)
  if (am) {
    import('./src/render-spec.mjs').then(m => m.spriteThumb(`grokbot/bot-${am[1]}-face`, am[2])).then(png => {
      if (!png) { res.writeHead(404); return res.end() }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }); res.end(png)
    }).catch(() => { res.writeHead(500); res.end() })
    return
  }
  const pi = /^\/plugin-icon\/([a-z0-9][a-z0-9-]{0,31})\.(png|svg)$/.exec(pathname) // a plugin's own icon file (public, like /logos)
  if (pi) {
    const f = engine.live.plugins.iconFile(pi[1])
    if (!f || !f.endsWith('.' + pi[2])) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': pi[2] === 'png' ? 'image/png' : 'image/svg+xml', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff', ...(pi[2] === 'svg' ? { 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'" } : {}) })
    return res.end(fs.readFileSync(f))
  }
  const lm = /^\/logos\/([a-z0-9-]+\.(png|svg))$/.exec(pathname)
  if (lm) {
    if (!logoNames().includes(lm[1])) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': lm[2] === 'png' ? 'image/png' : 'image/svg+xml', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' })
    return res.end(fs.readFileSync(logoPath(lm[1])))
  }
  const gm = /^\/glyphs\/([A-Za-z0-9-]+)\.svg$/.exec(pathname) // Carbon has upper-case names too (4K, AI, CSV…)
  if (gm) {
    if (!GLYPH_SET.has(gm[1])) { res.writeHead(404); return res.end() }
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' })
    return res.end(fs.readFileSync(path.join(CUSTOM.includes(gm[1]) ? CUSTOM_GLYPHS : CARBON, gm[1] + '.svg')))
  }
  let rel
  try { rel = decodeURIComponent(pathname) } catch { res.writeHead(400); return res.end() }
  if (rel === '/' || !path.extname(rel)) rel = '/index.html'
  const file = path.resolve(DIST, '.' + rel)
  if (!file.startsWith(DIST + path.sep)) { res.writeHead(403); return res.end() }
  fs.readFile(file, (err, buf) => {
    if (err) {
      if (rel === '/index.html') { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('Editor not built yet: cd editor && npm install && npm run build') }
      res.writeHead(404); return res.end('not found')
    }
    const ext = path.extname(file)
    res.writeHead(200, {
      'content-type': TYPES[ext] || 'application/octet-stream',
      'cache-control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
      'x-content-type-options': 'nosniff',
      ...(ext === '.html' ? { 'x-frame-options': 'DENY', 'content-security-policy': CSP } : {}),
    })
    res.end(buf)
  })
}

// Editor login without the token in a URL (src/login.mjs): `deckctl open` gets a one-time code (token-authenticated
// POST /api/login-code), opens /#c=<code>, and the editor trades it for the token here. One of two unauthenticated
// API routes (with GET /api/hello): single-use 60 s codes, rate-limited, and only from the editor's own page (Origin
// required and ours: a page elsewhere can't, and a local curl must forge it; src/same-origin.mjs).
const LOGIN = loginCodes()
async function login(req, res) {
  if (!loginRequestOk(req, ALLOWED_HOSTS)) return json(res, 403, { error: 'login only from the editor page (same origin): open the link deckctl open gives in your browser' })
  let b; try { b = await readBody(req, 1024) } catch { b = {} }
  const r = LOGIN.redeem(b?.code)
  if (r === 'limited') return json(res, 429, { error: 'too many attempts: wait a minute, then run deckctl open again' })
  if (r !== 'ok') return json(res, 401, { error: 'login code unknown, used or expired: run deckctl open again' })
  return json(res, 200, { token: TOKEN })
}

const server = http.createServer((req, res) => handle(req, res).catch(e => { try { json(res, 500, { error: e.message }) } catch {} }))
async function handle(req, res) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) { res.writeHead(421); return res.end('bad host') }
  const url = new URL(req.url, `http://${req.headers.host}`)
  if (req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(url.pathname, res, req)
  if (req.method === 'POST' && url.pathname === '/api/login') return login(req, res)
  let handler = routes[`${req.method} ${url.pathname}`]
  const pm = !handler && /^\/api\/plugins\/([a-z0-9][a-z0-9-]{0,31})(?:\/([a-z]+))?$/.exec(url.pathname)
  if (pm && PLUGIN_ROUTES[`${req.method} ${pm[2] || ''}`]) handler = (b, rq) => PLUGIN_ROUTES[`${req.method} ${pm[2] || ''}`](pm[1], b, rq)
  // unauthenticated: proves this server knows the token (HMAC of the client's nonce) before a client sends it
  if (req.method === 'GET' && url.pathname === '/api/hello') {
    const nonce = url.searchParams.get('nonce') || ''
    if (!/^[0-9a-f]{32,128}$/.test(nonce)) return json(res, 400, { error: 'nonce: 32–128 hex characters' })
    const { helloProof, HELLO } = await import('./src/hello.mjs')
    return json(res, 200, { deckstudio: HELLO, id: SERVER_ID, proof: helloProof(TOKEN, nonce, SERVER_ID) })
  }
  if (!handler) { res.writeHead(404); return res.end('not found') }
  if (!tokenOk(req.headers['x-deck-token'])) return json(res, 401, { error: 'missing or bad x-deck-token' })
  try { json(res, 200, await handler(req.method === 'GET' ? {} : await readBody(req), req)) }
  catch (e) { json(res, e.code === 413 ? 413 : e.code === 404 ? 404 : 400, { error: e.message }) }
}

const simDown = new Map() // editor client id → keys it holds down via /api/sim; released when its WebSocket closes
// The editor sends the token as a WebSocket subprotocol ("deck.v1", "deck.token.<token>"), not in the URL
// query, so it isn't in the request line; the server answers with "deck.v1" only.
const WS_PROTO = 'deck.v1', WS_TOKEN = 'deck.token.'
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 << 16, handleProtocols: ps => (ps.has(WS_PROTO) ? WS_PROTO : false) })
const wsToken = req => String(req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim()).find(s => s.startsWith(WS_TOKEN))?.slice(WS_TOKEN.length)
server.on('upgrade', (req, socket, head) => { try { upgrade(req, socket, head) } catch { socket.destroy() } })
function upgrade(req, socket, head) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const origin = req.headers.origin
  const originOk = !origin || ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''))
  if (url.pathname !== '/ws' || !ALLOWED_HOSTS.has(req.headers.host) || !originOk || !tokenOk(wsToken(req))) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy()
  }
  wss.handleUpgrade(req, socket, head, ws => {
    ws.on('error', () => ws.terminate())
    const cid = String(url.searchParams.get('client') || '').slice(0, 40)
    ws.on('close', () => {
      for (const i of simDown.get(cid) || []) if (engine.held?.has(i)) engine.keyUp(i) // never leave a push-to-talk stuck down
      simDown.delete(cid)
    })
    ws.send(JSON.stringify({ type: 'hello', ...state(), frame: engine.fullFrame() }))
  })
}
const broadcast = msg => { const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1) c.send(s) }
engine.on('frame', f => broadcast({ type: 'frame', ...f }))
engine.on('status', s => broadcast({ type: 'status', status: s }))
engine.on('page', p => broadcast({ type: 'page', page: p }))
engine.on('profile', (p, origin) => broadcast({ type: 'profile', profile: p, origin }))
engine.on('brightness', b => broadcast({ type: 'brightness', brightness: b }))
engine.on('log', l => broadcast({ type: 'log', log: l }))
engine.on('input', e => broadcast({ type: 'input', input: e }))
engine.on('frontApp', a => broadcast({ type: 'frontApp', app: a }))

server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `port ${PORT} in use — is DeckStudio already running?` : e.message); process.exit(1) })
server.listen(PORT, '127.0.0.1', async () => {
  // only now that this process owns the port: a second server that fails with EADDRINUSE never rotates the token
  writeSecret(TOKEN_FILE, TOKEN)
  writeSecret(path.join(HOME_DIR, 'server.json'), JSON.stringify({ id: SERVER_ID, pid: process.pid, port: PORT, startedAt: new Date().toISOString() }))
  console.log(`DeckStudio → http://127.0.0.1:${PORT}   (open the editor with: deckctl open)   profile: ${engine.profilePath}`)
  await engine.start()
  if (process.argv.includes('--takeover')) engine.takeover()
  reapOrphan(engine).catch(() => {}) // a recording a crashed DeckStudio left running: only now that this server owns the port
})

let shuttingDown = false
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  if (shuttingDown) process.exit(1)
  shuttingDown = true
  console.log('\nreleasing device…')
  await engine.stop()
  process.exit(0)
})
