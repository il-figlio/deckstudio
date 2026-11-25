// DeckStudio MCP server (stdio). A separate process that talks to the running DeckStudio HTTP API
// (http://127.0.0.1:7337, token from ~/.deckstudio/token) so agents can use MCP tools instead of curl.
// Spec / setup: docs/MCP.md. stdout carries JSON-RPC frames only; every log line goes to stderr.
//
// Trust: an agent may read state, flash temporary status, edit keys/dials, apply recipes, run actions of
// plugins the user already enabled and push status for its own bots / agent provider. It may NOT switch plugins
// on, grant shell / url schemes / network, install plugins or switch bot providers on: those stay human
// decisions in the editor. The token never appears in tool output or descriptions.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { verifyServer } from './hello.mjs'
import { addedExecParts, execParts } from './plugin-schema.mjs'

// Nothing but JSON-RPC may reach stdout: route stray console output to stderr.
console.log = console.info = console.debug = (...a) => console.error(...a)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const HOME_DIR = process.env.DECKSTUDIO_HOME || path.join(process.env.HOME || '', '.deckstudio')
const VERSION = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version } catch { return '0.0.0' } })()
const EDITOR = 'http://127.0.0.1:7337'

// DECKSTUDIO_URL (or DECKSTUDIO_PORT) picks the server. Loopback only: the token must never leave this Mac.
function baseUrl() {
  const raw = process.env.DECKSTUDIO_URL || `http://127.0.0.1:${Number(process.env.DECKSTUDIO_PORT || 7337)}`
  let u
  try { u = new URL(raw) } catch { return { error: `DECKSTUDIO_URL is not a URL: ${raw}` } }
  if (u.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname)) return { error: `DECKSTUDIO_URL must be http://127.0.0.1:<port> or http://localhost:<port> (the token is only ever sent to loopback); got ${u.origin}` }
  return { url: u.origin }
}
const BASE = baseUrl()
const EDITOR_URL = BASE.url ? BASE.url.replace('localhost', '127.0.0.1') : EDITOR
const PLUGINS_LINK = `${EDITOR_URL}/#plugins`

class ToolError extends Error {}
const fail = msg => { throw new ToolError(msg) }
const notRunning = () => `DeckStudio is not running at ${BASE.url}. Ask the user to start it (or run): ~/deckstudio/bin/deckctl start`

let tokenCache = null
function token() {
  try { tokenCache = fs.readFileSync(path.join(HOME_DIR, 'token'), 'utf8').trim() } catch { fail(`No DeckStudio token found in ${HOME_DIR}. Start DeckStudio once with: ~/deckstudio/bin/deckctl start`) }
  return tokenCache
}
// belt and braces: never let the token slip into anything we return
const scrub = s => (tokenCache && tokenCache.length >= 8 ? String(s).split(tokenCache).join('[token]') : String(s))

async function api(method, route, body, { allow404 = false } = {}) {
  if (BASE.error) fail(BASE.error)
  const t = token()
  // never hand the token to whatever squats the port: the server must first prove it knows it (src/hello.mjs)
  const v = await verifyServer(BASE.url, t, { home: HOME_DIR })
  if (!v.ok) fail(v.down ? notRunning() : v.why)
  let r
  try {
    r = await fetch(BASE.url + route, {
      method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'x-deck-token': t, 'x-deck-client': 'mcp', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (e) {
    if (e?.name === 'TimeoutError') fail(`DeckStudio at ${BASE.url} did not answer within 15 s (${method} ${route})`)
    fail(notRunning())
  }
  const text = await r.text()
  let j; try { j = text ? JSON.parse(text) : {} } catch { j = { error: text.slice(0, 200) } }
  if (r.status === 401) fail('DeckStudio rejected the token. The token file does not match the running server; ask the user to restart DeckStudio (deckctl stop && deckctl start).')
  if (r.status === 404 && allow404) return null
  if (r.status === 421) fail(`DeckStudio refused the Host header: use DECKSTUDIO_URL=http://127.0.0.1:<port>`)
  if (!r.ok) fail(`DeckStudio ${method} ${route} → ${r.status}: ${j?.error || text.slice(0, 200) || 'error'}`)
  return j
}

// ---------- helpers ----------
const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
const OVERLAY_FIELDS = ['label', 'title', 'icon', 'bg', 'fg', 'border', 'accent', 'progress', 'display', 'text', 'value', 'fontSize', 'iconSize', 'unit', 'style', 'image', 'imageFit']
// Agents can't add or change anything that runs code: a prompt-injected agent would otherwise get persistent code
// execution (a poll runs at once and on a timer). The user makes those changes in the editor. A guard rail for agents
// using these tools, not a sandbox: anything with a shell can read the token and call the HTTP API directly.
const askUser = what => `Refused: ${what}. Agents can't add or change shell / AppleScript / keystroke / typing / http / Shortcuts actions, opens of anything but an https url, or poll / browse commands over MCP. Ask the user to make this change themselves in the DeckStudio editor (${EDITOR_URL}); tell them exactly what to set and why.`
const execList = parts => parts.slice(0, 5).map(x => `${x.what} at ${x.path}`).join(', ') + (parts.length > 5 ? ` (+${parts.length - 5} more)` : '')
const ACTION_FIELDS = ['onPress', 'onLongPress', 'onRelease', 'onChange', 'onLeft', 'onRight', 'onTouch', 'onLongTouch', 'onTap', 'onSwipeLeft', 'onSwipeRight']

/** Replace big data: URLs with a short placeholder so outputs stay readable. */
function shrink(v) {
  if (typeof v === 'string') return v.startsWith('data:') && v.length > 120 ? `${v.slice(0, v.indexOf(',') + 1)}… (${v.length} chars)` : v
  if (Array.isArray(v)) return v.map(shrink)
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, shrink(x)]))
  return v
}
function describeAction(a) {
  if (!isObj(a) || !a.type || a.type === 'none') return undefined
  if (a.type === 'plugin') return `plugin ${a.plugin}.${a.action}`
  if (a.type === 'multi') return `multi[${(a.actions || []).map(describeAction).join(', ')}]`
  const arg = a.page ?? a.target ?? a.combo ?? a.cmd ?? a.url ?? a.name ?? a.command ?? a.device ?? a.mode ?? a.step ?? a.text ?? ''
  return `${a.type}${arg !== '' ? ' ' + String(arg).slice(0, 80) : ''}`
}
function summarizeControl(c, n) {
  if (!isObj(c) || !Object.keys(c).length) return { n, empty: true }
  const out = { n }
  for (const f of ['label', 'title', 'caption', 'mode', 'face', 'bot', 'sprite', 'logo', 'glyph', 'icon', 'plugin', 'display', 'unit', 'app']) if (c[f] != null && c[f] !== '') out[f] = shrink(c[f])
  if (c.image) out.image = '(image)'
  if (c.poll) out.poll = typeof c.poll === 'object' ? `${c.poll.cmd} every ${c.poll.interval ?? '?'}s` : String(c.poll)
  if (c.led) out.led = c.led
  for (const f of ACTION_FIELDS) { const d = describeAction(c[f]); if (d) out[f] = d }
  return out
}
function summarizePage(id, pg, { controls = true } = {}) {
  const s = { id, name: pg.name }
  for (const f of ['source', 'apps', 'providers', 'hidden']) if (pg[f] != null) s[f] = pg[f]
  if (controls) {
    s.keys = (pg.keys || []).map((k, i) => summarizeControl(k, i + 1))
    s.dials = (pg.dials || []).map((d, i) => summarizeControl(d, i + 1))
    s.strip = summarizeControl(pg.strip, 0); delete s.strip.n
  }
  return s
}
/** Flat diff of two JSON values: [{ path, before, after }]. */
function diff(a, b, p = '') {
  if (JSON.stringify(a) === JSON.stringify(b)) return []
  if (isObj(a) && isObj(b)) {
    const out = []
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) out.push(...diff(a[k], b[k], p ? `${p}.${k}` : k))
    return out
  }
  return [{ path: p || '(root)', before: shrink(a) ?? null, after: shrink(b) ?? null }]
}
function collectActions(c, out = []) {
  const walk = a => { if (!isObj(a)) return; if (a.type) out.push(a); if (Array.isArray(a.actions)) a.actions.forEach(walk) }
  if (isObj(c)) for (const f of ACTION_FIELDS) walk(c[f])
  return out
}
function checkActions(ctrl, actionTypes, before) {
  for (const a of collectActions(ctrl)) if (actionTypes && !Object.hasOwn(actionTypes, a.type)) fail(`unknown action type "${a.type}". Known: ${Object.keys(actionTypes).join(', ')}`)
  const added = addedExecParts(before ?? {}, ctrl)
  if (added.length) fail(askUser(`this edit adds or changes ${execList(added)}`))
  const kept = execParts(ctrl)
  return kept.length ? [`this control already runs ${execList(kept)} (set by the user; left as it was)`] : []
}
/** The profile for an agent's eyes: plugin settings (which may hold secrets) left out. */
const forAgent = p => { if (!isObj(p)) return p; const { plugins, ...rest } = p; return plugins ? { ...rest, plugins: '(plugin settings and grants: not shown to agents)' } : rest }
const oneBased = (v, max, what) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > max) fail(`${what} must be an integer 1–${max} (got ${JSON.stringify(v)})`)
  return n
}
const jsonText = v => JSON.stringify(v)

// ---------- tools ----------
const PAGE_PARAM = { type: 'string', description: 'Page id (see deck_status.pages). Default: the page on the deck now.' }
const RO = { readOnlyHint: true, openWorldHint: false }
const TEMP = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const WRITE = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }

const TOOLS = [
  {
    name: 'deck_status',
    title: 'Deck status',
    description: 'Read the Stream Deck+ state: connection, current page, all pages, brightness, live counters (agents_needs, agents_review, agents_working, bots_waiting), plugin states/values and which pages have temporary overlays. Call this first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: RO,
    async run() {
      const [st, agents, bots, plugins] = await Promise.all([
        api('GET', '/api/state'),
        api('GET', '/api/agents').catch(e => ({ error: e.message })),
        api('GET', '/api/bots').catch(e => ({ error: e.message })),
        api('GET', '/api/plugins').catch(e => ({ error: e.message })),
      ])
      const c = agents?.counts || {}
      const enabledProviders = new Set((bots?.providers || []).filter(p => p.enabled !== false).map(p => p.id))
      return {
        connected: st.status?.state === 'connected',
        device: st.status,
        page: st.page,
        pages: Object.entries(st.profile.pages).map(([id, pg]) => summarizePage(id, pg, { controls: false })),
        brightness: st.brightness,
        vars: {
          agents_needs: c.needs ?? null, agents_review: c.review ?? null, agents_working: c.working ?? null,
          bots_waiting: (() => { // same number as {bots_waiting}: the built-in bots plugin's value, else counted here
            const v = Number((plugins?.plugins || []).find(p => p.id === 'bots' && p.state === 'ok')?.values?.waiting)
            if (Number.isFinite(v)) return v
            return Array.isArray(bots?.bots) ? bots.bots.filter(b => !b.hidden && (b.awaiting || b.unread > 0) && enabledProviders.has(b.provider)).length : null
          })(),
        },
        agents_source: agents?.error ? { error: agents.error } : { available: agents?.available, error: agents?.error || undefined },
        plugins: plugins?.error ? { error: plugins.error } : (plugins.plugins || []).map(p => ({ id: p.id, state: p.state, enabled: p.enabled, installed: p.installed, values: p.values, error: p.error || undefined })),
        overlays_on_pages: Object.keys(st.overlay || {}),
        editor: EDITOR_URL,
      }
    },
  },
  {
    name: 'deck_flash',
    title: 'Flash temporary status',
    description: 'Show temporary status on the deck WITHOUT saving it: an overlay on a key (1–8), a dial segment (1–4) or the touch strip, or a short toast on the strip. Overlays stay until deck_clear (or a server restart); toasts vanish after `ms`. Only appearance fields are allowed: ' + OVERLAY_FIELDS.join(', ') + '. Example: {"target":"key","index":3,"label":"build ✓","bg":"#1d5f3a"}.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['target'],
      properties: {
        target: { type: 'string', enum: ['key', 'dial', 'strip', 'toast'] },
        index: { type: 'integer', minimum: 1, maximum: 8, description: 'Key 1–8 or dial 1–4 (target key/dial only).' },
        page: PAGE_PARAM,
        label: { type: 'string' }, title: { type: 'string' }, icon: { type: 'string', description: 'emoji or short text' },
        bg: { type: 'string', description: '#rrggbb' }, fg: { type: 'string' }, border: { type: 'string' }, accent: { type: 'string' },
        progress: { type: 'number', minimum: 0, maximum: 1 }, display: { type: 'string' }, value: { type: ['number', 'string'] },
        text: { type: 'string', description: 'strip text, or the toast message for target "toast"' },
        unit: { type: 'string' }, style: { type: 'string', enum: ['bar', 'gauge', 'text'] },
        fontSize: { type: 'number' }, iconSize: { type: 'number' },
        ms: { type: 'integer', minimum: 300, maximum: 30000, description: 'toast duration (default 2500)' },
      },
    },
    annotations: TEMP,
    async run(a) {
      if (a.target === 'toast') {
        if (!a.text) fail('toast needs text')
        await api('POST', '/api/toast', { text: String(a.text).slice(0, 200), ms: a.ms || 2500 })
        return { ok: true, shown: 'toast', text: a.text, ms: a.ms || 2500 }
      }
      const patch = Object.fromEntries(OVERLAY_FIELDS.filter(f => a[f] !== undefined).map(f => [f, a[f]]))
      if (!Object.keys(patch).length) fail(`nothing to show: set at least one of ${OVERLAY_FIELDS.join(', ')}`)
      const body = { kind: a.target, patch, page: a.page, persist: false }
      if (a.target !== 'strip') body.index = oneBased(a.index, a.target === 'key' ? 8 : 4, `${a.target} index`) - 1
      await api('POST', '/api/control', body)
      return { ok: true, temporary: true, target: a.target, index: a.index, page: a.page || '(current)', patch, undo: 'deck_clear' }
    },
  },
  {
    name: 'deck_clear',
    title: 'Clear temporary overlays',
    description: 'Remove temporary overlays set with deck_flash (and runtime dial values) on one page, or on every page when `page` is omitted. The saved profile is untouched.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { page: { type: 'string', description: 'Page id. Default: all pages.' } } },
    annotations: TEMP,
    async run(a) { await api('POST', '/api/overlay/clear', { page: a.page }); return { ok: true, cleared: a.page || 'all pages' } },
  },
  {
    name: 'deck_goto_page',
    title: 'Switch page',
    description: 'Show another page on the deck now (does not change the profile). With app switching on, bringing another app to the front may switch it again.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['page'], properties: { page: { type: 'string', description: 'Page id (deck_status.pages[].id)' } } },
    annotations: TEMP,
    async run(a) {
      const st = await api('GET', '/api/state')
      if (!Object.hasOwn(st.profile.pages, a.page)) fail(`no page "${a.page}". Pages: ${Object.keys(st.profile.pages).join(', ')}`)
      const r = await api('POST', '/api/goto', { page: a.page })
      return { ok: r.page === a.page, page: r.page }
    },
  },
  {
    name: 'deck_get_profile',
    title: 'Read profile',
    description: 'Read the saved deck profile. Default: a summary of every page (keys 1–8, dials 1–4, strip: labels, icons, what each press does). With `page`: just that page. `full: true` returns raw JSON (big data: images shortened) — use it before deck_set_key/deck_set_dial when you need exact fields.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { page: { type: 'string', description: 'Only this page' }, full: { type: 'boolean', description: 'Raw JSON instead of a summary' } } },
    annotations: RO,
    async run(a) {
      const st = await api('GET', '/api/state')
      const p = st.profile
      if (a.page && !Object.hasOwn(p.pages, a.page)) fail(`no page "${a.page}". Pages: ${Object.keys(p.pages).join(', ')}`)
      if (a.full) return a.page ? { page: a.page, json: shrink(p.pages[a.page]) } : shrink(forAgent(p))
      const ids = a.page ? [a.page] : Object.keys(p.pages)
      return {
        current: st.page, startPage: p.startPage, brightness: p.brightness, appSwitching: p.appSwitching, theme: p.theme,
        pages: ids.map(id => summarizePage(id, p.pages[id])),
      }
    },
  },
  ...['key', 'dial'].map(kind => {
    const max = kind === 'key' ? 8 : 4
    return {
      name: `deck_set_${kind}`,
      title: `Edit a ${kind} (saved)`,
      description: `MODIFIES THE SAVED PROFILE. Change ${kind} 1–${max} on a page: reads the whole profile, changes only that ${kind}, writes the whole profile back (no other page or control is touched) and returns a diff. \`set\` merges fields (a null value removes that field); \`replace\` swaps in a whole new ${kind} object ({} empties it). Use \`dry_run: true\` first to preview the diff. Field reference: docs/AGENT-GUIDE.md (resource deckstudio://docs/agent-guide). For temporary status use deck_flash instead.`,
      inputSchema: {
        type: 'object', additionalProperties: false, required: [kind],
        properties: {
          [kind]: { type: 'integer', minimum: 1, maximum: max, description: `${kind} number 1–${max}` },
          page: PAGE_PARAM,
          set: { type: 'object', description: kind === 'key' ? 'Fields to merge, e.g. {"label":"Build","glyph":"build-tool","onPress":{"type":"open","target":"https://…"}}' : 'Fields to merge, e.g. {"mode":"value","label":"Vol","min":0,"max":100}' },
          replace: { type: 'object', description: `A whole ${kind} object to put in place of the current one.` },
          dry_run: { type: 'boolean', description: 'Preview the diff without saving.' },
        },
      },
      annotations: WRITE,
      async run(a) {
        const n = oneBased(a[kind], max, kind)
        if ((a.set == null) === (a.replace == null)) fail('give exactly one of `set` or `replace`')
        if (a.set != null && !isObj(a.set)) fail('`set` must be an object')
        if (a.replace != null && !isObj(a.replace)) fail('`replace` must be an object')
        for (let attempt = 0; ; attempt++) {
          const st = await api('GET', '/api/state')
          const prof = st.profile
          const page = a.page || st.page
          if (!Object.hasOwn(prof.pages, page)) fail(`no page "${page}". Pages: ${Object.keys(prof.pages).join(', ')}`)
          const pg = prof.pages[page]
          const note = pg.source && kind === 'key' && `page "${page}" has source "${pg.source}": its keys are generated live, so edits to keys may not show`
          const list = kind === 'key' ? pg.keys : pg.dials
          const before = structuredClone(list[n - 1] || {})
          let after
          if (a.replace) after = structuredClone(a.replace)
          else { after = { ...before }; for (const [k, v] of Object.entries(a.set)) { if (v === null) delete after[k]; else after[k] = v } }
          const warnings = checkActions(after, st.actionTypes, before)
          if (note) warnings.push(note)
          const changes = diff(before, after)
          const pagesBefore = Object.keys(prof.pages)
          if (a.dry_run || !changes.length) return { dry_run: !!a.dry_run, saved: false, page, [kind]: n, changes, warnings, ...(changes.length ? {} : { note: 'no change' }) }
          const next = structuredClone(prof)
          ;(kind === 'key' ? next.pages[page].keys : next.pages[page].dials)[n - 1] = after
          // optimistic check: someone (the editor, another agent) saved in between → start over on the new profile
          const fresh = await api('GET', '/api/state')
          if (JSON.stringify(fresh.profile) !== JSON.stringify(prof)) { if (attempt < 2) continue; fail('the profile keeps changing under us (someone else is editing); try again') }
          await api('PUT', '/api/profile', next)
          const check = await api('GET', '/api/state')
          const lost = pagesBefore.filter(id => !Object.hasOwn(check.profile.pages, id))
          return { saved: true, page, [kind]: n, changes, warnings, ...(lost.length ? { error: `pages missing after save: ${lost.join(', ')}` } : {}) }
        }
      },
    }
  }),
  {
    name: 'deck_recipes_list',
    title: 'Browse recipes',
    description: 'List ready-made keys, dials and pages (incl. plugin templates). Filter with `where`/`query`. Pass `id` to get one recipe in full: what it does, its vars (`ask`), its template and the setup prompt.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'One recipe in full' },
        where: { type: 'string', enum: ['key', 'dial', 'page', 'none'], description: '"none" = prompt-only recipes' },
        query: { type: 'string', description: 'Case-insensitive search in id, title, category and description' },
      },
    },
    annotations: RO,
    async run(a) {
      const { recipes } = await api('GET', '/api/recipes')
      if (a.id) {
        const r = recipes.find(x => x.id === a.id)
        if (!r) fail(`no recipe "${a.id}"`)
        return { ...shrink(r), applicable: !!r.template }
      }
      const q = a.query?.toLowerCase()
      return {
        recipes: recipes
          .filter(r => !a.where || r.where === a.where)
          .filter(r => !q || [r.id, r.title, r.category, r.what].some(s => String(s || '').toLowerCase().includes(q)))
          .map(r => ({ id: r.id, category: r.category, where: r.where, title: r.title, what: r.what, needs: r.needs, vars: r.ask?.map(x => x.name), applicable: !!r.template, plugin: r.plugin, pluginEnabled: r.pluginEnabled })),
      }
    },
  },
  {
    name: 'deck_recipe_apply',
    title: 'Apply a recipe (saved)',
    description: 'MODIFIES THE SAVED PROFILE. Apply a recipe: "key"/"dial" recipes replace one key (1–8) / dial (1–4) on a page; "page" recipes add a new page (existing pages are never overwritten). Fill the recipe\'s vars with `vars`. `dry_run: true` shows what would be replaced.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id'],
      properties: {
        id: { type: 'string', description: 'Recipe id (deck_recipes_list)' },
        page: PAGE_PARAM,
        key: { type: 'integer', minimum: 1, maximum: 8, description: 'For key recipes' },
        dial: { type: 'integer', minimum: 1, maximum: 4, description: 'For dial recipes' },
        page_id: { type: 'string', description: 'For page recipes: id for the new page (made unique)' },
        vars: { type: 'object', additionalProperties: { type: 'string' }, description: 'Values for the recipe\'s {{placeholders}}' },
        dry_run: { type: 'boolean' },
      },
    },
    annotations: WRITE,
    async run(a) {
      const [{ recipes }, st] = await Promise.all([api('GET', '/api/recipes'), api('GET', '/api/state')])
      const r = recipes.find(x => x.id === a.id)
      if (!r) fail(`no recipe "${a.id}"`)
      if (!r.template) fail(`recipe "${a.id}" is prompt-only: read its prompt with deck_recipes_list {id} and follow it`)
      if (r.plugin && r.pluginEnabled === false) fail(`recipe "${a.id}" comes from the ${r.plugin} plugin, which is switched off. Only the user can switch it on: ask them to review it in the DeckStudio editor (${PLUGINS_LINK}).`)
      // the template as the server will fill it ({{var}} → the given values), checked for anything that runs code
      // (a string template names one of DeckStudio's built-in pages: checked the same way)
      const filled = typeof r.template === 'string'
        ? (await import('./local.mjs')).withLocal((await import('./default-profile.mjs')).defaultProfile()).pages[r.template] ?? {}
        : (await import('./recipes.mjs')).fillTemplate(r.template, Object.fromEntries(Object.entries(a.vars || {}).map(([k, v]) => [k, String(v).slice(0, 300)])))
      const parts = execParts(filled)
      if (parts.length) fail(askUser(`recipe "${a.id}" contains ${execList(parts)}`))
      const missing = (r.ask || []).map(x => x.name).filter(n => !(a.vars && n in a.vars))
      const body = { id: a.id, vars: a.vars || {}, origin: 'mcp' }
      let target
      if (r.where === 'page') { body.pageId = a.page_id; target = { new_page: a.page_id || r.title } }
      else {
        const page = a.page || st.page
        if (!Object.hasOwn(st.profile.pages, page)) fail(`no page "${page}"`)
        const max = r.where === 'key' ? 8 : 4
        const n = oneBased(r.where === 'key' ? a.key : a.dial, max, `${r.where} (required for a ${r.where} recipe)`)
        body.page = page; body.index = n - 1
        const cur = (r.where === 'key' ? st.profile.pages[page].keys : st.profile.pages[page].dials)[n - 1]
        target = { page, [r.where]: n, replaces: summarizeControl(cur, n) }
      }
      if (a.dry_run) return { dry_run: true, saved: false, recipe: r.id, where: r.where, target, template: shrink(r.template), missing_vars: missing }
      const out = await api('POST', '/api/recipes/apply', body)
      return { saved: true, recipe: r.id, where: r.where, result: out, target, ...(missing.length ? { warning: `vars not given (left as placeholders): ${missing.join(', ')}` } : {}) }
    },
  },
  {
    name: 'deck_plugins_list',
    title: 'List plugins',
    description: 'List DeckStudio plugins: state (ok/disabled/missing/stale/…), enabled, installed, values, actions (with blocked reasons), declared permissions vs. what the user granted. `registry: true` also lists installable plugins from the registry (browse only; installing is the user\'s decision).',
    inputSchema: { type: 'object', additionalProperties: false, properties: { registry: { type: 'boolean' } } },
    annotations: RO,
    async run(a) {
      const r = await api('GET', '/api/plugins')
      const out = {
        plugins: (r.plugins || []).map(p => ({
          id: p.id, name: p.name, version: p.version, source: p.source, state: p.state, enabled: p.enabled, installed: p.installed,
          description: p.description, values: p.values, vars: p.vars, error: p.error || undefined, errors: p.errors?.length ? p.errors : undefined,
          actions: (p.actions || []).map(x => ({ name: x.name, title: x.title, params: x.params, blocked: x.blocked || undefined })),
          permissions: p.permissions, grants: p.grants,
        })),
        manage: `Enabling, granting and installing plugins is done by the user in the editor: ${PLUGINS_LINK}`,
      }
      if (a.registry) {
        const reg = await api('GET', '/api/plugins/registry', undefined, { allow404: true }).catch(e => ({ error: e.message }))
        out.registry = !reg || reg.error ? { unavailable: reg?.error || 'this DeckStudio has no registry route yet' } : reg
      }
      return out
    },
  },
  {
    name: 'deck_plugin_info',
    title: 'Plugin details',
    description: 'One plugin in full: manifest (commands it runs, status source, values, actions, templates), permissions, grants and state.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' } } },
    annotations: RO,
    async run(a) {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(a.id)) fail('bad plugin id')
      return shrink(await api('GET', `/api/plugins/${a.id}`))
    },
  },
  {
    name: 'deck_plugin_run_action',
    title: 'Run a plugin action',
    description: 'Run one declared action of a plugin the user has explicitly switched on (e.g. {"id":"capture","action":"screen"}); plugins that are merely on by default (built-in / local) refuse. Logged like a key press. Disabled, missing or blocked plugins refuse with the reason; do not try to enable them yourself.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['id', 'action'],
      properties: {
        id: { type: 'string', description: 'Plugin id' }, action: { type: 'string', description: 'Action name (deck_plugins_list actions[].name)' },
        args: { type: 'object', description: 'Only the params the action declares' }, value: { type: ['number', 'string'], description: '{value} for the action' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    async run(a) {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(a.id)) fail('bad plugin id')
      const p = await api('GET', `/api/plugins/${a.id}`)
      if (!p.enabled) fail(`plugin "${a.id}" is switched off. Only the user can switch it on: ask them to review it in the DeckStudio editor (${PLUGINS_LINK}).`)
      // built-in and local plugins count as on until the user says otherwise; that default is for the user's own keys,
      // not for agents (capture's record would start a screen + mic recording): over MCP only an explicit switch-on counts
      const { profile } = await api('GET', '/api/state')
      if (profile?.plugins?.[a.id]?.enabled !== true) fail(`plugin "${a.id}" is on by default, but agents may only run plugins the user switched on themselves: ask them to switch it on in the DeckStudio editor (${PLUGINS_LINK}; for a plugin that already shows on, off and on again).`)
      const act = (p.actions || []).find(x => x.name === a.action)
      if (!act) fail(`plugin "${a.id}" has no action "${a.action}". Actions: ${(p.actions || []).map(x => x.name).join(', ') || 'none'}`)
      if (act.blocked) fail(`action blocked: ${act.blocked}. Permissions are granted by the user in the editor (${PLUGINS_LINK}).`)
      await api('POST', `/api/plugins/${a.id}/action`, { action: a.action, args: a.args, value: a.value })
      const log = tailLog(5).filter(l => l.includes(`plugin ${a.id}`)).slice(-1)[0]
      return { ok: true, plugin: a.id, action: a.action, log: log || undefined }
    },
  },
  {
    name: 'deck_plugin_enable',
    title: 'Ask the user to enable a plugin',
    description: 'Agents cannot switch plugins on or grant them permissions: enabling a plugin lets its commands run as the user, so that is a human decision. This tool changes nothing; it returns what the plugin would be allowed to do and a link the user opens to approve it in the editor. Tell the user, then wait.',
    inputSchema: { type: 'object', additionalProperties: false, required: ['id'], properties: { id: { type: 'string' }, reason: { type: 'string', description: 'Why you want it (shown back to you to relay to the user)' } } },
    annotations: RO,
    async run(a) {
      if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(a.id)) fail('bad plugin id')
      const p = await api('GET', `/api/plugins/${a.id}`)
      const on = p.enabled && (await api('GET', '/api/state')).profile?.plugins?.[a.id]?.enabled === true // as deck_plugin_run_action counts it
      return {
        changed: false,
        status: on ? 'already_enabled' : 'needs_user_approval',
        message: on ? `"${p.name}" is already on.` : `Ask the user to review and switch on "${p.name}" in the DeckStudio editor, Plugins tab: ${PLUGINS_LINK}${a.reason ? ` (reason: ${a.reason})` : ''}. Agents cannot enable plugins or grant shell / url schemes / network access themselves.`,
        link: PLUGINS_LINK,
        plugin: { id: p.id, name: p.name, source: p.source, installed: p.installed, state: p.state, permissions: p.permissions, grants: p.grants, actions: (p.actions || []).map(x => ({ name: x.name, kind: x.kind })) },
      }
    },
  },
  {
    name: 'deck_log_tail',
    title: 'Action log',
    description: 'Recent lines of the action log (~/.deckstudio/actions.log): every key press, dial turn, strip tap, page switch and action with ✓/✗ and the error. Use it to check that something you set up works after the user presses it.',
    inputSchema: { type: 'object', additionalProperties: false, properties: { lines: { type: 'integer', minimum: 1, maximum: 200, description: 'default 30' }, errors_only: { type: 'boolean' } } },
    annotations: RO,
    async run(a) {
      let lines = tailLog(a.errors_only ? 2000 : Math.min(a.lines || 30, 200))
      if (a.errors_only) lines = lines.filter(l => l.includes('✗') || l.includes(' ! ')).slice(-(a.lines || 30))
      return lines.length ? lines.join('\n') : '(no log lines yet)'
    },
  },
  {
    name: 'deck_bots_push_status',
    title: 'Push bot status',
    description: 'Update one bot of YOUR OWN bots provider (bring-your-own-bots): unread count, awaiting (waiting on the user: red lamp, counts in {bots_waiting}), hidden. Creates the bot (and the provider file) if it doesn\'t exist yet — then `name` is required. Only status data is pushed: no open actions, url schemes or shell. A new provider stays off the deck until the user switches it on in the editor; the result says whether it is on.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['provider', 'id'],
      properties: {
        provider: { type: 'string', pattern: '^[a-z0-9-]{1,32}$', description: 'Your provider id, e.g. "claude-code" ("grokbot" is reserved)' },
        provider_name: { type: 'string', description: 'Display name when creating the provider' },
        id: { type: 'string', description: 'Bot id within the provider' },
        name: { type: 'string', description: 'Bot name (required when creating the bot)' },
        subtitle: { type: 'string' },
        unread: { type: 'integer', minimum: 0, maximum: 999 },
        awaiting: { type: 'boolean' },
        hidden: { type: 'boolean' },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    async run(a) {
      if (!/^[a-z0-9-]{1,32}$/.test(a.provider)) fail('provider must be 1–32 of a-z, 0-9, -')
      if (a.provider === 'grokbot') fail('"grokbot" is reserved (read live from the Grok Bot app)')
      const status = Object.fromEntries(['unread', 'awaiting', 'hidden'].filter(k => a[k] !== undefined).map(k => [k, a[k]]))
      const cur = await api('GET', `/api/bots?provider=${encodeURIComponent(a.provider)}`)
      const prov = (cur.providers || []).find(p => p.id === a.provider)
      if (prov && prov.kind && prov.kind !== 'file') fail(`provider "${a.provider}" is a ${prov.kind} provider, not one pushed by agents; pick your own provider id`)
      const exists = (cur.bots || []).some(b => b.provider === a.provider && b.id === a.id)
      let how
      if (exists && a.name == null && a.subtitle == null) { await api('POST', '/api/bots/status', { provider: a.provider, id: String(a.id), ...status }); how = 'status' }
      else {
        if (!exists && !a.name) fail(`no bot "${a.id}" in "${a.provider}" yet: give \`name\` to create it`)
        const row = { id: String(a.id), ...status, activityAt: new Date().toISOString() }
        if (a.name != null) row.name = a.name
        if (a.subtitle != null) row.subtitle = a.subtitle
        const doc = { provider: a.provider, merge: true, bots: [row] }
        if (!prov && a.provider_name) doc.name = a.provider_name
        await api('POST', '/api/bots', doc); how = exists ? 'merged' : 'created'
      }
      const after = await api('GET', `/api/bots?provider=${encodeURIComponent(a.provider)}`)
      const p = (after.providers || []).find(x => x.id === a.provider)
      const enabled = p?.enabled !== false && p != null
      return {
        ok: true, how, provider: a.provider, id: a.id, status,
        provider_enabled: enabled,
        ...(enabled ? {} : { note: `Provider "${a.provider}" is off the deck until the user switches it on (editor, bots panel: ${EDITOR_URL}/#bots). Tell the user; don't try to enable it yourself.` }),
      }
    },
  },
]

/** Last n action-log lines, formatted like `deckctl log` (no colors). Reads the file directly: works with the server down. */
function tailLog(n) {
  let all
  try {
    const f = path.join(HOME_DIR, 'actions.log')
    const st = fs.statSync(f), size = Math.min(st.size, 512 * 1024)
    const fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(size); fs.readSync(fd, buf, 0, size, st.size - size); fs.closeSync(fd)
    all = buf.toString('utf8').split('\n').filter(Boolean)
    if (st.size > size) all.shift() // first line may be cut
  } catch { return [] }
  return all.slice(-n).map(l => {
    let e; try { e = JSON.parse(l) } catch { return l }
    const where = `${e.t} ${String(e.page || '').padEnd(9)}`
    if (e.ev === 'action') return `${where} ${e.ok ? '✓' : '✗'} ${String(e.src || '').padEnd(14)} ${e.action}${e.ms != null ? ` ${e.ms}ms` : ''}${e.error ? '  ← ' + e.error : ''}${e.note ? '  (' + e.note + ')' : ''}`
    if (e.ev === 'error') return `${where} ! ${e.msg}`
    if (e.ev === 'page') return `${where} → page ${e.from} → ${e.to}`
    if (e.ev === 'front app') return `${where}   front app: ${e.app}`
    const what = e.key ? `key ${e.key}` : e.dial ? `dial ${e.dial}` : ''
    return `${where} ${e.ev} ${what}${e.label ? ` "${e.label}"` : ''}${e.delta != null ? ` ${e.delta > 0 ? '+' : ''}${e.delta}` : ''}${e.segment != null ? ` seg ${e.segment}` : ''}${e.dx != null ? ` dx ${e.dx}` : ''}${e.mode ? ` [${e.mode}]` : ''}`
  }).map(scrub)
}

// Agents: GET /api/agents lists every enabled agent provider; deck_agent_push_status upserts one session of the
// caller's own provider through POST /api/agents/status (docs/AGENT-GUIDE.md, "Agent alerting → Endpoints").
const AGENTS_LIST = {
  name: 'deck_agents_list',
  title: 'List agents',
  description: 'Agents the deck knows about (Rex sessions and any other agent source) with their state, plus counts: needs (waiting on the user), review, working, idle. These drive {agents_needs} etc. on the deck.',
  inputSchema: { type: 'object', additionalProperties: false, properties: { all: { type: 'boolean', description: 'Include idle/done agents (default: only needs/review/working, max 50)' } } },
  annotations: RO,
  async run(a) {
    const r = await api('GET', '/api/agents')
    const list = Array.isArray(r.agents) ? r.agents : []
    const shown = a.all ? list : list.filter(x => !['idle', 'done', ''].includes(String(x.state || '')))
    return { ...shrink({ ...r, agents: undefined }), total: list.length, agents: shrink(shown.slice(0, a.all ? 500 : 50)) }
  },
}
const AGENT_STATES = ['idle', 'working', 'done', 'needs', 'error', 'gone']
const AGENT_APPS = ['claude-code', 'codex', 'ante', 'cursor', 'gemini', 'opencode', 'aider', 'amp', 'copilot', 'grok', 'custom']
const AGENT_PUSH = {
  name: 'deck_agent_push_status',
  title: 'Push agent status',
  description: 'Report one session of YOUR OWN agent provider to the deck (POST /api/agents/status): working, needs you (permission / question / auth), done, error, or gone (removes it). Fields left out keep their last value. Only status is pushed: no open actions, url schemes or shell. claude-code and codex providers are on by default; any other provider stays off the deck until the user switches it on in the editor (agents page → providers); the result says whether it is on.',
  inputSchema: {
    type: 'object', additionalProperties: false, required: ['provider', 'id', 'state'],
    properties: {
      provider: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,31}$', description: 'Your provider id, e.g. "my-agent" ("rex" is reserved: read live from Rex)' },
      id: { type: 'string', pattern: '^[A-Za-z0-9._:@-]{1,128}$', description: 'Session id within the provider' },
      state: { enum: AGENT_STATES, description: 'idle | working | done | needs (waiting on the user) | error | gone (remove the session)' },
      needs: { enum: ['permission', 'question', 'auth'], description: 'With state "needs": what the user has to do' },
      message: { type: 'string', maxLength: 200, description: 'Short text for the key / strip toast (no secrets or prompts: it shows on a physical device)' },
      name: { type: 'string', maxLength: 60, description: 'Short label (project / session name)' },
      title: { type: 'string', maxLength: 120 },
      app: { enum: AGENT_APPS, description: 'Which agent this is (icon); anything else is "custom"' },
      progress: { type: 'number', minimum: 0, maximum: 100, description: 'While working: 0–100' },
    },
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  async run(a) {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(String(a.provider ?? ''))) fail('provider must be 1–32 of a-z, 0-9, - (starting with a letter or digit)')
    if (a.provider === 'rex') fail('"rex" is reserved (read live from Rex): push under your own provider id')
    if (!/^[A-Za-z0-9._:@-]{1,128}$/.test(String(a.id ?? ''))) fail('id must be 1–128 of A-Z a-z 0-9 . _ : @ -')
    if (!AGENT_STATES.includes(a.state)) fail(`state must be one of ${AGENT_STATES.join(', ')}`)
    const body = { provider: a.provider, id: String(a.id), state: a.state }
    for (const k of ['needs', 'message', 'name', 'title', 'app', 'progress']) if (a[k] !== undefined && a[k] !== null) body[k] = a[k]
    if (body.needs && a.state !== 'needs') delete body.needs
    const r = await api('POST', '/api/agents/status', body, { allow404: true })
    if (r === null) fail('the running DeckStudio has no POST /api/agents/status yet: ask the user to restart it (deckctl stop && deckctl start)')
    const enabled = r?.enabled !== false
    return {
      ok: true, provider: a.provider, id: String(a.id), state: a.state, removed: !!r?.removed, provider_enabled: enabled,
      ...(enabled ? {} : { note: `Provider "${a.provider}" is off the deck until the user switches it on (editor, agents page → providers: ${EDITOR_URL}/#agents). Tell the user; don't try to enable it yourself.` }),
    }
  },
}

// ---------- resources: the docs agents need to write profiles ----------
const RESOURCES = [
  { uri: 'deckstudio://docs/agent-guide', name: 'DeckStudio agent guide', file: 'docs/AGENT-GUIDE.md', description: 'Profile shape, key/dial fields, actions, live vars, bots, recipes.' },
  { uri: 'deckstudio://docs/plugins', name: 'DeckStudio plugin spec', file: 'docs/PLUGINS.md', description: 'plugin/v1 manifests, trust model, plugin API.' },
  { uri: 'deckstudio://docs/mcp', name: 'DeckStudio MCP server', file: 'docs/MCP.md', description: 'These tools and their safety rules.' },
]

export async function main() {
  if (BASE.error) console.error(`deckstudio-mcp: ${BASE.error}`)
  const tools = [...TOOLS, AGENTS_LIST, AGENT_PUSH]
  const byName = new Map(tools.map(t => [t.name, t]))
  const server = new Server(
    { name: 'deckstudio', title: 'DeckStudio (Stream Deck+)', version: VERSION },
    {
      capabilities: { tools: {}, resources: {} },
      instructions: 'DeckStudio drives the user\'s Elgato Stream Deck+ (8 keys, 4 dials, touch strip). Start with deck_status. For transient status use deck_flash / deck_clear (never saved). deck_set_key / deck_set_dial / deck_recipe_apply change the saved profile: preview with dry_run and tell the user what you changed. Enabling plugins, granting permissions, installing plugins and switching on bot providers are the user\'s decisions in the editor; never work around that.',
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations: { title, ...annotations } })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async req => {
    const t = byName.get(req.params.name)
    if (!t) return { isError: true, content: [{ type: 'text', text: `unknown tool ${req.params.name}` }] }
    try {
      const out = await t.run(req.params.arguments || {})
      return { content: [{ type: 'text', text: scrub(typeof out === 'string' ? out : jsonText(out)) }] }
    } catch (e) {
      if (!(e instanceof ToolError)) console.error(`deckstudio-mcp: ${t.name}:`, scrub(e?.stack || e))
      return { isError: true, content: [{ type: 'text', text: scrub(e instanceof ToolError ? e.message : `${t.name} failed: ${e?.message || e}`) }] }
    }
  })
  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: RESOURCES.filter(r => fs.existsSync(path.join(ROOT, r.file))).map(({ uri, name, description }) => ({ uri, name, description, mimeType: 'text/markdown' })),
  }))
  server.setRequestHandler(ReadResourceRequestSchema, async req => {
    const r = RESOURCES.find(x => x.uri === req.params.uri)
    if (!r) throw new Error(`unknown resource ${req.params.uri}`)
    return { contents: [{ uri: r.uri, mimeType: 'text/markdown', text: fs.readFileSync(path.join(ROOT, r.file), 'utf8') }] }
  })
  await server.connect(new StdioServerTransport())
  console.error(`deckstudio-mcp ${VERSION} ready (${BASE.url || 'no server URL'}, ${tools.length} tools)`)
}
