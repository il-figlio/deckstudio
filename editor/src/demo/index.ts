// The demo transport: answers the editor's /api routes and streams the server's message shapes
// from an in-browser DemoEngine, so store.ts works unchanged on a static site.
import { RECIPES, fillTemplate } from "@deck/recipes.mjs"
import { defaultProfile } from "@deck/default-profile.mjs"
import type { Profile } from "../app/store"
import { DemoEngine, type Msg } from "./engine"
import { importBots } from "./live"
import { scrubPublic, demoProfile, fakeAgents, fakeAudio, fakeRunning } from "./fixtures"
import { ALL_GLYPHS, CUSTOM_GLYPHS, LOGO_FILES, addUserLogo, userLogos } from "./runtime"

/* eslint-disable @typescript-eslint/no-explicit-any */
const STORE_KEY = "deckstudio-demo-profile-v1"
const NOT_HERE = "not available in the browser demo — install DeckStudio locally for this"

function loadSaved(): Profile | null {
  try {
    const s = localStorage.getItem(STORE_KEY)
    return s ? (JSON.parse(s) as Profile) : null
  } catch {
    return null
  }
}
function writeSaved(p: Profile) {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(p))
  } catch {
    /* private mode / quota: the demo still works, it just won't remember */
  }
}
const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 })

export class DemoTransport {
  engine: DemoEngine
  private saveTimer = 0
  constructor() {
    const saved = loadSaved()
    try {
      this.engine = new DemoEngine(saved || demoProfile())
    } catch {
      this.engine = new DemoEngine(demoProfile())
    }
    this.engine.onSave = (prof) => {
      clearTimeout(this.saveTimer)
      this.saveTimer = window.setTimeout(() => writeSaved(prof), 300)
    }
  }
  start() {
    return this.engine.start()
  }
  subscribe(fn: (m: Msg) => void) {
    return this.engine.subscribe(fn)
  }
  hello() {
    return this.engine.hello()
  }
  saveNow(p: Profile) {
    try {
      this.engine.setProfile(p, "pagehide")
    } catch {
      /* invalid profile: keep the last good one */
    }
    clearTimeout(this.saveTimer)
    writeSaved(this.engine.profile)
  }
  /** Back to the starter profile and fresh fake agents / bots. */
  reset() {
    try {
      localStorage.removeItem(STORE_KEY)
    } catch {
      /* ignore */
    }
    const live = this.engine.live
    live.agents = fakeAgents()
    // a reset keeps the visitor's own imported bots (they're theirs); samples go back to none
    live.audio = fakeAudio()
    live.filter = live.selId = null
    this.engine.history = []
    this.engine.values = {}
    this.engine.setProfile(demoProfile(), "demo-reset")
    this.engine.switchTo(this.engine.profile.startPage)
    this.engine.setBrightness(this.engine.profile.brightness, false)
  }

  async api(method: string, url: string, body: any = {}, clientId = ""): Promise<any> {
    const u = new URL(url, location.origin)
    const e = this.engine
    const b = body ?? {}
    switch (`${method.toUpperCase()} ${u.pathname}`) {
      case "GET /api/state":
        return structuredClone(e.state())
      case "PUT /api/profile":
        e.setProfile(b, clientId)
        return { ok: true }
      case "POST /api/goto":
        e.goto(String(b.page))
        return { page: e.page }
      case "POST /api/brightness":
        return { brightness: await e.setBrightness(b.value) }
      case "POST /api/run":
        await e.act(b.action, { index: b.index, value: b.value })
        return { ok: true }
      case "POST /api/toast":
        e.toast(b.text, Math.min(Number(b.ms) || 1500, 30000))
        return { ok: true }
      case "POST /api/sim": {
        const i = Number(b.index)
        switch (b.event) {
          case "keyDown": e.keyDown(i); break
          case "keyUp": e.keyUp(i); break
          case "rotate": await e.dialRotate(i, Math.max(-10, Math.min(10, Number(b.delta) || 0))); break
          case "dialDown": e.dialDown(i); break
          case "dialUp": e.dialUp(i); break
          case "tap": e.stripTap(b.x, b.y, !!b.long); break
          case "swipe": e.stripSwipe({ x: Number(b.fromX), y: 50 }, { x: Number(b.toX), y: 50 }); break
          default: throw bad("unknown sim event")
        }
        return { ok: true }
      }
      case "GET /api/glyphs": {
        const q = (u.searchParams.get("q") || "").toLowerCase().trim()
        const words = q.split(/[\s-]+/).filter(Boolean)
        const hits = ALL_GLYPHS.filter((n) => words.every((w) => n.toLowerCase().includes(w))) // names keep their case (4K); search ignores it
        const own = (n: string) => (CUSTOM_GLYPHS.has(n) ? 1 : 0)
        hits.sort((a, c) => own(c) - own(a) || (a.toLowerCase().startsWith(q) ? 0 : 1) - (c.toLowerCase().startsWith(q) ? 0 : 1) || a.length - c.length)
        return { total: hits.length, names: hits.slice(0, 60) }
      }
      case "GET /api/logos":
        return {
          logos: [
            ...[...userLogos].map(([name, url]) => ({ name, file: `${name}.png`, url })),
            ...LOGO_FILES.map((f) => ({ name: f.replace(/\.(png|svg)$/, ""), file: f })),
          ],
        }
      case "POST /api/logos/save": {
        const raw = String(b?.name || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)
        if (!raw) throw bad("name needs letters or digits")
        const url = String(b?.dataUrl || "")
        if (!url.startsWith("data:image/png;base64,") || url.length > 2.8e6) throw bad("png data URL only, up to 2 MB")
        const name = raw.startsWith("custom-") ? raw : `custom-${raw}`
        addUserLogo(name, url)
        return { name }
      }
      case "GET /api/apps":
        return {
          front: e.live.front,
          running: fakeRunning.map(({ logo, ...a }) => ({ ...a, icon: LOGO_FILES.includes(`${logo}.png`) ? `/logos/${logo}.png` : null })),
        }
      case "POST /api/logos/from-app": {
        // the demo can't read installed apps: hand back the bundled icon for the apps it pretends run
        const a = fakeRunning.find((x) => x.bundleId === String(b?.bundleId || ""))
        if (!a || !LOGO_FILES.includes(`${a.logo}.png`)) throw bad(NOT_HERE)
        return { name: a.logo }
      }
      case "GET /api/audio":
        return structuredClone(e.live.audio)
      case "GET /api/agents":
        return e.live.agentsSummary()
      // agent alerting: nothing reaches the visitor's machine; sessions are the made-up ones in fixtures.ts
      case "POST /api/agents":
      case "POST /api/agents/status":
      case "POST /api/agents/hook":
      case "POST /api/agents/remove":
        throw bad(NOT_HERE)
      // bring your own bots: only what the visitor imports (kept in this browser) or the samples
      case "GET /api/bots":
        return e.live.summary(u.searchParams.get("provider") || undefined)
      case "GET /api/grokbots":
        return { available: true, ...e.live.summary("grokbot") }
      case "POST /api/bots":
      case "POST /api/bots/import":
      case "POST /api/grokbots/import": {
        const text = typeof b?.text === "string" ? b.text : JSON.stringify(b ?? {})
        let r
        try { r = importBots(text, e.live.botSource === "imported" ? { bots: e.live.bots, providers: e.live.botProviders } : { bots: [], providers: [] }) } catch (err) { throw bad(`couldn't read that: ${(err as Error).message}`) }
        e.live.setBots(r.bots, "imported", r.providers)
        return { count: r.count, imported: r.count }
      }
      case "POST /api/bots/remove": {
        const p = String(b?.provider || "")
        const bots = e.live.bots.filter((x) => x.provider !== p), providers = e.live.botProviders.filter((x) => x.id !== p)
        e.live.setBots(bots, bots.length ? e.live.botSource : "none", providers); return { removed: 1 }
      }
      case "POST /api/bots/sample":
      case "POST /api/grokbots/sample":
        e.live.useSamples(); return { ok: true }
      case "POST /api/bots/clear":
      case "POST /api/grokbots/clear":
        e.live.setBots([], "none"); return { ok: true }
      case "POST /api/bots/status":
        throw bad(NOT_HERE)
      case "GET /api/recipes":
        return { recipes: scrubPublic([...RECIPES, ...e.plugins.recipes()]) }
      case "GET /api/plugins":
        return e.plugins.summary()
      // marketplace: a build-time copy of the public registry; installs live in this browser only
      case "GET /api/plugins/registry":
        return e.plugins.registry()
      case "POST /api/plugins/install":
        if (b?.path) throw bad(NOT_HERE)
        return e.plugins.install(String(b?.id || ""))
      case "POST /api/plugins/uninstall":
        return e.plugins.uninstall(String(b?.id || ""))
      case "POST /api/plugins/rescan":
        return e.plugins.summary()
      case "POST /api/recipes/apply":
        return this.applyRecipe(b, clientId)
      case "POST /api/takeover":
      case "POST /api/release":
      case "POST /api/connect":
        throw bad('in the demo, use "connect stream deck" (Chrome / Edge) to drive a real device')
      case "POST /api/control":
      case "POST /api/overlay/clear":
        throw bad(NOT_HERE)
      default: {
        const pm = /^\/api\/plugins\/([a-z0-9][a-z0-9-]{0,31})(?:\/([a-z]+))?$/.exec(u.pathname)
        if (pm && method.toUpperCase() === "GET" && !pm[2]) return e.plugins.one(pm[1])
        if (pm && pm[2] === "action") { await e.act({ type: "plugin", plugin: pm[1], action: String(b.action || ""), args: b.args }, { value: b.value }); return { ok: true } }
        if (pm && pm[2] === "enable") return e.plugins.enable(pm[1], b?.enabled !== false)
        if (pm && pm[2] === "grant") { try { return e.plugins.grant(pm[1], b) } catch (err) { throw bad((err as Error).message) } }
        if (pm && pm[2] === "settings") { try { return e.plugins.setSettings(pm[1], b?.settings) } catch (err) { throw bad((err as Error).message) } }
        if (pm && pm[2] === "refresh") return e.plugins.one(pm[1])
        if (pm) throw bad(NOT_HERE)
        throw Object.assign(new Error(`demo: no route ${method} ${u.pathname}`), { status: 404 })
      }
    }
  }

  private applyRecipe(b: any, origin: string) {
    const e = this.engine
    const r = [...RECIPES, ...e.plugins.recipes()].find((x) => x.id === b.id)
    if (!r) throw bad("no such recipe")
    if (!r.template) throw bad("this recipe is a prompt only — copy it to your agent")
    if ((r as any).plugin && (r as any).pluginEnabled === false) throw bad(`the ${(r as any).plugin} plugin is off: switch it on in the plugins tab before adding its keys`)
    const vars = Object.fromEntries(Object.entries<any>(b.vars || {}).map(([k, v]) => [k, String(v).slice(0, 300)]))
    const p = structuredClone(e.profile)
    if (r.where === "page") {
      const tpl = typeof r.template === "string" ? structuredClone(defaultProfile().pages[r.template]) : fillTemplate(r.template, vars)
      let id = String(b.pageId || tpl.name || r.id).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page"
      const base = id
      let n = 2
      while (Object.hasOwn(p.pages, id)) id = `${base}-${n++}`
      p.pages[id] = scrubPublic(tpl)
      e.setProfile(p, origin)
      return { page: id }
    }
    const page = b.page || e.page
    if (!Object.hasOwn(p.pages, page)) throw bad(`no page ${page}`)
    const i = Number(b.index)
    const max = r.where === "key" ? 8 : 4
    if (!Number.isInteger(i) || i < 0 || i >= max) throw bad(`index must be 0–${max - 1}`)
    const list = r.where === "key" ? p.pages[page].keys : p.pages[page].dials
    list[i] = scrubPublic(fillTemplate(r.template, vars))
    e.setProfile(p, origin)
    return { page, index: i }
  }

  /** Same-origin fetch("/api/…") calls that bypass api() (e.g. the glyph / logo pickers) land here too. */
  patchFetch() {
    const real = window.fetch.bind(window)
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const u = new URL(raw, location.href)
      if (u.origin !== location.origin || !u.pathname.startsWith("/api/")) return real(input, init)
      const method = init?.method || (input instanceof Request ? input.method : "GET")
      let body: unknown
      try {
        body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
      } catch {
        body = undefined
      }
      try {
        // like the server: the save's origin is whatever x-deck-client the caller sent
        const origin = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)).get("x-deck-client") || ""
        const out = await this.api(method, u.pathname + u.search, body, origin)
        return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } })
      } catch (err) {
        const status = (err as { status?: number }).status || 400
        return new Response(JSON.stringify({ error: (err as Error).message }), { status, headers: { "content-type": "application/json" } })
      }
    }
  }
}

let instance: Promise<DemoTransport> | null = null
export function getDemo(): Promise<DemoTransport> {
  return (instance ??= (async () => {
    const t = new DemoTransport()
    t.patchFetch()
    await t.start()
    return t
  })())
}
