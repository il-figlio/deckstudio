// The demo's stand-in for src/live.mjs: the same rex / bots / audio page views and key
// decorations (face 'agent', genuine logos, topic glyphs, status pills, sprites, badges), but
// driven by the synthetic data in fixtures.ts. Nothing here reaches the visitor's machine.
import { topicGlyph } from "@deck/topics.mjs"
import { GROK, botFace, botPress, botThumb, findBot, isWaiting, listBots, normalizeBot, parseBotDocs, pressText, providerTrust } from "@deck/bot-schema.mjs"
import { agentTrust } from "@deck/agent-schema.mjs"
import { FAKE_AGENT_PROVIDERS, SAMPLE_DOCS, fakeAgents, fakeAudio, fakeRunning, type FakeAgent } from "./fixtures"
import { demoCaptureDecorate, demoCaptureVars } from "./capture"

// Bring your own bots, in the browser: only what the visitor imports (kept in localStorage) or the samples.
export type DemoBot = { key: string; id: string; provider: string; name: string; fullName: string; avatar: any; unread: number; awaiting: boolean; hidden: boolean; activityAt: number; open: any }
export type DemoProvider = { id: string; name: string; app?: string; logo?: string; schemes?: string[] }
type Saved = { source?: string; bots?: any[]; providers?: DemoProvider[] }
const BOTS_KEY = "deckDemoBots"
function loadSaved(): Saved {
  try { return JSON.parse(localStorage.getItem(BOTS_KEY) || "{}") } catch { return {} }
}
const fromDocs = (docs: { provider: string; name: string; app?: string; logo?: string; bots: DemoBot[] }[]) => ({
  bots: docs.flatMap((d) => d.bots), providers: docs.map(({ provider, name, app, logo, schemes }: any) => ({ id: provider, name, app, logo, schemes })),
})
export const sampleBots = () => fromDocs(parseBotDocs(SAMPLE_DOCS))
function loadBots(): { bots: DemoBot[]; providers: DemoProvider[]; source: "imported" | "sample" | "none" } {
  const s = loadSaved()
  if (s.source === "sample") return { ...sampleBots(), source: "sample" }
  if (s.source !== "imported" || !Array.isArray(s.bots)) return { bots: [], providers: [], source: "none" }
  // older saves (Grok Bot only) have no provider field: they're Grok bots
  const bots = s.bots.map((b, i) => normalizeBot({ ...b, name: b.fullName || b.name }, String(b.provider || GROK.id), i)).filter(Boolean) as DemoBot[]
  const providers = Array.isArray(s.providers) ? s.providers : [...new Set(bots.map((b) => b.provider))].map((id) => (id === GROK.id ? { id, name: GROK.name, app: GROK.app, logo: GROK.logo } : { id, name: id }))
  return { bots, providers, source: "imported" }
}
/** Any bots JSON (Grok Bot's export or the generic bots/v1 document): replaces those providers, keeps the others. */
export function importBots(text: string, cur: { bots: DemoBot[]; providers: DemoProvider[] }) {
  const docs = parseBotDocs(text, "my-bots")
  const got = fromDocs(docs)
  const ids = new Set(got.providers.map((p) => p.id))
  return {
    bots: [...cur.bots.filter((b) => !ids.has(b.provider)), ...got.bots],
    providers: [...cur.providers.filter((p) => !ids.has(p.id)), ...got.providers],
    count: got.bots.length,
  }
}
import type { DemoEngine } from "./engine"

/* eslint-disable @typescript-eslint/no-explicit-any */
export const APP_LOGO: Record<string, string> = { "claude-code": "app-claude", claude: "app-claude", codex: "app-codex", ante: "provider-ante", grok: "app-grokbot", opencode: "provider-opencode" }
export const APP_GLYPH: Record<string, string> = { "claude-code": "app-claude", claude: "app-claude", codex: "app-codex", ante: "app-ante", grok: "app-grokbot", opencode: "terminal" }
const LAMP = { needs: "#e5484d", review: "#22a05a", working: "#f0a020", idle: "#8a8a84" }
const trunc = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s)
const internal = (desc: string, run: () => unknown) => ({ type: "internal", desc, run })

const BOT_OWN = ["bg", "icon", "progress", "tone", "face", "border", "accent", "onRelease", "onLongPress"]
export class DemoLive {
  e: DemoEngine
  agents: FakeAgent[] = fakeAgents()
  // Bots are the visitor's own (imported from their Mac, kept in this browser), or samples on request.
  bots: DemoBot[] = []
  botProviders: DemoProvider[] = []
  botSource: "imported" | "sample" | "none" = "none"
  audio = fakeAudio()
  running = new Set(fakeRunning.flatMap((a) => [a.bundleId, a.name]))
  front = { bundleId: "com.apple.Safari", name: "Safari" }
  selId: string | null = null
  offset = 0
  grokOffset = 0
  filter: string | null = null
  blink = false
  timers: number[] = []

  constructor(e: DemoEngine) {
    this.e = e
    const l = loadBots()
    this.bots = l.bots; this.botProviders = l.providers; this.botSource = l.source
  }
  start() {
    // a little life: working agents make progress, finish, and now and then one asks for you
    this.timers.push(
      window.setInterval(() => {
        let changed = false
        for (const a of this.agents) {
          if (a.attention !== "working" || typeof a.progress !== "number") continue
          a.progress = Math.min(100, a.progress + 3 + Math.round(Math.random() * 6))
          if (a.progress >= 100) Object.assign(a, { attention: "review", progress: undefined, msg: "done — ready for review" })
          changed = true
        }
        if (changed) this.e.scheduleRender()
      }, 2500),
      window.setInterval(() => {
        const idle = this.agents.filter((a) => a.attention === "review" || a.attention === "idle")
        const a = idle[Math.floor(Math.random() * idle.length)]
        if (!a || this.agents.some((x) => x.attention === "working" && typeof x.progress === "number")) return
        Object.assign(a, { attention: "working", progress: 5, msg: "working on it" })
        this.e.scheduleRender()
      }, 9000),
      window.setInterval(() => {
        const want = this.isRexPage() && this.counts().needs > 0
        if (!want) {
          if (this.blink) (this.blink = false), this.e.scheduleRender()
          return
        }
        this.blink = !this.blink
        this.e.scheduleRender()
      }, 650),
    )
  }
  stop() {
    this.timers.forEach(clearInterval)
  }

  // ---------- agents ----------
  /** only providers the profile has on (same rule as the server: rex / claude-code / codex on by default, others once switched on) */
  enabledAgents() {
    const cfg = (this.e.profile as any).agentProviders
    return this.agents.filter((a) => agentTrust(cfg, a.provider).enabled)
  }
  counts() {
    const c = { needs: 0, review: 0, working: 0, idle: 0 }
    for (const a of this.enabledAgents()) c[a.attention]++
    return c
  }
  sorted() {
    const rank = { needs: 0, review: 1, working: 2, idle: 3 }
    return [...this.enabledAgents()].sort((a, b) => rank[a.attention] - rank[b.attention])
  }
  /** GET /api/agents, demo edition: the shared session shape plus the provider list */
  agentsSummary() {
    const cfg = (this.e.profile as any).agentProviders
    const agents = this.sorted().map((a) => ({ ...a, key: `${a.provider}:${a.blockId}`, id: a.blockId, name: a.session, message: a.msg, needs: a.attention === "needs" ? a.kind : undefined }))
    const providers = FAKE_AGENT_PROVIDERS.map((p) => ({ ...p, enabled: agentTrust(cfg, p.id).enabled, count: this.agents.filter((a) => a.provider === p.id).length }))
    return { available: true, error: null, counts: this.counts(), agents, providers, dir: "~/.deckstudio/agents" }
  }
  visibleAgents() {
    const all = this.sorted()
    return this.filter ? all.filter((a) => a.attention === this.filter) : all
  }
  clampSel() {
    const list = this.visibleAgents()
    if (!list.some((a) => a.blockId === this.selId)) this.selId = list[0]?.blockId || null
  }
  get sel() {
    return Math.max(0, this.visibleAgents().findIndex((a) => a.blockId === this.selId))
  }
  isRexPage() {
    return this.e.profile.pages[this.e.page]?.source === "rex"
  }
  goAgent(a: FakeAgent) {
    this.selId = a.blockId
    this.e.wouldRun(a.provider === "rex" ? `jump rex → ${a.app.replace("-code", "")} · ${a.session}` : `open the app running ${a.app.replace("-code", "")} · ${a.session}`)
    if (a.attention === "needs") a.attention = "working"
    this.e.scheduleRender()
  }
  goMostUrgent() {
    const a = this.sorted().find((x) => x.attention === "needs") || this.sorted().find((x) => x.attention === "review")
    if (!a) return this.e.toast("no agent needs you ✓", 1400)
    this.goAgent(a)
  }
  statusOf(a: FakeAgent) {
    if (a.attention === "needs") {
      const t = a.state === "error" ? "error" : a.kind === "permission" ? "allow?" : a.kind === "question" ? "asks" : a.kind === "auth" ? "login" : "needs"
      return { text: t, color: LAMP.needs, urgent: true, blinkOff: this.blink }
    }
    if (a.attention === "review") return { text: "done", color: LAMP.review }
    if (a.attention === "working") return { text: typeof a.progress === "number" ? `${a.progress}%` : "busy", color: LAMP.working, progress: a.progress ?? undefined }
    return { text: "idle", color: LAMP.idle }
  }
  rexView() {
    const theme = this.e.profile.theme
    const agents = this.visibleAgents()
    const counts = this.counts()
    const keys: any[] = new Array(8).fill(null)
    const perPage = 7
    if (this.offset >= agents.length) this.offset = 0
    agents.slice(this.offset, this.offset + perPage).forEach((a, i) => {
      keys[i] = {
        face: "agent", logo: APP_LOGO[a.app], glyph: APP_GLYPH[a.app] || "bot",
        topic: topicGlyph(a.title, a.msg) || undefined,
        label: a.title && a.title.toLowerCase() !== a.app.replace("-code", "") ? a.title : a.msg || a.title || a.app,
        title: a.session, status: this.statusOf(a),
        border: a.blockId === this.selId ? theme.accent || "#7c5cff" : undefined,
        onPress: internal(`${a.provider === "rex" ? "jump rex" : a.provider} → ${a.app} · ${a.session} · ${a.title.slice(0, 30)}`, () => this.goAgent(a)),
        onLongPress: internal(`mark seen ${a.app} · ${a.session}`, () => {
          if (a.attention === "review" || a.attention === "needs") a.attention = "idle"
          this.e.toast("marked seen", 900)
        }),
      }
    })
    if (!agents.length) keys[0] = { face: "lcd", title: this.filter || "agents", label: "none", caption: this.filter ? "tap strip to clear" : "all quiet" }
    keys[7] = agents.length > perPage
      ? { glyph: "arrow--right", title: `${Math.floor(this.offset / perPage) + 1}/${Math.ceil(agents.length / perPage)}`, label: "more", tone: "black",
          onPress: internal("next page of agents", () => { this.offset = this.offset + perPage >= agents.length ? 0 : this.offset + perPage; this.e.scheduleRender() }) }
      : { face: "lcd", title: "needs you", label: String(counts.needs), caption: "go to next", led: counts.needs > 0 && !this.blink, ledColor: LAMP.needs,
          onPress: internal("jump to the agent needing me", () => this.goMostUrgent()) }
    const sel = agents.find((a) => a.blockId === this.selId)
    const tapFilter = (f: string) => internal(`filter ${f}`, () => { this.filter = this.filter === f ? null : f; this.offset = 0; this.clampSel(); this.e.scheduleRender() })
    const countDial = (f: "needs" | "review" | "working", label: string, glyph: string, accent: string) => ({
      label: this.filter === f ? `${label} ◂` : label, glyph, style: "text", display: String(counts[f]), accent, _press: tapFilter(f), onTouch: tapFilter(f),
    })
    const dials = [
      {
        label: sel ? `${sel.app.replace("-code", "")} · ${sel.session}` : "agent", glyph: !sel || sel.provider === "rex" ? "app-rex" : APP_GLYPH[sel.app] || "bot", style: "text",
        display: sel ? (sel.title || sel.app).toLowerCase() : "—",
        _rotate: (d: number) => {
          const n = agents.length
          if (!n) return
          const i = (this.sel + d + n) % n
          this.selId = agents[i].blockId
          this.offset = Math.floor(i / perPage) * perPage
          this.e.scheduleRender()
        },
        _press: sel ? internal("jump to selected agent", () => this.goAgent(sel)) : null,
        onTouch: sel ? internal("jump to selected agent", () => this.goAgent(sel)) : null,
      },
      countDial("needs", "needs you", "agent-needs", LAMP.needs),
      countDial("review", "done", "checkmark--outline", LAMP.review),
      countDial("working", "working", "renew", LAMP.working),
    ]
    return { keys, dials, strip: { mode: "segments" } }
  }

  // ---------- bots (bring your own) ----------
  findBot(ref: unknown) {
    return findBot(this.bots, ref)
  }
  provider(id: string) {
    return this.botProviders.find((p) => p.id === id)
  }
  setBots(list: DemoBot[], source: "imported" | "sample" | "none", providers: DemoProvider[] = []) {
    this.bots = list
    this.botProviders = providers
    this.botSource = source
    try { localStorage.setItem(BOTS_KEY, JSON.stringify(source === "imported" ? { source, bots: list, providers } : { source })) } catch { /* blocked */ }
    this.e.scheduleRender()
  }
  useSamples() {
    const s = sampleBots()
    this.setBots(s.bots, "sample", s.providers)
  }
  trust(id: string) {
    return providerTrust(this.e.profile.botProviders, id, this.provider(id)?.schemes)
  }
  press(b: DemoBot) {
    return botPress(b, this.trust(b.provider), this.provider(b.provider)?.app || (b.provider === GROK.id ? GROK.app : undefined))
  }
  providersSummary() {
    const count = (id: string) => this.bots.filter((b) => b.provider === id && !b.hidden).length
    const grok = this.provider(GROK.id)
    const needs = (id: string) => {
      const t = this.trust(id), ps = this.bots.filter((b) => b.provider === id).map((b) => this.press(b))
      const blockedSchemes = [...new Set(ps.filter((p) => p.blocked && p.kind === "url").map((p) => String(p.url).split(":")[0].toLowerCase()))]
      return { enabled: true, allowed: t.schemes, allowShell: t.allowShell, blockedSchemes, shell: ps.filter((p) => p.kind === "shell").length }
    }
    return [
      { id: GROK.id, name: GROK.name, kind: "grokbot", app: GROK.app, logo: GROK.logo, available: !!grok, count: count(GROK.id), enabled: true },
      ...this.botProviders.filter((p) => p.id !== GROK.id).map((p) => ({ ...p, kind: this.botSource === "sample" ? "sample" : "import", count: count(p.id), ...needs(p.id) })),
    ]
  }
  summary(provider?: string) {
    return {
      source: this.botSource, providers: this.providersSummary(),
      bots: this.bots.filter((b) => !b.hidden && (!provider || b.provider === provider)).map((b) => { const p = this.press(b); return { ...b, thumb: botThumb(b), press: pressText(p), blocked: !!p.blocked } }),
    }
  }
  openBot(b: DemoBot) {
    // the visitor's own bots open in their app (the browser asks once); samples only show what would run.
    // Same trust rules as the server: https, or a scheme the provider declares and the visitor allowed.
    const p = this.press(b)
    const url = p.kind === "url" && !p.blocked ? String(p.url) : ""
    if (this.botSource === "imported" && url) {
      if (/^https?:/i.test(url)) window.open(url, "_blank", "noopener")
      else window.location.href = url
      this.e.notify(`opened ${b.name}`)
    } else if (this.botSource === "imported" && p.blocked) this.e.notify(`${b.name}: ${p.blocked}`)
    else this.e.wouldRun(`open ${b.provider === GROK.id ? "grok bot" : b.provider} ${b.name}`)
    b.unread = 0
    b.awaiting = false
    b.activityAt = Date.now()
    this.e.scheduleRender()
  }
  botKey(b: DemoBot) {
    const app = this.provider(b.provider)?.app || (b.provider === GROK.id ? GROK.app : undefined)
    return {
      ...botFace(b),
      onPress: internal(`open ${b.provider === GROK.id ? "grok bot" : b.provider} ${b.name}`, () => this.openBot(b)),
      ...(app ? { onLongPress: { type: "app", target: app } } : {}),
    }
  }
  botsView(pg: any) {
    const providers: string[] = pg.source === "grokbots" ? [GROK.id] : Array.isArray(pg.providers) ? pg.providers : []
    const bots = listBots(this.bots, { providers, pins: Array.isArray(pg.bots) ? pg.bots : [] })
    const keys: any[] = new Array(8).fill(null)
    const per = 7
    if (this.grokOffset >= bots.length) this.grokOffset = 0
    bots.slice(this.grokOffset, this.grokOffset + per).forEach((b, i) => (keys[i] = this.botKey(b)))
    if (!bots.length) {
      keys[0] = { face: "lcd", title: "bots", label: "none yet", caption: "bring your own" }
      keys[1] = { glyph: "download", title: "page settings", label: "import mine", onPress: internal("how to import your bots", () => this.e.toast("page settings → bots · bring your own", 2600)) }
      keys[2] = { sprite: "grokbot/bot-blob-face", spriteColor: "violet", spriteMode: "blink", label: "samples", onPress: internal("use sample bots", () => this.useSamples()) }
    }
    const shown = [...new Set(bots.map((b) => b.provider))]
    const oneId = providers.length === 1 ? providers[0] : shown.length === 1 ? shown[0] : providers.length ? "" : GROK.id
    const one = oneId === GROK.id ? { name: GROK.name, app: GROK.app, logo: GROK.logo } : this.provider(oneId)
    keys[7] = bots.length > per
      ? { glyph: "arrow--right", title: `${Math.floor(this.grokOffset / per) + 1}/${Math.ceil(bots.length / per)}`, label: "more", tone: "black",
          onPress: internal("next page of bots", () => { this.grokOffset = this.grokOffset + per >= bots.length ? 0 : this.grokOffset + per; this.e.scheduleRender() }) }
      : one?.app ? { logo: one.logo, glyph: "bot", label: one.name.toLowerCase(), onPress: { type: "app", target: one.app } }
      : null
    const waiting = bots.filter(isWaiting).length
    const first = bots.find((b) => b.awaiting) || bots.find((b) => b.unread)
    const open = first ? internal(`open ${first.name}`, () => this.openBot(first)) : null
    const dials = [{ label: "calling you", glyph: "notification", style: "text", display: String(waiting), accent: LAMP.needs, _press: open, onTouch: open }, null, null, null]
    return { keys, dials }
  }

  // ---------- audio (simulated devices) ----------
  micMuted() {
    return !!this.audio.devices.find((d) => d.defaultInput)?.inputMuted
  }
  toggleMic() {
    const d = this.audio.devices.find((x) => x.defaultInput)
    if (d) d.inputMuted = !d.inputMuted
    this.e.wouldRun("mic-mute toggle")
    this.e.toast(this.micMuted() ? "mic muted" : "mic live", 900)
  }
  setDefault(kind: "input" | "output", uid: string) {
    const flag = kind === "input" ? "defaultInput" : "defaultOutput"
    const d = this.audio.devices.find((x) => x.uid === uid || x.name === uid)
    if (!d) return this.e.toast(`no ${kind} "${uid}"`, 1200)
    for (const x of this.audio.devices) x[flag] = x === d
    this.e.wouldRun(`audio-${kind} ${d.name}`)
  }
  cycle(kind: "input" | "output", dir: number) {
    const list = this.audio.devices.filter((d) => d[kind])
    const cur = list.findIndex((d) => d[kind === "input" ? "defaultInput" : "defaultOutput"])
    const next = list[(cur + dir + list.length) % list.length]
    if (next) this.setDefault(kind, next.uid)
  }
  audioView() {
    const keys: any[] = new Array(8).fill(null)
    const ins = this.audio.devices.filter((d) => d.input).slice(0, 3)
    const outs = this.audio.devices.filter((d) => d.output).slice(0, 3)
    ins.forEach((d, i) => {
      keys[i] = { glyph: "microphone", title: "input", label: trunc(d.name.toLowerCase(), 18), led: d.defaultInput, ledColor: LAMP.review,
        onPress: internal(`use mic ${d.name}`, () => this.setDefault("input", d.uid)) }
    })
    const muted = this.micMuted()
    keys[3] = { glyph: muted ? "microphone--off" : "microphone", title: "mic", label: muted ? "muted" : "live", tone: muted ? "black" : "paper",
      led: true, ledColor: muted ? LAMP.needs : LAMP.review, onPress: internal("toggle mic", () => this.toggleMic()) }
    outs.forEach((d, i) => {
      keys[4 + i] = { glyph: /speaker|built/i.test(d.name) ? "volume--up" : /head|airpod|buds/i.test(d.name) ? "headphones" : "screen", title: "output",
        label: trunc(d.name.toLowerCase(), 18), led: d.defaultOutput, ledColor: LAMP.review,
        onPress: internal(`use output ${d.name}`, () => this.setDefault("output", d.uid)) }
    })
    keys[7] = { glyph: "camera", title: "camera", label: this.audio.camera ? "in use" : "idle", led: this.audio.camera, ledColor: LAMP.needs, tone: this.audio.camera ? "black" : "paper" }
    const curIn = this.audio.devices.find((d) => d.defaultInput)
    const curOut = this.audio.devices.find((d) => d.defaultOutput)
    const dials = [
      null,
      { label: "mic", glyph: "mic-switch", style: "text", display: trunc((curIn?.name || "—").toLowerCase(), 12), _rotate: (d: number) => this.cycle("input", d), _press: internal("toggle mic", () => this.toggleMic()) },
      { label: "output", glyph: "volume--up", style: "text", display: trunc((curOut?.name || "—").toLowerCase(), 12), _rotate: (d: number) => this.cycle("output", d) },
      null,
    ]
    return { keys, dials }
  }

  sourceView(pg: any): { keys?: any[]; dials?: any[]; strip?: any } | null {
    if (pg.source === "rex") return this.rexView()
    if (pg.source === "bots" || pg.source === "grokbots") return this.botsView(pg)
    if (pg.source === "audio") return this.audioView()
    return null
  }
  decorate(k: any) {
    if (!k) return k
    k = demoCaptureDecorate(k) // the record key turns red while "recording"
    if (k.bot) {
      const b = this.findBot(k.bot)
      if (!b) return { ...k, label: k.label || String(k.bot), title: "bot not found", dim: true }
      const own = Object.fromEntries(BOT_OWN.filter((f) => k[f] != null).map((f) => [f, k[f]])) // the key's own look/overlay fields win over the bot's defaults
      return { ...this.botKey(b), ...(k.label ? { label: k.label } : {}), ...own }
    }
    // app keys: lamp = "running" (simulated); everything counts as installed in the demo
    const target = k.onPress?.type === "app" ? String(k.onPress.target || "") : k.app ? String(k.app) : ""
    if (!target || k.led != null) return k
    const targets = target.split(",").map((t) => t.trim()).filter(Boolean)
    return { ...k, led: targets.some((t) => this.running.has(t)), ledColor: k.ledColor || LAMP.review }
  }
  vars() {
    const c = this.counts()
    const base = {
      agents_needs: c.needs, agents_review: c.review, agents_working: c.working,
      mic: this.micMuted() ? "muted" : "live", camera: this.audio.camera ? "on" : "off",
      front_app: this.front.name,
      bots_calling: this.bots.filter((b) => b.provider === GROK.id && isWaiting(b)).length,
      bots_waiting: this.bots.filter(isWaiting).length,
      ...demoCaptureVars(), // {recording} {rec_time} {last_capture}
    }
    return { ...base, ...this.e.plugins.vars(base) } // {id.value} per built-in plugin
  }
}
