// The engine owns the device, the active profile, runtime state, and input routing.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { listStreamDecks, openStreamDeck } from '@elgato-stream-deck/node'
import { renderKey, renderStrip, renderError, rgba, SEG_W } from './render.mjs'
import { isAnimatedGif } from './render-spec.mjs'
import { runAction, getVolume, setVolume, sh, osa } from './actions.mjs'
import { defaultProfile } from './default-profile.mjs'
import { withLocal } from './local.mjs'
import { Live } from './live.mjs'
import { dialReadonly, dialReadonlyInferred, isVarValue, dialVarValue } from './dial-rules.mjs'
import { cleanPluginsConfig, VAR_RE } from './plugin-schema.mjs'

const LONG_PRESS_MS = 550
const MAX_IMAGE = 3 << 20
const IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const finite = (v, dflt) => { const n = Number(v); return v !== null && v !== '' && Number.isFinite(n) ? n : dflt }
const hash = buf => crypto.createHash('sha1').update(buf).digest('base64')
const has = (obj, k) => obj != null && typeof k === 'string' && Object.hasOwn(obj, k)
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)
// Fields that temporary overlays (deckctl / API without --persist) may touch: appearance only,
// so a status push can never smuggle in an unsaved, invisible shell action.
const OVERLAY_FIELDS = new Set(['label', 'title', 'icon', 'bg', 'fg', 'border', 'accent', 'progress', 'display', 'text', 'value', 'fontSize', 'iconSize', 'unit', 'style', 'image', 'imageFit'])

// A dial that only shows a live readout (a `poll` and nothing using its value) can't be turned: turning it
// would just fight the next poll. `readonly: true|false` overrides the guess (src/dial-rules.mjs, shared with
// the editor). A read-only dial with `browse: { cmd }` uses turns to step through the command's lines instead (see dialBrowse).
export { dialReadonly }
const BROWSE_HOLD = 5000 // a browsed item stays on the segment this long after the last turn
const BROWSE_MAX = 12

function cleanImage(o) {
  if (isObj(o) && 'image' in o && !(typeof o.image === 'string' && o.image.length <= MAX_IMAGE && IMAGE_RE.test(o.image))) delete o.image
}

const strs = v => (Array.isArray(v) ? v.filter(x => typeof x === 'string') : [])
export function normalizeProfile(p) {
  if (!isObj(p) || !isObj(p.pages)) throw new Error('profile must have pages')
  p.theme = isObj(p.theme) ? p.theme : {}
  p.brightness = clamp(finite(p.brightness, 70), 0, 100)
  // bot providers: commands + what the user trusts per provider (enabled / schemes / allowShell); string fields only
  if ('botProviders' in p) p.botProviders = (Array.isArray(p.botProviders) ? p.botProviders : [])
    .filter(c => isObj(c) && typeof c.id === 'string' && ['name', 'cmd', 'type'].every(k => c[k] == null || typeof c[k] === 'string'))
    .map(c => ('schemes' in c ? { ...c, schemes: strs(c.schemes) } : c))
  // agent providers: what the user enabled / allowed per provider (src/agent-schema.mjs agentTrust)
  if ('agentProviders' in p) p.agentProviders = (Array.isArray(p.agentProviders) ? p.agentProviders : [])
    .filter(c => isObj(c) && typeof c.id === 'string').map(c => ({ id: c.id, ...(typeof c.enabled === 'boolean' ? { enabled: c.enabled } : {}), ...('schemes' in c ? { schemes: strs(c.schemes) } : {}) }))
  // plugins: { id: { enabled?, grants: { shell, schemes, network } } } (what the user enabled / allowed; see src/plugin-schema.mjs)
  if ('plugins' in p) p.plugins = cleanPluginsConfig(p.plugins)
  const pages = Object.create(null)
  for (const [id, pg] of Object.entries(p.pages)) {
    if (!isObj(pg)) throw new Error(`page "${id}" must be an object`)
    if (!id || id === '__proto__' || id.length > 64) throw new Error(`invalid page id "${id}"`)
    pg.name = String(pg.name ?? id)
    pg.keys = Array.from({ length: 8 }, (_, i) => (isObj(pg.keys?.[i]) ? pg.keys[i] : {}))
    pg.dials = Array.from({ length: 4 }, (_, i) => (isObj(pg.dials?.[i]) ? pg.dials[i] : {}))
    pg.strip = isObj(pg.strip) ? pg.strip : { mode: 'segments' }
    pg.keys.forEach(cleanImage); pg.dials.forEach(cleanImage); cleanImage(pg.strip)
    // `_press` / `_rotate`… are runtime-only (live overlays, src/live.mjs) and run before onPress, outside every check
    // on saved / templated actions: never persisted
    for (const c of [...pg.keys, ...pg.dials, pg.strip]) for (const k of Object.keys(c)) if (k.startsWith('_')) delete c[k]
    for (const f of ['providers', 'bots']) if (f in pg) pg[f] = strs(pg[f]) // bots pages: string refs only
    pages[id] = pg
  }
  const ids = Object.keys(pages)
  if (!ids.length) throw new Error('profile needs at least one page')
  p.pages = Object.fromEntries(Object.entries(pages)) // plain object for JSON, order preserved
  if (!has(p.pages, p.startPage)) p.startPage = ids[0]
  return p
}

export class Engine extends EventEmitter {
  constructor({ profilePath }) {
    super()
    this.profilePath = profilePath
    this.profile = this.loadProfile()
    this.page = this.profile.startPage
    this.history = []
    this.values = Object.create(null)    // pageId -> [v0..v3]   runtime dial values
    this.dialVars = Object.create(null)  // pageId -> [{out}..]  poll output per dial
    this.keyVars = Object.create(null)   // pageId -> [{out}..]  poll output per key
    this.overlay = Object.create(null)   // pageId -> {keys:{i:patch}, dials:{i:patch}, strip:patch}  (not persisted)
    this.vol = { volume: null, muted: false }
    this.pressed = new Set()
    this.longTimers = new Map()          // key index -> { timer, fired, onPress }
    this.activeDial = null
    this.toastState = null
    this.brightness = this.profile.brightness
    this.status = { state: 'starting', detail: '' }
    this.device = null
    this.devPushed = new WeakMap()       // device -> Map(controlId -> hash) of what that device really shows
    this.uiHash = new Map()              // controlId -> hash of what the editor was last sent
    this.lastFrame = { keys: [], strip: null }
    this.timers = []
    this.db = {}
    this.browse = Object.create(null)    // pageId -> [{ items, i, until }]  dials stepping through browse lines
    this.renderQueued = false
    this.rendering = Promise.resolve()
    this.connecting = null
    this.live = new Live(this)
  }

  hasPage(id) { return has(this.profile.pages, id) }

  // ---------- profile ----------
  loadProfile() {
    try { return normalizeProfile(JSON.parse(fs.readFileSync(this.profilePath, 'utf8'))) }
    catch (e) {
      if (fs.existsSync(this.profilePath)) {
        const bak = this.profilePath + '.corrupt-' + Date.now()
        fs.copyFileSync(this.profilePath, bak); fs.chmodSync(bak, 0o600)
        console.error(`profile unreadable (${e.message}); backed up to ${bak}`)
      }
      const p = normalizeProfile(withLocal(defaultProfile()))
      this.writeProfile(p)
      return p
    }
  }
  writeProfile(p) {
    fs.mkdirSync(path.dirname(this.profilePath), { recursive: true, mode: 0o700 })
    const tmp = this.profilePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(p, null, 2), { mode: 0o600 })
    fs.renameSync(tmp, this.profilePath)
  }
  setProfile(p, origin) {
    p = normalizeProfile(structuredClone(p))
    const old = this.profile
    this.writeProfile(p)
    this.profile = p
    // Drop runtime state that no longer matches its control, so edits always show up.
    for (const id of Object.keys(this.overlay)) if (!this.hasPage(id)) delete this.overlay[id]
    for (const bag of [this.values, this.dialVars, this.keyVars, this.browse]) for (const id of Object.keys(bag)) if (!this.hasPage(id)) delete bag[id]
    for (const [id, pg] of Object.entries(p.pages)) {
      const was = has(old.pages, id) ? old.pages[id] : null
      pg.keys.forEach((k, i) => { if (JSON.stringify(k) !== JSON.stringify(was?.keys[i])) { delete this.overlay[id]?.keys?.[i]; delete this.keyVars[id]?.[i] } })
      pg.dials.forEach((d, i) => {
        if (JSON.stringify(d) === JSON.stringify(was?.dials[i])) return
        delete this.overlay[id]?.dials?.[i]; delete this.dialVars[id]?.[i]; delete this.browse[id]?.[i]
        const w = was?.dials[i] || {}
        if (d.mode !== w.mode || d.min !== w.min || d.max !== w.max || JSON.stringify(d.poll) !== JSON.stringify(w.poll)) delete this.values[id]?.[i]
      })
      if (JSON.stringify(pg.strip) !== JSON.stringify(was?.strip)) delete this.overlay[id]?.strip
    }
    if (p.brightness !== this.brightness) this.setBrightness(p.brightness, false)
    this.history = this.history.filter(id => this.hasPage(id))
    if (!this.hasPage(this.page)) { this.page = p.startPage; this.emit('page', this.page) }
    this.restartPollers()
    this.live.plugins.sync() // enable / grants changed: start or stop plugin pollers now
    this.scheduleRender()
    this.emit('profile', p, origin)
    this.live.appsChanged(old.pages)
  }

  // ---------- resolved view of a page (profile + overlay) ----------
  pageView(id = this.page) {
    const pg = this.profile.pages[id]
    const ov = this.overlay[id] || {}
    // dynamic pages (rex agents, audio devices) generate controls; empty slots keep the page's own
    let gen = null
    if (pg.source) { try { gen = this.live.sourceView(pg) } catch (e) { this.notify(`source ${pg.source}: ${e.message}`, 'error') } }
    return {
      ...pg,
      keys: pg.keys.map((k, i) => this.live.decorate({ ...(gen?.keys?.[i] || k), ...(ov.keys?.[i] || {}) })),
      dials: pg.dials.map((d, i) => ({ ...(gen?.dials?.[i] || d), ...(ov.dials?.[i] || {}) })),
      strip: { ...pg.strip, ...(gen?.strip || {}), ...(ov.strip || {}) },
    }
  }
  dialValue(i, id = this.page) {
    const d = this.pageView(id).dials[i]
    if (d.mode === 'brightness') return this.brightness
    if (d.mode === 'volume') return this.vol.muted ? 'Muted' : this.vol.volume
    if (isVarValue(d.value)) return dialVarValue(d.value, this.live.vars()) // "{codexbar.claude_session}": follows the live var
    const v = this.values[id]?.[i]
    if (v !== undefined) return v
    if (d.value != null) return d.value
    return (d.mode || 'value') === 'value' && !d.poll ? finite(d.min, 0) : null
  }
  setDialValue(i, v, id = this.page) { (this.values[id] ??= [])[i] = v }

  setControl({ page = this.page, kind, index, patch, persist = false }) {
    if (!this.hasPage(page)) throw new Error(`no page ${page}`)
    if (!['key', 'dial', 'strip'].includes(kind)) throw new Error('kind must be key|dial|strip')
    if (!isObj(patch)) throw new Error('patch must be an object')
    if (kind !== 'strip') {
      index = Number(index)
      if (!Number.isInteger(index) || index < 0 || index >= (kind === 'key' ? 8 : 4)) throw new Error('bad index')
    }
    patch = { ...patch }
    if (kind === 'dial' && 'value' in patch) {
      const n = finite(patch.value, null)
      this.setDialValue(index, n ?? String(patch.value).slice(0, 80), page); delete patch.value
    }
    if (persist) {
      const p = structuredClone(this.profile)
      const pg = p.pages[page]
      if (kind === 'strip') Object.assign(pg.strip, patch)
      else Object.assign((kind === 'key' ? pg.keys : pg.dials)[index], patch)
      this.setProfile(p, 'api')
    } else {
      const bad = Object.keys(patch).filter(k => !OVERLAY_FIELDS.has(k))
      if (bad.length) throw new Error(`temporary updates may only change appearance (${[...OVERLAY_FIELDS].join(', ')}); use --persist for: ${bad.join(', ')}`)
      cleanImage(patch)
      const ov = (this.overlay[page] ??= {})
      if (kind === 'strip') ov.strip = { ...ov.strip, ...patch }
      else { const bag = (ov[kind + 's'] ??= {}); bag[index] = { ...bag[index], ...patch } }
      this.scheduleRender()
    }
  }
  clearOverlay(page) {
    if (page) { delete this.overlay[page]; delete this.values[page] } else { this.overlay = Object.create(null); this.values = Object.create(null) }
    this.scheduleRender()
  }

  // ---------- navigation / feedback ----------
  goto(id) {
    if (!this.hasPage(id)) return this.notify(`no page "${id}"`, 'error')
    this.live.manualPage()
    if (id === this.page) return
    this.history.push(this.page); if (this.history.length > 50) this.history.shift()
    this.switchTo(id)
  }
  switchTo(id) { const from = this.page; this.page = id; this.restartPollers(); this.scheduleRender(); this.emit('page', id); this.trace({ ev: 'page', from, to: id }) }
  back() { const id = this.history.pop(); if (id && this.hasPage(id)) { this.live.manualPage(); this.switchTo(id) } }
  pageOrder() { return Object.keys(this.profile.pages).filter(id => !this.profile.pages[id].hidden) }
  cyclePage(dir) {
    const order = this.pageOrder(); if (!order.length) return
    const i = order.indexOf(this.page)
    const next = i < 0 ? order[0] : order[(i + dir + order.length) % order.length]
    if (next === this.page) return
    this.goto(next)
    this.toast(this.profile.pages[this.page].name, 900)
  }
  toast(text, ms = 1200) {
    clearTimeout(this.toastTimer)
    this.toastState = String(text ?? '').slice(0, 200)
    this.toastTimer = setTimeout(() => { this.toastState = null; this.scheduleRender() }, ms)
    this.scheduleRender()
  }
  notify(msg, level = 'info') {
    this.emit('log', { level, msg, t: Date.now() })
    if (level === 'error') { console.error(msg); this.trace({ ev: 'error', msg }) }
  }
  /** One line per input / action in ~/.deckstudio/actions.log (deckctl log -f), for button testing. */
  trace(entry) {
    const line = { t: new Date().toISOString().slice(11, 23), page: this.page, ...entry }
    this.emit('trace', line)
    try {
      const f = path.join(path.dirname(this.profilePath), 'actions.log')
      if ((this.traceBytes = (this.traceBytes ?? (fs.existsSync(f) ? fs.statSync(f).size : 0))) > 5e6) { fs.renameSync(f, f + '.1'); this.traceBytes = 0 }
      const s = JSON.stringify(line) + '\n'
      fs.appendFileSync(f, s, { mode: 0o600 }); this.traceBytes += s.length
    } catch {}
  }
  describeAction(a) {
    if (!a || !a.type) return 'none'
    if (a.type === 'internal') return a.desc || 'built-in'
    if (a.type === 'plugin') return `plugin ${a.plugin}.${a.action}`
    const arg = a.page ?? a.target ?? a.combo ?? a.cmd ?? a.url ?? a.name ?? a.command ?? a.device ?? a.mode ?? a.step ?? a.text ?? ''
    return `${a.type}${arg !== '' ? ' ' + String(arg).slice(0, 80) : ''}`
  }
  label(kind, i) {
    const v = this.pageView()
    const c = kind === 'key' ? v.keys[i] : v.dials[i]
    return String(c?.label || c?.title || c?.glyph || c?.logo || c?.sprite || '').replace(VAR_RE, '').trim().slice(0, 40)
  }
  async setBrightness(v, persist = true) {
    this.brightness = clamp(Math.round(finite(v, this.brightness)), 0, 100)
    const dev = this.device
    if (dev) await dev.setBrightness(this.brightness).catch(e => this.onDeviceError(e, dev))
    if (persist) { this.profile.brightness = this.brightness; this.writeProfileDebounced() }
    this.emit('brightness', this.brightness)
    this.scheduleRender()
    return this.brightness
  }
  writeProfileDebounced() { clearTimeout(this.wpTimer); this.wpTimer = setTimeout(() => { this.wpTimer = null; this.writeProfile(this.profile) }, 800) }

  // ---------- rendering ----------
  scheduleRender() {
    if (this.renderQueued || this.stopped) return
    this.renderQueued = true
    setTimeout(() => {
      this.renderQueued = false
      this.rendering = this.rendering.then(() => this.render()).catch(e => this.notify(`render: ${e.message}`, 'error'))
    }, 12)
  }
  async safeCanvas(id, fn, w, h) {
    try { return await fn() } catch (e) { this.notify(`render ${id}: ${e.message}`, 'error'); return renderError(w, h, e.message) }
  }
  async render() {
    if (this.stopped || !this.hasPage(this.page)) return
    const dev = this.device // read once: a reconnect mid-render must not mix devices
    const pushed = dev ? (this.devPushed.get(dev) || this.devPushed.set(dev, new Map()).get(dev)) : null
    const view = this.pageView()
    const theme = this.profile.theme
    const liveVars = this.live.vars()
    const changed = { keys: {}, strip: null }
    // animation clock: only runs while something animated is on screen (~12 fps)
    const animated = theme.style === 'spec' && view.keys.some(k => k && (k.sprite || k.motion || isAnimatedGif(k.image)))
    const t = animated ? Date.now() : 0
    if (animated && !this.animTimer && !this.stopped) this.animTimer = setTimeout(() => { this.animTimer = null; this.scheduleRender() }, 80)
    const out = async (id, canvas, push) => {
      const buf = rgba(canvas), h = hash(buf)
      if (this.uiHash.get(id) !== h) {
        this.uiHash.set(id, h)
        const url = 'data:image/png;base64,' + (await canvas.encode('png')).toString('base64')
        if (id === 'strip') changed.strip = this.lastFrame.strip = url
        else changed.keys[id.slice(1)] = this.lastFrame.keys[id.slice(1)] = url
      }
      if (dev && pushed.get(id) !== h) {
        try { await push(buf); if (this.device === dev) pushed.set(id, h) } // record only after a successful write
        catch (e) { this.onDeviceError(e, dev) }
      }
    }
    for (let i = 0; i < 8; i++) {
      const c = await this.safeCanvas(`key ${i + 1}`, () => renderKey(view.keys[i], theme, { t, pressed: this.pressed.has(i), vars: { page: view.name, ...liveVars, ...(this.keyVars[this.page]?.[i] || {}) } }), 120, 120)
      await out('k' + i, c, buf => dev.fillKeyBuffer(i, buf, { format: 'rgba' }))
    }
    const values = [0, 1, 2, 3].map(i => this.dialValue(i))
    const s = await this.safeCanvas('strip', () => renderStrip(view.strip, view.dials, values, theme, {
      active: this.activeDial, toast: this.toastState, swipe: this.pageOrder().length > 1 || !!(view.strip.onSwipeLeft || view.strip.onSwipeRight), vars: { page: view.name, ...liveVars }, dialVars: this.dialVars[this.page] || [],
      browse: this.browseView(),
    }), 800, 100)
    await out('strip', s, buf => dev.fillLcdRegion(0, 0, 0, buf, { format: 'rgba', width: 800, height: 100 }))
    // dial state for the editor's knobs (value, how far round, what it does)
    const dials = view.dials.map((d, i) => {
      const v = values[i]
      const lo = d.mode === 'volume' || d.mode === 'brightness' ? 0 : finite(d.min, 0), hi = d.mode === 'volume' || d.mode === 'brightness' ? 100 : finite(d.max, 100)
      const num = typeof v === 'number' && isFinite(v)
      const shown = d.display != null ? String(d.display).replace(VAR_RE, (m, k) => (liveVars[k] ?? this.dialVars[this.page]?.[i]?.[k] ?? '')).slice(0, 24) : null
      const ro = typeof d._rotate !== 'function' && dialReadonly(d)
      return { label: String(d.label || '').replace(VAR_RE, ''), value: shown ?? (num ? +v.toFixed(2) : v ?? null), pct: num && hi > lo ? Math.max(0, Math.min(1, (v - lo) / (hi - lo))) : null, turns: ro ? !!d.browse?.cmd : !!(d._rotate || d.mode || d.onLeft || d.onRight || d.onChange), ...(ro ? { readonly: true } : {}) }
    })
    const dj = JSON.stringify(dials)
    const dialsChanged = dj !== this.lastDials
    if (dialsChanged) { this.lastDials = dj; this.lastFrame.dials = dials }
    if (Object.keys(changed.keys).length || changed.strip || dialsChanged) this.emit('frame', { ...changed, ...(dialsChanged ? { dials } : {}), page: this.page })
  }
  fullFrame() { return { keys: Object.fromEntries(this.lastFrame.keys.map((k, i) => [i, k])), strip: this.lastFrame.strip, dials: this.lastFrame.dials, page: this.page } }

  // ---------- input ----------
  async act(action, vars = {}, src = '') {
    if (!isObj(action) || !action.type || action.type === 'none') { if (src) this.trace({ ev: 'action', src, action: 'none', ok: true, note: 'nothing configured' }); return }
    const t0 = Date.now(), desc = this.describeAction(action)
    let ok = true, err
    try {
      const r = action.type === 'internal' ? await action.run?.(vars) : await runAction(action, { engine: this, vars: { page: this.page, ...vars } })
      if (r && r.ok === false) { ok = false; err = (r.stderr || r.err?.message || 'failed').toString().split('\n')[0] }
    } catch (e) { ok = false; err = e.message; this.notify(`action ${action?.type} failed: ${e.message}`, 'error') }
    this.trace({ ev: 'action', src, action: desc, ok, ms: Date.now() - t0, ...(err ? { error: err } : {}) })
    return { ok, error: err }
  }
  keyDown(i) {
    const key = this.pageView().keys[i]
    const prev = this.longTimers.get(i); if (prev) { clearTimeout(prev.timer); this.longTimers.delete(i) }
    this.pressed.add(i); this.scheduleRender()
    this.emit('input', { kind: 'key', index: i, event: 'down' })
    this.trace({ ev: 'key down', key: i + 1, label: this.label('key', i) })
    this.releaseFor ??= new Map()
    if (key.onRelease) this.releaseFor.set(i, key.onRelease) // captured now: the page may change before release
    else this.releaseFor.delete(i)
    if (key.onPress?.type === 'hold-keys') {
      // push-to-talk: the combo is held exactly as long as the key
      this.held ??= new Map()
      if (this.held.has(i)) this.live.hold(this.held.get(i), false)
      this.held.set(i, key.onPress.combo)
      this.live.hold(String(key.onPress.combo || ''), true)
      this.trace({ ev: 'action', src: `key ${i + 1}`, action: `hold-keys ${key.onPress.combo} (down)`, ok: true })
      return
    }
    if (key.onLongPress?.type && key.onLongPress.type !== 'none') {
      const entry = { fired: false, onPress: key.onPress, onLong: key.onLongPress } // capture: the page may change before release
      entry.timer = setTimeout(() => { entry.fired = true; this.act(key.onLongPress, { index: i }, `key ${i + 1} hold`) }, LONG_PRESS_MS)
      this.longTimers.set(i, entry)
    } else { this.longTimers.delete(i); this.act(key.onPress, { index: i }, `key ${i + 1}`) }
  }
  keyUp(i) {
    this.pressed.delete(i); this.scheduleRender()
    this.emit('input', { kind: 'key', index: i, event: 'up' })
    const held = this.held?.get(i)
    if (held != null) { this.held.delete(i); this.live.hold(String(held), false); this.trace({ ev: 'action', src: `key ${i + 1}`, action: `hold-keys ${held} (up)`, ok: true }) }
    const t = this.longTimers.get(i)
    if (t) {
      this.longTimers.delete(i)
      if (!t.fired) {
        clearTimeout(t.timer)
        // a hold-only key: say so instead of silently doing nothing
        if (!t.onPress?.type || t.onPress.type === 'none') { this.toast(`hold to ${this.describeAction(t.onLong)}`, 1400); this.trace({ ev: 'action', src: `key ${i + 1}`, action: 'none', ok: true, note: 'short press on a hold-only key' }) }
        else this.act(t.onPress, { index: i }, `key ${i + 1}`)
      }
    }
    const rel = this.releaseFor?.get(i)
    if (rel) { this.releaseFor.delete(i); this.act(rel, { index: i }) }
  }
  releaseAll() {
    for (const t of this.longTimers.values()) clearTimeout(t.timer)
    this.longTimers.clear(); this.pressed.clear()
    for (const [i, rel] of this.releaseFor || []) this.act(rel, { index: i }) // keys still down: run their onRelease
    this.releaseFor?.clear()
    for (const combo of this.held?.values() || []) this.live.hold(String(combo), false) // never leave a key stuck down
    this.held?.clear()
  }
  flashDial(i) {
    this.activeDial = i
    clearTimeout(this.activeTimer)
    this.activeTimer = setTimeout(() => { this.activeDial = null; this.scheduleRender() }, 700)
    this.scheduleRender()
  }
  async dialRotate(i, delta) {
    const d = this.pageView().dials[i]
    const page = this.page
    const ro = typeof d._rotate !== 'function' && dialReadonly(d)
    this.emit('input', { kind: 'dial', index: i, event: 'rotate', delta, ...(ro ? { readonly: true } : {}) })
    setImmediate(() => this.trace({ ev: 'dial turn', dial: i + 1, delta, label: this.label('dial', i), mode: d._rotate ? 'built-in' : ro ? (d.browse?.cmd ? 'browse' : 'read-only') : d.mode || 'value' })) // label after the turn
    this.flashDial(i)
    if (typeof d._rotate === 'function') return d._rotate(Math.sign(delta) * Math.min(Math.abs(delta), 5))
    if (ro && dialReadonlyInferred(d) && !(this.roNoticed ??= new Set()).has(page + '\0' + i)) { // once per dial: say why the turn did nothing
      this.roNoticed.add(page + '\0' + i)
      this.notify(`dial ${i + 1}${d.label ? ` "${d.label}"` : ''} on ${page} is read-only: it polls a value and nothing uses it, so turns ${d.browse?.cmd ? 'browse its list' : 'are ignored'}. Set "readonly": false to turn it.`, 'info')
    }
    if (ro) return this.dialBrowse(i, delta, d, page) // a live readout: the value is never turned
    const mode = d.mode || 'value'
    if (mode === 'volume') {
      if (this.vol.volume == null) { this.volRead ??= getVolume().finally(() => { this.volRead = null }); this.vol.volume = (await this.volRead) ?? 50 }
      const wasMuted = this.vol.muted
      this.vol.volume = clamp(this.vol.volume + delta * finite(d.step, 2), 0, 100)
      this.vol.muted = false
      this.volTouched = Date.now()
      this.scheduleRender()
      const v = this.vol.volume
      this.debounce('vol', 40, () => wasMuted ? osa(`set volume output volume ${v} without output muted`) : setVolume(v))
    } else if (mode === 'brightness') {
      await this.setBrightness(this.brightness + delta * finite(d.step, 5))
    } else if (mode === 'value') {
      const min = finite(d.min, 0), max = finite(d.max, 100), step = Math.abs(finite(d.step, 1)) || 1
      const cur = finite(this.dialValue(i, page), min)
      let v
      if (d.wrap && max > min) {
        const n = Math.floor((max - min) / step) + 1
        const idx = (((Math.round((cur - min) / step) + delta) % n) + n) % n
        v = min + idx * step
      } else v = clamp(cur + delta * step, Math.min(min, max), Math.max(min, max))
      this.setDialValue(i, +v.toFixed(6), page); this.scheduleRender()
      if (d.onChange) this.debounce('dial' + page + i, finite(d.debounceMs, 120), () => this.act(d.onChange, { value: this.dialValue(i, page), delta, index: i }, `dial ${i + 1} change`))
    } else if (mode === 'actions') {
      const a = delta > 0 ? d.onRight : d.onLeft
      if (a) for (let n = 0; n < Math.min(Math.abs(delta), 10); n++) await this.act(a, { delta: Math.sign(delta), index: i }, `dial ${i + 1} turn`)
    }
  }
  dialDown(i) {
    const d = this.pageView().dials[i]
    this.emit('input', { kind: 'dial', index: i, event: 'down' })
    this.trace({ ev: 'dial press', dial: i + 1, label: this.label('dial', i) })
    this.flashDial(i)
    if (d._press) return this.act(d._press, { index: i }, `dial ${i + 1} press`)
    if (d.onPress?.type && d.onPress.type !== 'none') return this.act(d.onPress, { value: this.dialValue(i), index: i }, `dial ${i + 1} press`)
    // sensible built-ins when no press action is configured
    if ((d.mode || 'value') === 'value' && d.default != null && !dialReadonly(d)) { // a read-only readout has nothing to reset
      const v = finite(d.default, 0); this.setDialValue(i, v); this.scheduleRender()
      if (d.onChange) this.act(d.onChange, { value: v, delta: 0, index: i })
    }
    if (d.mode === 'volume') {
      this.vol.muted = !this.vol.muted; this.volTouched = Date.now(); this.scheduleRender()
      osa(`set volume ${this.vol.muted ? 'with' : 'without'} output muted`)
    }
  }
  dialUp(i) { this.emit('input', { kind: 'dial', index: i, event: 'up' }) }
  // Read-only dial with `browse: { cmd }`: each turn steps through the command's output lines
  // ("name<TAB>value<TAB>note"), shown on the segment for a few seconds. The list is read once when a
  // browse starts (cheap, on demand, never polled) and kept while you keep turning, so it doesn't reshuffle.
  async dialBrowse(i, delta, d, page) {
    if (!isObj(d.browse) || !d.browse.cmd || !delta) return
    const bag = (this.browse[page] ??= [])
    let b = bag[i]
    if (!b || Date.now() > b.until || b.cmd !== d.browse.cmd) {
      const key = page + '\0' + i
      const busy = (this.browseBusy ??= Object.create(null))[key]
      if (busy) { busy.delta += delta; return } // turns while the list loads: applied once it's there
      const load = this.browseBusy[key] = { delta }
      let r
      try { r = await sh(String(d.browse.cmd)) } finally { delete this.browseBusy[key] }
      delta = load.delta
      const items = r.ok ? r.stdout.split('\n').map(l => l.split('\t').map(x => x.trim())).filter(c => c[0]).slice(0, BROWSE_MAX).map(([name, value = '', note = '']) => ({ name: name.slice(0, 60), value: value.slice(0, 16), note: note.slice(0, 40) })) : []
      if (!items.length) { this.notify(`dial ${i + 1}: browse ${r.ok ? 'printed nothing' : 'failed: ' + (r.stderr || '').slice(0, 80)}`, r.ok ? 'info' : 'error'); return }
      if (this.page !== page) return
      if (!delta) return
      b = bag[i] = { cmd: d.browse.cmd, items, i: delta > 0 ? -1 : items.length } // first turn lands on the top (or, turning back, the last) item
    }
    const n = b.items.length
    b.i = (((b.i + Math.sign(delta) * Math.min(Math.abs(delta), 3)) % n) + n) % n
    b.until = Date.now() + BROWSE_HOLD // after the await: a command slower than the hold still shows
    clearTimeout(b.timer)
    b.timer = setTimeout(() => { if (bag[i] === b) { delete bag[i]; this.scheduleRender() } }, BROWSE_HOLD + 50)
    this.scheduleRender()
  }
  browseView(page = this.page) {
    const bag = this.browse[page]
    if (!bag) return undefined
    return [0, 1, 2, 3].map(i => { const b = bag[i]; return b && Date.now() <= b.until ? { ...b.items[b.i], pos: b.i + 1, n: b.items.length } : null })
  }
  stripTap(x, y, long = false) {
    const view = this.pageView()
    x = clamp(finite(x, 0), 0, 799); y = clamp(finite(y, 50), 0, 99)
    this.emit('input', { kind: 'strip', event: long ? 'longtap' : 'tap', x, y })
    this.trace({ ev: long ? 'strip long tap' : 'strip tap', x: Math.round(x), segment: view.strip.mode === 'full' ? 'full' : Math.floor(x / SEG_W) + 1 })
    if (view.strip.mode === 'full') return this.act(long ? view.strip.onLongTap : view.strip.onTap, { x, y }, 'strip')
    const i = clamp(Math.floor(x / SEG_W), 0, 3)
    const d = view.dials[i]
    this.flashDial(i)
    this.act(long ? d.onLongTouch : d.onTouch, { value: this.dialValue(i), index: i, x: x - i * SEG_W, y }, `strip ${i + 1}${long ? ' long' : ''}`)
  }
  stripSwipe(from, to) {
    const view = this.pageView()
    const dx = finite(to?.x, 0) - finite(from?.x, 0)
    this.emit('input', { kind: 'strip', event: 'swipe', from, to })
    this.trace({ ev: 'strip swipe', dx: Math.round(dx) })
    if (Math.abs(dx) < 20) return
    const a = dx < 0 ? view.strip.onSwipeLeft : view.strip.onSwipeRight
    if (a?.type && a.type !== 'none') return this.act(a, { dx }, 'swipe')
    this.cyclePage(dx < 0 ? 1 : -1)
  }
  debounce(key, ms, fn) { clearTimeout(this.db[key]); this.db[key] = setTimeout(() => { delete this.db[key]; fn() }, ms) }

  // ---------- pollers (live data on keys/dials) ----------
  restartPollers() {
    this.timers.forEach(clearInterval); this.timers = []
    if (this.stopped || !this.hasPage(this.page)) return
    const id = this.page
    const view = this.pageView(id)
    this.live.pluginFocus(view)
    view.keys.forEach((k, i) => this.addPoller(k.poll, out => { ((this.keyVars[id] ??= [])[i] = { out }); this.scheduleRender() }))
    let volPoll = false
    view.dials.forEach((d, i) => {
      if (d.mode === 'volume') { volPoll = true; return }
      if (d.mode === 'brightness') return
      this.addPoller(d.poll, out => {
        ((this.dialVars[id] ??= [])[i] = { out })
        const n = parseFloat(out)
        if (d.display == null) this.setDialValue(i, isNaN(n) ? out : n, id)
        else if (!isNaN(n)) this.setDialValue(i, n, id)
        this.scheduleRender()
      })
    })
    if (volPoll) this.addPoller({ interval: 3, fn: () => this.refreshVolume() })
  }
  addPoller(poll, onOut) {
    if (!isObj(poll) || (!poll.fn && !poll.cmd)) return
    const runIt = poll.fn || (async () => { const r = await sh(String(poll.cmd)); if (r.ok) onOut(r.stdout.split('\n')[0].slice(0, 80)) })
    let busy = false
    const tick = async () => {
      if (busy || this.stopped) return
      busy = true
      try { await runIt() } catch (e) { this.notify(`poll failed: ${e.message}`, 'error') } finally { busy = false }
    }
    tick()
    this.timers.push(setInterval(tick, Math.max(1, finite(poll.interval, 5)) * 1000))
  }
  async refreshVolume() {
    const started = Date.now()
    const [v, m] = await Promise.all([getVolume(), osa('output muted of (get volume settings)')])
    if (v == null || started - (this.volTouched || 0) < 1500) return // user is turning the dial; don't fight them
    const muted = m.stdout === 'true'
    if (v !== this.vol.volume || muted !== this.vol.muted) { this.vol = { volume: v, muted }; this.scheduleRender() }
  }

  // ---------- device lifecycle ----------
  setStatus(state, detail = '') { this.status = { state, detail }; this.emit('status', this.status) }
  async connectLoop() {
    while (!this.stopped) {
      if (!this.device && !this.released) await this.tryConnect()
      await new Promise(r => setTimeout(r, 2500))
    }
  }
  tryConnect() { return (this.connecting ??= this._connect().finally(() => { this.connecting = null })) } // one at a time
  async _connect() {
    if (this.device || this.stopped || this.released) return
    const list = await listStreamDecks().catch(() => [])
    const info = list.find(d => d.model === 'plus') || list[0]
    if (!info) return this.setStatus('absent', 'No Stream Deck found — plug it in.')
    let dev
    try {
      dev = await openStreamDeck(info.path)
      await dev.setBrightness(this.brightness)
      await dev.clearPanel()
      if (this.stopped || this.released) { await dev.close().catch(() => {}); return }
      const safe = fn => (...a) => { try { const r = fn(...a); if (r?.catch) r.catch(e => this.notify(`input: ${e.message}`, 'error')) } catch (e) { this.notify(`input: ${e.message}`, 'error') } }
      dev.on('down', safe(c => c.type === 'button' ? this.keyDown(c.index) : this.dialDown(c.index)))
      dev.on('up', safe(c => c.type === 'button' ? this.keyUp(c.index) : this.dialUp(c.index)))
      dev.on('rotate', safe((c, amt) => this.dialRotate(c.index, amt)))
      dev.on('lcdShortPress', safe((c, p) => this.stripTap(p.x, p.y, false)))
      dev.on('lcdLongPress', safe((c, p) => this.stripTap(p.x, p.y, true)))
      dev.on('lcdSwipe', safe((c, a, b) => this.stripSwipe(a, b)))
      dev.on('error', e => this.onDeviceError(e, dev))
      this.devPushed.set(dev, new Map()) // panel was just cleared: everything must be pushed
      this.device = dev
      this.setStatus('connected', `${info.modelInfo.name} · ${info.serialNumber || ''}`)
      if (!this.introShown) { this.introShown = true; this.toast('turn · press dials · swipe strip for pages', 4000) } // once per server run
      this.scheduleRender()
    } catch (e) {
      if (dev && this.device !== dev) await dev.close().catch(() => {})
      const busy = /exclusive|already open/i.test(e.message)
      this.setStatus(busy ? 'busy' : 'error', busy ? 'The Elgato Stream Deck app holds the device. Use "Take over" to quit it.' : e.message)
    }
  }
  onDeviceError(e, dev) {
    if (!dev || dev !== this.device) return // stale error from a previous connection
    this.notify(`device: ${e?.message || e}`, 'error')
    this.device = null
    this.releaseAll()
    dev.close().catch(() => {})
    this.setStatus('absent', 'Device disconnected; retrying…')
  }
  async takeover() {
    this.released = false
    await osa('tell application "Elgato Stream Deck" to quit')
    for (let n = 0; n < 20 && !this.device; n++) { await new Promise(r => setTimeout(r, 500)); await this.tryConnect() }
    return this.status
  }
  async release({ launchElgato = true } = {}) {
    this.released = true
    await this.connecting
    const d = this.device
    if (d) { this.device = null; this.releaseAll(); await this.rendering; await d.resetToLogo().catch(() => {}); await d.close().catch(() => {}) }
    this.setStatus('released', 'Device released to the Elgato app.')
    if (launchElgato) await osa('tell application "Elgato Stream Deck" to launch')
    return this.status
  }
  async start() {
    this.live.start()
    this.restartPollers()
    this.scheduleRender()
    this.connectLoop()
  }
  async stop() {
    this.stopped = true
    this.live.stop()
    this.timers.forEach(clearInterval)
    for (const t of [this.toastTimer, this.activeTimer, ...Object.values(this.db)]) clearTimeout(t)
    this.releaseAll()
    if (this.wpTimer) { clearTimeout(this.wpTimer); this.writeProfile(this.profile) }
    await this.connecting
    const d = this.device; this.device = null
    await this.rendering
    if (d) { await d.resetToLogo().catch(() => {}); await d.close().catch(() => {}) }
  }
}
