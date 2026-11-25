// DemoEngine: a browser port of the parts of src/engine.mjs the editor needs — profile, pages,
// history, dial values, long-press, strip taps/swipes, toasts — rendering with the server's own
// src/render.mjs / render-spec.mjs and emitting the same messages the server's websocket sends.
// Actions that would touch a Mac (shell, keys, apps, audio, http…) are never run: they're shown.
import type { Profile } from "../app/store"
import { DemoLive } from "./live"
import { demoCapture } from "./capture"
import { dialReadonly, isVarValue, dialVarValue } from "@deck/dial-rules.mjs"
import { VAR_RE, cleanPluginsConfig } from "@deck/plugin-schema.mjs"
import { DemoPlugins } from "./plugins"
import { loadRenderer, preloadView, type Renderer } from "./runtime"

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Msg = { type: string; [k: string]: any }
type Action = { type?: string; [k: string]: any } | null | undefined

const LONG_PRESS_MS = 550
const SEG_W = 200
const MAX_IMAGE = 3 << 20
const IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const finite = (v: unknown, dflt: any) => {
  const n = Number(v)
  return v !== null && v !== "" && Number.isFinite(n) ? n : dflt
}
const isObj = (v: unknown): v is Record<string, any> => v != null && typeof v === "object" && !Array.isArray(v)
const has = (o: unknown, k: string) => o != null && Object.hasOwn(o as object, k)
// the engine's own rule (src/dial-rules.mjs): a live readout (poll, nothing using its value) can't be turned; `readonly` overrides
const BROWSE_HOLD = 5000
type BrowseItem = { name: string; value: string; note: string }
// what the system page's browse commands would list (the demo never runs a shell command)
const FAKE_BROWSE: Record<string, BrowseItem[]> = {
  cpu: [["WindowServer", "24", "pid 146"], ["Google Chrome Helper", "17", "pid 5901"], ["Safari", "9", "pid 812"], ["kernel_task", "6", "pid 0"], ["Claude", "4", "pid 2231"], ["Finder", "1", "pid 611"]].map(([name, value, note]) => ({ name, value, note })),
  mem: [["Google Chrome Helper", "6.2", "1.0 gb · pid 5901"], ["Claude", "4.8", "780 mb · pid 2231"], ["WindowServer", "3.1", "510 mb · pid 146"], ["Safari", "2.4", "390 mb · pid 812"], ["Finder", "0.9", "150 mb · pid 611"]].map(([name, value, note]) => ({ name, value, note })),
  disk: [["Macintosh HD", "61", "190 gb free"], ["Backup", "44", "1.1 tb free"]].map(([name, value, note]) => ({ name, value, note })),
}
const fakeBrowseKind = (cmd: string) => (/pmem|rss|vm_stat/.test(cmd) ? "mem" : /\bdf\b|Volumes/.test(cmd) ? "disk" : "cpu")

// mirrors src/actions.mjs ACTION_TYPES (that module spawns processes, so it can't load here)
export const ACTION_TYPES: Record<string, string[]> = {
  none: [], page: ["page"], back: [], shell: ["cmd"], open: ["target"], keys: ["combo"], type: ["text"], applescript: ["script"],
  shortcut: ["name", "input"], http: ["url", "method", "body"], media: ["command"], volume: ["step"], brightness: ["step"],
  multi: ["actions"], app: ["target"], "hold-keys": ["combo"], "agents-next": [], "mic-mute": ["mode"], "audio-input": ["device"], "audio-output": ["device"],
  plugin: ["plugin", "action", "args"],
  capture: ["mode", "to", "delay", "delayDial", "cursor", "sound", "audio", "clicks", "maxSeconds"],
}

function cleanImage(o: any) {
  if (isObj(o) && "image" in o && !(typeof o.image === "string" && o.image.length <= MAX_IMAGE && IMAGE_RE.test(o.image))) delete o.image
}
const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : [])
/** Same rules as normalizeProfile in src/engine.mjs. */
export function normalizeProfile(p: any): Profile {
  if (!isObj(p) || !isObj(p.pages)) throw new Error("profile must have pages")
  p.theme = isObj(p.theme) ? p.theme : {}
  p.brightness = clamp(finite(p.brightness, 70), 0, 100)
  if ("botProviders" in p) p.botProviders = (Array.isArray(p.botProviders) ? p.botProviders : [])
    .filter((c: any) => isObj(c) && typeof c.id === "string" && ["name", "cmd", "type"].every((k) => c[k] == null || typeof c[k] === "string"))
    .map((c: any) => ("schemes" in c ? { ...c, schemes: strs(c.schemes) } : c))
  if ("plugins" in p) p.plugins = cleanPluginsConfig(p.plugins)
  const pages: Record<string, any> = {}
  for (const [id, pg] of Object.entries<any>(p.pages)) {
    if (!isObj(pg)) throw new Error(`page "${id}" must be an object`)
    if (!id || id === "__proto__" || id.length > 64) throw new Error(`invalid page id "${id}"`)
    pg.name = String(pg.name ?? id)
    pg.keys = Array.from({ length: 8 }, (_, i) => (isObj(pg.keys?.[i]) ? pg.keys[i] : {}))
    pg.dials = Array.from({ length: 4 }, (_, i) => (isObj(pg.dials?.[i]) ? pg.dials[i] : {}))
    pg.strip = isObj(pg.strip) ? pg.strip : { mode: "segments" }
    pg.keys.forEach(cleanImage)
    pg.dials.forEach(cleanImage)
    cleanImage(pg.strip)
    // runtime-only `_press` / `_rotate`… (live overlays) are never persisted
    for (const c of [...pg.keys, ...pg.dials, pg.strip]) for (const k of Object.keys(c)) if (k.startsWith("_")) delete c[k]
    for (const f of ["providers", "bots"]) if (f in pg) pg[f] = strs(pg[f])
    pages[id] = pg
  }
  const ids = Object.keys(pages)
  if (!ids.length) throw new Error("profile needs at least one page")
  p.pages = pages
  if (!has(p.pages, p.startPage)) p.startPage = ids[0]
  return p as Profile
}

/** Something that shows frames: the real Stream Deck+ over WebHID (hid.ts). */
export interface DeckSink {
  key(i: number, rgba: Uint8ClampedArray): Promise<void>
  strip(rgba: Uint8ClampedArray): Promise<void>
  brightness(v: number): Promise<void>
}

export class DemoEngine {
  profile: Profile
  page: string
  history: string[] = []
  values: Record<string, (number | string | undefined)[]> = {}
  keyVars: Record<string, ({ out: string } | undefined)[]> = {}
  dialVars: Record<string, ({ out: string } | undefined)[]> = {}
  vol = { volume: 50, muted: false }
  brightness: number
  pressed = new Set<number>()
  longTimers = new Map<number, { timer: number; fired: boolean; onPress: Action; onLong?: Action }>()
  releaseFor = new Map<number, Action>()
  activeDial: number | null = null
  toastState: string | null = null
  status = { state: "demo", detail: "simulated in your browser" }
  logs: { level: string; msg: string; t: number }[] = []
  live: DemoLive
  plugins: DemoPlugins
  sink: DeckSink | null = null
  onSave: (p: Profile) => void = () => {}
  private listeners = new Set<(m: Msg) => void>()
  private R: Renderer | null = null
  private renderQueued = false
  private rendering: Promise<unknown> = Promise.resolve()
  private timers: number[] = []
  private db: Record<string, number> = {}
  private browse: Record<string, ({ items: BrowseItem[]; i: number; until: number; timer?: number } | undefined)[]> = {}
  private toastTimer = 0
  private activeTimer = 0
  private animTimer = 0
  private uiFrame: { keys: string[]; strip: string | null; dials?: any[] } = { keys: [], strip: null }
  private memo = new Map<string, string>() // controlId -> render input signature
  private sinkPushed = new Map<string, string>()
  private lastDials = ""
  private stopped = false

  constructor(profile: Profile) {
    this.profile = normalizeProfile(structuredClone(profile))
    this.page = this.profile.startPage
    this.brightness = this.profile.brightness
    this.live = new DemoLive(this)
    this.plugins = new DemoPlugins(this)
  }
  async start() {
    this.R = await loadRenderer()
    this.live.start()
    this.restartPollers()
    this.scheduleRender()
    this.toast("turn · press dials · swipe strip for pages", 4000)
  }
  stop() {
    this.stopped = true
    this.live.stop()
    this.timers.forEach(clearInterval)
  }
  subscribe(fn: (m: Msg) => void) {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  private emit(m: Msg) {
    this.listeners.forEach((l) => l(m))
  }
  hasPage(id: string) {
    return has(this.profile.pages, id)
  }
  state() {
    return { profile: this.profile, page: this.page, status: this.status, brightness: this.brightness, actionTypes: ACTION_TYPES, overlay: {}, logs: this.logs.slice(-50) }
  }
  hello(): Msg {
    return { type: "hello", ...structuredClone(this.state()), frame: this.fullFrame() }
  }
  fullFrame() {
    return { keys: Object.fromEntries(this.uiFrame.keys.map((k, i) => [i, k])), strip: this.uiFrame.strip, dials: this.uiFrame.dials, page: this.page }
  }
  setStatus(state: string, detail = "") {
    this.status = { state, detail }
    this.emit({ type: "status", status: this.status })
  }

  // ---------- profile ----------
  setProfile(p: Profile, origin = "") {
    p = normalizeProfile(structuredClone(p))
    const old = this.profile
    this.profile = p
    for (const bag of [this.values, this.dialVars, this.keyVars, this.browse]) for (const id of Object.keys(bag)) if (!this.hasPage(id)) delete bag[id]
    for (const [id, pg] of Object.entries(p.pages)) {
      const was = has(old.pages, id) ? old.pages[id] : null
      pg.keys.forEach((k, i) => { if (JSON.stringify(k) !== JSON.stringify(was?.keys[i])) delete this.keyVars[id]?.[i] })
      pg.dials.forEach((d, i) => {
        if (JSON.stringify(d) === JSON.stringify(was?.dials[i])) return
        delete this.dialVars[id]?.[i]
        delete this.browse[id]?.[i]
        const w = was?.dials[i] || {}
        if (d.mode !== w.mode || d.min !== w.min || d.max !== w.max || JSON.stringify(d.poll) !== JSON.stringify(w.poll)) delete this.values[id]?.[i]
      })
    }
    if (p.brightness !== this.brightness) this.setBrightness(p.brightness, false)
    this.history = this.history.filter((id) => this.hasPage(id))
    if (!this.hasPage(this.page)) {
      this.page = p.startPage
      this.emit({ type: "page", page: this.page })
    }
    this.onSave(this.profile)
    this.restartPollers()
    this.scheduleRender()
    this.emit({ type: "profile", profile: structuredClone(p), origin })
  }

  // ---------- resolved view ----------
  pageView(id = this.page) {
    const pg = this.profile.pages[id]
    let gen: { keys?: any[]; dials?: any[]; strip?: any } | null = null
    if (pg.source) gen = this.live.sourceView(pg)
    return {
      ...pg,
      keys: pg.keys.map((k, i) => this.live.decorate({ ...(gen?.keys?.[i] || k) })),
      dials: pg.dials.map((d, i) => ({ ...(gen?.dials?.[i] || d) })),
      strip: { ...pg.strip, ...(gen?.strip || {}) },
    }
  }
  dialValue(i: number, id = this.page): number | string | null {
    const d = this.pageView(id).dials[i]
    if (d.mode === "brightness") return this.brightness
    if (d.mode === "volume") return this.vol.muted ? "Muted" : this.vol.volume
    if (isVarValue(d.value)) return dialVarValue(d.value, this.live.vars() as Record<string, unknown>) // "{plugin.value}": follows the live var
    const v = this.values[id]?.[i]
    if (v !== undefined) return v
    if (d.value != null) return d.value
    return (d.mode || "value") === "value" && !d.poll ? finite(d.min, 0) : null
  }
  setDialValue(i: number, v: number | string, id = this.page) {
    ;(this.values[id] ??= [])[i] = v
  }

  // ---------- navigation / feedback ----------
  goto(id: string) {
    if (!this.hasPage(id)) return this.notify(`no page "${id}"`, "error")
    if (id === this.page) return
    this.history.push(this.page)
    if (this.history.length > 50) this.history.shift()
    this.switchTo(id)
  }
  switchTo(id: string) {
    this.page = id
    this.restartPollers()
    this.scheduleRender()
    this.emit({ type: "page", page: id })
  }
  back() {
    const id = this.history.pop()
    if (id && this.hasPage(id)) this.switchTo(id)
  }
  pageOrder() {
    return Object.keys(this.profile.pages).filter((id) => !this.profile.pages[id].hidden)
  }
  cyclePage(dir: number) {
    const order = this.pageOrder()
    if (!order.length) return
    const i = order.indexOf(this.page)
    const next = i < 0 ? order[0] : order[(i + dir + order.length) % order.length]
    if (next === this.page) return
    this.goto(next)
    this.toast(this.profile.pages[this.page].name, 900)
  }
  toast(text: unknown, ms = 1200) {
    clearTimeout(this.toastTimer)
    this.toastState = String(text ?? "").slice(0, 200)
    this.toastTimer = window.setTimeout(() => {
      this.toastState = null
      this.scheduleRender()
    }, ms)
    this.scheduleRender()
  }
  notify(msg: string, level = "info") {
    const l = { level, msg, t: Date.now() }
    this.logs.push(l)
    if (this.logs.length > 200) this.logs.shift()
    this.emit({ type: "log", log: l })
  }
  /** The demo's answer to anything that would touch a real Mac. */
  wouldRun(desc: string) {
    this.toast(`would run: ${desc}`, 1800)
    this.notify(`demo · would run: ${desc}`)
  }
  describeAction(a: Action) {
    if (!a || !a.type) return "none"
    if (a.type === "internal") return a.desc || "built-in"
    if (a.type === "plugin") return `plugin ${a.plugin}.${a.action}`
    const arg = a.page ?? a.target ?? a.combo ?? a.cmd ?? a.url ?? a.script ?? a.name ?? a.command ?? a.device ?? a.mode ?? a.step ?? a.text ?? ""
    return `${a.type}${arg !== "" ? " " + String(arg).slice(0, 80) : ""}`
  }
  async setBrightness(v: unknown, persist = true) {
    this.brightness = clamp(Math.round(finite(v, this.brightness)), 0, 100)
    this.sink?.brightness(this.brightness).catch(() => {})
    if (persist) {
      this.profile.brightness = this.brightness
      this.onSave(this.profile)
    }
    this.emit({ type: "brightness", brightness: this.brightness })
    this.scheduleRender()
    return this.brightness
  }

  // ---------- rendering ----------
  scheduleRender() {
    if (this.renderQueued || this.stopped || !this.R) return
    this.renderQueued = true
    setTimeout(() => {
      this.renderQueued = false
      this.rendering = this.rendering.then(() => this.render()).catch((e) => this.notify(`render: ${e.message}`, "error"))
    }, 12)
  }
  /** Re-push everything to a freshly connected device. */
  resync() {
    this.sinkPushed.clear()
    this.memo.clear()
    this.scheduleRender()
  }
  private async safe(id: string, fn: () => Promise<HTMLCanvasElement>, w: number, h: number) {
    try {
      return await fn()
    } catch (e) {
      this.notify(`render ${id}: ${(e as Error).message}`, "error")
      return this.R!.renderError(w, h, (e as Error).message)
    }
  }
  private async render() {
    const R = this.R
    if (this.stopped || !R || !this.hasPage(this.page)) return
    const view = this.pageView()
    const theme = this.profile.theme
    await preloadView(view)
    const liveVars = this.live.vars()
    const changed: { keys: Record<string, string>; strip: string | null } = { keys: {}, strip: null }
    const sink = this.sink
    const isAnim = (k: any) => !!k && (k.sprite || k.motion || (typeof k.image === "string" && k.image.startsWith("data:image/gif")))
    const animated = theme.style === "spec" && view.keys.some(isAnim)
    const t = animated ? Date.now() : 0
    if (animated && !this.animTimer && !this.stopped) this.animTimer = window.setTimeout(() => { this.animTimer = 0; this.scheduleRender() }, 80)
    const out = async (id: string, sig: string, draw: () => Promise<HTMLCanvasElement>, w: number, h: number) => {
      // skip controls whose inputs didn't change (functions in generated controls don't stringify)
      if (this.memo.get(id) === sig && (!sink || this.sinkPushed.get(id) === sig)) return
      const c = await this.safe(id, draw, w, h)
      const url = c.toDataURL("image/png")
      if (id === "strip") {
        if (this.uiFrame.strip !== url) changed.strip = this.uiFrame.strip = url
      } else {
        const i = Number(id.slice(1))
        if (this.uiFrame.keys[i] !== url) changed.keys[i] = this.uiFrame.keys[i] = url
      }
      this.memo.set(id, sig)
      if (sink && this.sinkPushed.get(id) !== sig) {
        const rgba = c.getContext("2d")!.getImageData(0, 0, w, h).data
        try {
          await (id === "strip" ? sink.strip(rgba) : sink.key(Number(id.slice(1)), rgba))
          if (this.sink === sink) this.sinkPushed.set(id, sig)
        } catch {
          /* hid.ts reports and disconnects */
        }
      }
    }
    const themeSig = JSON.stringify(theme)
    for (let i = 0; i < 8; i++) {
      const vars = { page: view.name, ...liveVars, ...(this.keyVars[this.page]?.[i] || {}) }
      const pressed = this.pressed.has(i)
      const key = view.keys[i]
      const kt = isAnim(key) ? t : 0
      const sig = JSON.stringify([key, vars, pressed, kt, themeSig])
      await out("k" + i, sig, () => R.renderKey(key, theme, { t: kt, pressed, vars }), 120, 120)
    }
    const values = [0, 1, 2, 3].map((i) => this.dialValue(i))
    const sopts = { active: this.activeDial, toast: this.toastState, swipe: this.pageOrder().length > 1 || !!(view.strip.onSwipeLeft || view.strip.onSwipeRight), vars: { page: view.name, ...liveVars }, dialVars: this.dialVars[this.page] || [], browse: this.browseView() }
    const ssig = JSON.stringify([view.strip, view.dials, values, sopts, themeSig])
    await out("strip", ssig, () => R.renderStrip(view.strip, view.dials, values, theme, sopts), 800, 100)
    const dials = view.dials.map((d: any, i: number) => {
      const v = values[i]
      const ro = typeof d._rotate !== "function" && dialReadonly(d)
      const fixed = d.mode === "volume" || d.mode === "brightness"
      const lo = fixed ? 0 : finite(d.min, 0)
      const hi = fixed ? 100 : finite(d.max, 100)
      const num = typeof v === "number" && isFinite(v)
      return {
        label: String(d.label || "").replace(VAR_RE, ""),
        value: num ? +v.toFixed(2) : v ?? null,
        pct: num && hi > lo ? clamp((v - lo) / (hi - lo), 0, 1) : null,
        turns: ro ? !!d.browse?.cmd : !!(d._rotate || d.mode || d.onLeft || d.onRight || d.onChange),
        ...(ro ? { readonly: true } : {}),
      }
    })
    const dj = JSON.stringify(dials)
    const dialsChanged = dj !== this.lastDials
    if (dialsChanged) {
      this.lastDials = dj
      this.uiFrame.dials = dials
    }
    if (Object.keys(changed.keys).length || changed.strip || dialsChanged)
      this.emit({ type: "frame", keys: changed.keys, ...(changed.strip ? { strip: changed.strip } : {}), ...(dialsChanged ? { dials } : {}), page: this.page })
  }

  // ---------- actions ----------
  async act(action: Action, vars: Record<string, unknown> = {}) {
    if (!isObj(action) || !action.type || action.type === "none") return
    try {
      await this.run(action, vars)
    } catch (e) {
      this.notify(`action ${action.type} failed: ${(e as Error).message}`, "error")
    }
  }
  private async run(a: Record<string, any>, vars: Record<string, unknown>): Promise<void> {
    switch (a.type) {
      case "internal":
        await a.run?.(vars)
        return
      case "page":
        return this.goto(String(a.page))
      case "back":
        return this.back()
      case "multi":
        for (const x of Array.isArray(a.actions) ? a.actions : []) await this.run(x, vars)
        return
      case "brightness":
        await this.setBrightness(this.brightness + finite(a.step, 10))
        return
      case "volume":
        this.vol.volume = clamp(this.vol.volume + finite(a.step, 5), 0, 100)
        this.vol.muted = false
        this.scheduleRender()
        return
      case "capture":
        return demoCapture(a, vars, this)
      case "plugin": {
        const inner = this.plugins.action(a)
        return inner ? this.run(inner, vars) : this.wouldRun(this.describeAction(a))
      }
      case "agents-next":
        return this.live.goMostUrgent()
      case "mic-mute":
        return this.live.toggleMic()
      case "audio-input":
      case "audio-output":
        return this.live.setDefault(a.type === "audio-input" ? "input" : "output", String(a.device || ""))
      case "open": {
        const target = String(a.target || "")
        if (/^https?:\/\//i.test(target)) {
          window.open(target, "_blank", "noopener,noreferrer")
          this.notify(`opened ${target} in a new tab`)
          return
        }
        return this.wouldRun(this.describeAction(a))
      }
      default:
        // shell, keys, type, applescript, shortcut, http, media, app, hold-keys, … : never executed
        return this.wouldRun(this.describeAction(a))
    }
  }

  // ---------- input (same handlers as hardware) ----------
  private input(e: Record<string, unknown>) {
    this.emit({ type: "input", input: e })
  }
  keyDown(i: number) {
    const key = this.pageView().keys[i]
    const prev = this.longTimers.get(i)
    if (prev) {
      clearTimeout(prev.timer)
      this.longTimers.delete(i)
    }
    this.pressed.add(i)
    this.scheduleRender()
    this.input({ kind: "key", index: i, event: "down" })
    if (key.onRelease) this.releaseFor.set(i, key.onRelease)
    else this.releaseFor.delete(i)
    if (key.onPress?.type === "hold-keys") return this.wouldRun(`hold-keys ${key.onPress.combo} (while held)`)
    if (key.onLongPress?.type && key.onLongPress.type !== "none") {
      const entry = { fired: false, onPress: key.onPress as Action, onLong: key.onLongPress as Action, timer: 0 }
      entry.timer = window.setTimeout(() => {
        entry.fired = true
        this.act(key.onLongPress, { index: i })
      }, LONG_PRESS_MS)
      this.longTimers.set(i, entry)
    } else {
      this.longTimers.delete(i)
      this.act(key.onPress, { index: i })
    }
  }
  keyUp(i: number) {
    this.pressed.delete(i)
    this.scheduleRender()
    this.input({ kind: "key", index: i, event: "up" })
    const t = this.longTimers.get(i)
    if (t) {
      this.longTimers.delete(i)
      if (!t.fired) {
        clearTimeout(t.timer)
        // a hold-only key: say so instead of silently doing nothing
        if (!t.onPress?.type || t.onPress.type === "none") this.toast(`hold to ${t.onLong?.type === "page" ? `open ${t.onLong.page}` : String(t.onLong?.type || "use")}`, 1400)
        else this.act(t.onPress, { index: i })
      }
    }
    const rel = this.releaseFor.get(i)
    if (rel) {
      this.releaseFor.delete(i)
      this.act(rel, { index: i })
    }
  }
  releaseAll() {
    for (const t of this.longTimers.values()) clearTimeout(t.timer)
    this.longTimers.clear()
    this.pressed.clear()
    for (const [i, rel] of this.releaseFor) this.act(rel, { index: i }) // keys still down: run their onRelease
    this.releaseFor.clear()
    this.scheduleRender()
  }
  private flashDial(i: number) {
    this.activeDial = i
    clearTimeout(this.activeTimer)
    this.activeTimer = window.setTimeout(() => {
      this.activeDial = null
      this.scheduleRender()
    }, 700)
    this.scheduleRender()
  }
  private debounce(key: string, ms: number, fn: () => void) {
    clearTimeout(this.db[key])
    this.db[key] = window.setTimeout(() => {
      delete this.db[key]
      fn()
    }, ms)
  }
  async dialRotate(i: number, delta: number) {
    const d = this.pageView().dials[i]
    const page = this.page
    const ro = typeof d._rotate !== "function" && dialReadonly(d)
    this.input({ kind: "dial", index: i, event: "rotate", delta, ...(ro ? { readonly: true } : {}) })
    this.flashDial(i)
    if (typeof d._rotate === "function") return d._rotate(Math.sign(delta) * Math.min(Math.abs(delta), 5))
    if (ro) return this.dialBrowse(i, delta, d, page) // a live readout: the value is never turned
    const mode = d.mode || "value"
    if (mode === "volume") {
      this.vol.volume = clamp(this.vol.volume + delta * finite(d.step, 2), 0, 100)
      this.vol.muted = false
      this.scheduleRender()
    } else if (mode === "brightness") {
      await this.setBrightness(this.brightness + delta * finite(d.step, 5))
    } else if (mode === "value") {
      const min = finite(d.min, 0)
      const max = finite(d.max, 100)
      const step = Math.abs(finite(d.step, 1)) || 1
      const cur = finite(this.dialValue(i, page), min)
      let v: number
      if (d.wrap && max > min) {
        const n = Math.floor((max - min) / step) + 1
        const idx = (((Math.round((cur - min) / step) + delta) % n) + n) % n
        v = min + idx * step
      } else v = clamp(cur + delta * step, Math.min(min, max), Math.max(min, max))
      this.setDialValue(i, +v.toFixed(6), page)
      this.scheduleRender()
      if (d.onChange) this.debounce("dial" + page + i, finite(d.debounceMs, 120), () => this.act(d.onChange, { value: this.dialValue(i, page), delta, index: i }))
    } else if (mode === "actions") {
      const a = delta > 0 ? d.onRight : d.onLeft
      if (a) for (let n = 0; n < Math.min(Math.abs(delta), 10); n++) await this.act(a, { delta: Math.sign(delta), index: i })
    }
  }
  dialDown(i: number) {
    const d = this.pageView().dials[i]
    this.input({ kind: "dial", index: i, event: "down" })
    this.flashDial(i)
    if (d._press) return this.act(d._press, { index: i })
    if (d.onPress?.type && d.onPress.type !== "none") return this.act(d.onPress, { value: this.dialValue(i), index: i })
    if ((d.mode || "value") === "value" && d.default != null && !dialReadonly(d)) {
      const v = finite(d.default, 0)
      this.setDialValue(i, v)
      this.scheduleRender()
      if (d.onChange) this.act(d.onChange, { value: v, delta: 0, index: i })
    }
    if (d.mode === "volume") {
      this.vol.muted = !this.vol.muted
      this.scheduleRender()
    }
  }
  dialUp(i: number) {
    this.input({ kind: "dial", index: i, event: "up" })
  }
  // read-only dial with `browse`: turns step through a (simulated) list, shown on the segment for a few seconds
  private dialBrowse(i: number, delta: number, d: any, page: string) {
    if (!isObj(d.browse) || !d.browse.cmd || !delta) return
    const bag = (this.browse[page] ??= [])
    let b = bag[i]
    const now = Date.now()
    if (!b || now > b.until) {
      const items = FAKE_BROWSE[fakeBrowseKind(String(d.browse.cmd))]
      b = bag[i] = { items, i: delta > 0 ? -1 : items.length, until: 0 }
    }
    const n = b.items.length
    b.i = (((b.i + Math.sign(delta) * Math.min(Math.abs(delta), 3)) % n) + n) % n
    b.until = now + BROWSE_HOLD
    clearTimeout(b.timer)
    const cur = b
    b.timer = window.setTimeout(() => {
      if (bag[i] === cur) {
        delete bag[i]
        this.scheduleRender()
      }
    }, BROWSE_HOLD + 50)
    this.scheduleRender()
  }
  private browseView(page = this.page) {
    const bag = this.browse[page]
    if (!bag) return undefined
    return [0, 1, 2, 3].map((i) => {
      const b = bag[i]
      return b && Date.now() <= b.until ? { ...b.items[b.i], pos: b.i + 1, n: b.items.length } : null
    })
  }
  stripTap(x: unknown, y: unknown, long = false) {
    const view = this.pageView()
    const px = clamp(finite(x, 0), 0, 799)
    const py = clamp(finite(y, 50), 0, 99)
    this.input({ kind: "strip", event: long ? "longtap" : "tap", x: px, y: py })
    if (view.strip.mode === "full") return this.act(long ? view.strip.onLongTap : view.strip.onTap, { x: px, y: py })
    const i = clamp(Math.floor(px / SEG_W), 0, 3)
    const d = view.dials[i]
    this.flashDial(i)
    this.act(long ? d.onLongTouch : d.onTouch, { value: this.dialValue(i), index: i, x: px - i * SEG_W, y: py })
  }
  stripSwipe(from: { x: number; y: number }, to: { x: number; y: number }) {
    const view = this.pageView()
    const dx = finite(to?.x, 0) - finite(from?.x, 0)
    this.input({ kind: "strip", event: "swipe", from, to })
    if (Math.abs(dx) < 20) return
    const a = dx < 0 ? view.strip.onSwipeLeft : view.strip.onSwipeRight
    if (a?.type && a.type !== "none") return this.act(a, { dx })
    this.cyclePage(dx < 0 ? 1 : -1)
  }

  // ---------- simulated polls (never a shell command) ----------
  restartPollers() {
    this.timers.forEach(clearInterval)
    this.timers = []
    if (this.stopped || !this.hasPage(this.page)) return
    const id = this.page
    const view = this.pageView(id)
    view.keys.forEach((k: any, i: number) =>
      this.addPoller(k.poll, (out) => {
        ;(this.keyVars[id] ??= [])[i] = { out }
        this.scheduleRender()
      }),
    )
    view.dials.forEach((d: any, i: number) => {
      if (d.mode === "volume" || d.mode === "brightness") return
      this.addPoller(d.poll, (out) => {
        ;(this.dialVars[id] ??= [])[i] = { out }
        const n = parseFloat(out)
        if (d.display == null) this.setDialValue(i, isNaN(n) ? out : n, id)
        else if (!isNaN(n)) this.setDialValue(i, n, id)
        this.scheduleRender()
      })
    })
  }
  private walk: Record<string, number> = { cpu: 18, mem: 46, disk: 61 }
  private fakePoll(kind: string) {
    if (kind === "clock") {
      const d = new Date()
      return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`
    }
    const spread = kind === "cpu" ? 9 : kind === "mem" ? 3 : 0.3
    const v = clamp((this.walk[kind] ?? 30) + (Math.random() - 0.5) * spread * 2, 3, 97)
    this.walk[kind] = v
    return String(Math.round(v))
  }
  private addPoller(poll: any, onOut: (out: string) => void) {
    if (!isObj(poll) || (!poll.demo && !poll.cmd)) return
    // a command typed in the demo is never run: it reports what would run and shows a sample value
    const cmd = String(poll.cmd || "")
    const kind = poll.demo ? String(poll.demo) : /date/.test(cmd) ? "clock" : /memory_pressure|vm_stat/.test(cmd) ? "mem" : /\bdf\b/.test(cmd) ? "disk" : "cpu"
    if (poll.cmd && !poll.demo) this.notify(`demo · would poll: ${String(poll.cmd).slice(0, 80)}`)
    const tick = () => onOut(this.fakePoll(kind))
    tick()
    this.timers.push(window.setInterval(tick, Math.max(1, finite(poll.interval, 5)) * 1000))
  }
}
