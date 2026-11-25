// Editor state: one mutable store that mirrors the DeckStudio server.
// Edits mutate `state.profile` in place, then call `save()`; React re-renders off `rev`.
import { useSyncExternalStore } from "react"
import { notify } from "@/components/ui/toaster"

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Action = { type: string; [k: string]: any }
export type Key = Record<string, any>
export type Dial = Record<string, any>
export type Strip = Record<string, any>
export type Page = { name: string; hidden?: boolean; source?: "rex" | "audio" | "bots" | "grokbots"; providers?: string[]; bots?: string[]; apps?: string[]; keys: Key[]; dials: Dial[]; strip: Strip }
export type Profile = {
  version?: number; brightness: number; startPage: string; theme: Record<string, any>; pages: Record<string, Page>
  appSwitching?: boolean; agents?: { toast?: boolean; autoSwitch?: boolean; [k: string]: unknown }
  // command providers (type "command") and, per provider id, what the user trusts: on the deck, url schemes beyond https, shell
  botProviders?: { type?: "command"; id: string; name?: string; cmd?: string; interval?: number; enabled?: boolean; schemes?: string[]; allowShell?: boolean }[]
  plugins?: Record<string, { enabled?: boolean; grants?: { shell?: boolean; schemes?: string[]; network?: string[] } }> // src/plugin-schema.mjs
  agentProviders?: { id: string; enabled?: boolean; schemes?: string[] }[] // agent alerting: per provider, on the deck + url schemes beyond https (src/agent-schema.mjs)
}
export type Selection = { kind: "page" | "theme" | "strip" } | { kind: "key" | "dial"; index: number }
export type Status = { state: string; detail: string }
export type InputEvent = { kind: "key" | "dial" | "strip"; index?: number; event: string; delta?: number; readonly?: boolean }

// ---- auth: `deckctl open` opens /#c=<one-time code>; the editor trades it for the token (POST /api/login).
// The token itself never appears in a URL (argv of `open`, browser history). It lives in sessionStorage.
export let TOKEN = ""
/** Read the login code from the fragment (then strip it) and trade it for the token. Call once before connect(). */
export async function login(): Promise<string> {
  try {
    const h = location.hash
    const code = /(?:^#|&)c=([0-9a-f]{32})(?:&|$)/.exec(h)?.[1]
    if (/(?:^#|&)(?:c|t)=/.test(h)) history.replaceState(null, "", location.pathname + location.search)
    // an old-style #t=<token> link is ignored: a token in a URL ends up in history
    if (/(?:^#|&)t=/.test(h)) console.warn("deckstudio: #t=<token> links are no longer accepted; run deckctl open")
    if (code) {
      const r = await fetch("/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) })
      const j = await r.json().catch(() => ({}))
      if (r.ok && typeof j.token === "string") sessionStorage.setItem("deckToken", j.token)
      else console.warn(`deckstudio: login failed: ${j.error || r.status}`)
    }
    TOKEN = sessionStorage.getItem("deckToken") || ""
  } catch {
    TOKEN = ""
  }
  return TOKEN
}
const CLIENT_ID = Math.random().toString(36).slice(2)
// Demo mode: no server, an in-browser engine (src/demo) answers instead. On by build flag
// (npm run build:demo → web/site), or with ?demo under `npm run dev`.
export const DEMO: boolean =
  import.meta.env.VITE_DEMO === "1" || (import.meta.env.DEV && new URLSearchParams(location.search).has("demo"))

export const state = {
  rev: 0,
  connected: false,
  profile: null as Profile | null,
  page: "",
  status: { state: "connecting", detail: "" } as Status,
  actionTypes: {} as Record<string, string[]>,
  brightness: 70,
  frame: { keys: {} as Record<string, string>, strip: "" },
  dials: [] as { label: string; value: number | string | null; pct: number | null; turns: boolean; readonly?: boolean }[],
  sel: { kind: "page" } as Selection,
  mode: "edit" as "edit" | "live",
  save: { state: "ok" as "ok" | "pending" | "bad", msg: "saved" },
  formKey: 0, // bump to remount the inspector's uncontrolled fields after an external change
  flash: {} as Record<string, number>,
  turn: [0, 0, 0, 0],
  clip: { key: null as Key | null, dial: null as Dial | null },
  front: { bundleId: "", name: "" },
  canUndo: false,
  canRedo: false,
}

// demo builds expose the store for debugging and automated UI audits
if (DEMO) (globalThis as any).__deck = state
const listeners = new Set<() => void>()
export function touch() {
  state.rev++
  listeners.forEach((l) => l())
}
export function useStore() {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => state.rev,
  )
}
export const page = () => state.profile!.pages[state.page]
export const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v))

export function toast(title: string, tone: "info" | "error" = "info") {
  if (tone === "error") notify.error({ title: "error", description: title, duration: 7000 })
  else notify({ title, duration: 3500 })
}

// ---- transport: the DeckStudio server (fetch + WebSocket), or the in-browser demo engine ----
type Transport = { api(method: string, url: string, body?: unknown): Promise<any>; connect(): void }
let demoP: Promise<import("../demo").DemoTransport> | null = null
/** The demo engine's transport (demo mode only). */
export const demoTransport = () =>
  (demoP ??=
    // inline build-time constants, so the normal build (web/dist) drops the demo chunks entirely
    import.meta.env.VITE_DEMO === "1" || import.meta.env.DEV
      ? import("../demo").then((m) => m.getDemo())
      : Promise.reject(new Error("this build has no demo")))
const demo: Transport = {
  async api(method, url, body) {
    try {
      return await (await demoTransport()).api(method, url, body, CLIENT_ID)
    } catch (e) {
      toast((e as Error).message, "error")
      throw e
    }
  },
  async connect() {
    try {
      const t = await demoTransport()
      t.subscribe(handle)
      state.connected = true
      handle(t.hello())
    } catch (e) {
      state.status = { state: "error", detail: `demo failed to start: ${(e as Error).message}` }
      touch()
    }
  },
}
const server: Transport = { api: serverApi, connect: connectServer }
const transport: Transport = DEMO ? demo : server

// ---- http ----
export function api<T = any>(method: string, url: string, body?: unknown): Promise<T> {
  return transport.api(method, url, body)
}
async function serverApi(method: string, url: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    headers: { "x-deck-token": TOKEN, "x-deck-client": CLIENT_ID, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok) {
    // a token from before a server restart (the token is rotated): forget it, `deckctl open` logs in again
    if (r.status === 401) try { sessionStorage.removeItem("deckToken") } catch {}
    const msg = r.status === 401 ? "access token no longer valid: run deckctl open" : (j as any).error || r.statusText
    toast(msg, "error")
    throw new Error(msg)
  }
  return j
}

// Simulated input is sent strictly in order so a down always precedes its up.
let simChain: Promise<unknown> = Promise.resolve()
export const sim = (body: Record<string, unknown>) =>
  (simChain = simChain.then(() => api("POST", "/api/sim", body)).catch(() => {}))

// ---- websocket ----
export function connect() {
  transport.connect()
}
function connectServer() {
  // the token rides in the subprotocol list (Sec-WebSocket-Protocol), not the URL; the server picks "deck.v1"
  const ws = new WebSocket(`ws://${location.host}/ws?client=${CLIENT_ID}`, ["deck.v1", `deck.token.${TOKEN}`])
  ws.onopen = () => {
    state.connected = true
    touch()
  }
  ws.onmessage = (ev) => handle(JSON.parse(ev.data))
  ws.onclose = () => {
    state.connected = false
    state.status = { state: "error", detail: "deckstudio server not reachable — retrying…" }
    touch()
    setTimeout(connectServer, 1500)
  }
}

/** One server message (hello/frame/status/page/brightness/profile/log/input/frontApp), from either transport. */
export function handle(m: any) {
  switch (m.type) {
    case "hello": {
      const unsaved = state.profile && (saveTimer || state.save.state === "bad")
      Object.assign(state, { page: m.page, status: m.status, actionTypes: m.actionTypes, brightness: m.brightness })
      state.frame = { keys: {}, strip: "" }
      if (unsaved) {
        // we reconnected with edits the server never got: keep them and send them now
        toast("reconnected — re-sending your unsaved edits")
        flushSave()
      } else {
        state.profile = m.profile
        undoStack.length = redoStack.length = 0
        lastSnap = clone(m.profile)
        state.save = { state: "ok", msg: "saved" }
        syncUndo()
      }
      if (!state.profile!.pages[state.page]) state.page = state.profile!.startPage
      applyFrame(m.frame)
      state.formKey++
      break
    }
    case "frame":
      applyFrame(m)
      break
    case "status":
      state.status = m.status
      break
    case "page":
      setPage(m.page)
      break
    case "brightness":
      state.brightness = m.brightness
      if (state.profile) state.profile.brightness = m.brightness
      break
    case "profile": {
      if (m.origin === CLIENT_ID) return // our own save echoing back
      if (saveTimer) toast("profile changed elsewhere; your unsaved edit was replaced", "error")
      clearTimeout(saveTimer)
      saveTimer = 0
      adoptProfile(m.profile, false)
      // A PUT of ours may still land after this broadcast and overwrite it on the server;
      // once in-flight saves settle, re-read the server so editor and server agree.
      if (pending > 0) inflight.then(resync, resync)
      break
    }
    case "log":
      toast(m.log.msg, m.log.level === "error" ? "error" : "info")
      return
    case "input":
      onInput(m.input)
      break
    case "frontApp":
      state.front = m.app
      break
  }
  touch()
}

function applyFrame(f: { keys?: Record<string, string>; strip?: string; page?: string; dials?: typeof state.dials }) {
  // The server only renders the page the device is really on, so frames are authoritative.
  if (f.page && f.page !== state.page && state.profile?.pages[f.page]) setPage(f.page)
  for (const [i, src] of Object.entries(f.keys || {})) if (src) state.frame.keys[i] = src
  if (f.strip) state.frame.strip = f.strip
  if (f.dials) state.dials = f.dials
}
async function resync() {
  const st = await api<{ profile: Profile; page: string }>("GET", "/api/state")
  if (JSON.stringify(st.profile) !== JSON.stringify(state.profile)) {
    adoptProfile(st.profile, false)
    touch()
  }
}
/** Replace the whole local profile (import, external change). `undoable` keeps the old one (or `prev`, a snapshot from before the change) as an undo step;
 * otherwise it's an external change and the undo history no longer applies. */
export function adoptProfile(p: Profile, undoable: boolean, prev?: Profile) {
  if (undoable && state.profile) {
    undoStack.push(prev ?? clone(state.profile))
    redoStack.length = 0
  } else if (!undoable) undoStack.length = redoStack.length = 0
  state.profile = p
  state.brightness = p.brightness
  if (!p.pages[state.page]) state.page = p.startPage
  lastSnap = clone(p)
  syncUndo()
  state.formKey++
}
function setPage(id: string) {
  if (!id || state.page === id) return
  state.page = id
  if (state.sel.kind !== "theme") state.sel = { kind: "page" }
  state.formKey++
}
function onInput(e: InputEvent) {
  const id = e.kind === "strip" ? "strip" : `${e.kind}${e.index}`
  state.flash[id] = Date.now()
  setTimeout(() => {
    if (Date.now() - (state.flash[id] || 0) >= 250) delete state.flash[id]
  }, 300)
  // a read-only (live readout) dial never shows a fake rotation: its value can't be turned
  if (e.kind === "dial" && e.event === "rotate" && e.index != null && !e.readonly) state.turn[e.index] += (e.delta || 0) * 15
  setTimeout(touch, e.event === "down" ? 320 : 180)
}

// ---- persistence: debounced whole-profile saves, one undo step per burst ----
let saveTimer = 0
let pending = 0
let inflight: Promise<unknown> = Promise.resolve()
let lastSnap: Profile | null = null
const undoStack: Profile[] = []
const redoStack: Profile[] = []
const syncUndo = () => {
  state.canUndo = undoStack.length > 0
  state.canRedo = redoStack.length > 0
}

/** Call BEFORE mutating state.profile (so the pre-edit snapshot is the undo point), or after; both work. */
export function save() {
  if (!saveTimer && lastSnap) {
    undoStack.push(lastSnap)
    if (undoStack.length > 100) undoStack.shift()
    redoStack.length = 0
    syncUndo()
  }
  state.save = { state: "pending", msg: "saving…" }
  clearTimeout(saveTimer)
  saveTimer = window.setTimeout(flushSave, 250)
  touch()
}
export function flushSave() {
  clearTimeout(saveTimer)
  saveTimer = 0
  const body = clone(state.profile!)
  lastSnap = body // the next burst's undo point is what we're sending now
  pending++
  inflight = inflight
    .then(() => api("PUT", "/api/profile", body))
    .then(() => {
      if (!saveTimer && pending === 1) state.save = { state: "ok", msg: "saved" }
    })
    .catch((e) => {
      state.save = { state: "bad", msg: `save failed: ${e.message} — retry` }
    })
    .finally(() => {
      pending--
      touch()
    })
  return inflight
}
export async function undo(redo = false) {
  const from = redo ? redoStack : undoStack
  const to = redo ? undoStack : redoStack
  if (saveTimer) await flushSave()
  const snap = from.pop()
  if (!snap) return toast(redo ? "nothing to redo" : "nothing to undo")
  to.push(clone(state.profile!))
  state.profile = snap
  if (!state.profile.pages[state.page]) state.page = state.profile.startPage
  syncUndo()
  state.formKey++ // remount fields onto the restored objects before anything else can be typed
  touch()
  await flushSave()
  const st = await api<{ page: string }>("GET", "/api/state")
  if (st.page !== state.page) api("POST", "/api/goto", { page: state.page })
}
// Don't lose an edit made in the last 250 ms before the tab closes or hides.
addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden" && saveTimer && state.profile && !DEMO) flushSave() // a normal fetch: no keepalive size limit
})
addEventListener("pagehide", () => {
  if (!saveTimer || !state.profile) return
  clearTimeout(saveTimer)
  saveTimer = 0
  if (DEMO) return void demoTransport().then((t) => t.saveNow(clone(state.profile!)))
  const body = JSON.stringify(state.profile)
  fetch("/api/profile", {
    method: "PUT",
    keepalive: new Blob([body]).size < 60000, // keepalive bodies are capped at 64 KiB
    headers: { "x-deck-token": TOKEN, "x-deck-client": CLIENT_ID, "content-type": "application/json" },
    body,
  }).catch(() => {})
})

// ---- small helpers used across the UI ----
export function select(sel: Selection) {
  state.sel = sel
  state.formKey++
  touch()
}
/** The engine's own rule (src/dial-rules.mjs): a value dial that only shows a live readout (a poll and
 *  nothing using its value) can't be turned; `readonly: true|false` overrides. */
export { dialReadonly } from "@deck/dial-rules.mjs"
export function setOrDel(obj: Record<string, any>, k: string, v: unknown) {
  save()
  if (v === "" || v == null || (typeof v === "number" && isNaN(v))) delete obj[k]
  else obj[k] = v
}
export const normPage = (pg: Partial<Page>): Page => ({
  name: pg.name || "page",
  ...pg,
  keys: Array.from({ length: 8 }, (_, i) => pg.keys?.[i] ?? {}),
  dials: Array.from({ length: 4 }, (_, i) => pg.dials?.[i] ?? {}),
  strip: pg.strip ?? { mode: "segments" },
})
export function uniqueId(base: string) {
  const b = base.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page"
  let id = b
  let n = 2
  while (state.profile!.pages[id]) id = `${b}-${n++}`
  return id
}
export async function addPage(copy: boolean, name: string) {
  const id = uniqueId(name)
  save()
  state.profile!.pages[id] = normPage(copy ? { ...clone(page()), name } : { name, keys: [{ icon: "⬅️", label: "Back", onPress: { type: "back" } }] })
  await flushSave()
  await api("POST", "/api/goto", { page: id })
}
export async function deletePage() {
  const id = state.page
  const p = state.profile!
  save()
  delete p.pages[id]
  if (p.startPage === id) p.startPage = Object.keys(p.pages)[0]
  const dangling = JSON.stringify(p).includes(`"page":"${id}"`)
  state.page = p.startPage
  state.sel = { kind: "page" }
  await flushSave()
  await api("POST", "/api/goto", { page: state.page })
  state.formKey++
  touch()
  if (dangling) toast(`some "go to page" actions still point at the deleted page "${id}"`, "error")
}
export function movePage(dir: number) {
  const p = state.profile!
  const ids = Object.keys(p.pages)
  const i = ids.indexOf(state.page)
  const j = i + dir
  if (j < 0 || j >= ids.length) return
  save()
  ;[ids[i], ids[j]] = [ids[j], ids[i]]
  p.pages = Object.fromEntries(ids.map((id) => [id, p.pages[id]]))
  touch()
}

// Resize at 2x for crispness. 'cover' crops to the exact target aspect so nothing gets stretched.
export async function readImage(file: File, maxW: number, maxH: number, fit: string) {
  // animated GIFs are kept as-is (the deck plays them); everything else is resized below
  if (file.type === "image/gif") {
    if (file.size > 2.5 * 1024 * 1024) throw new Error("gif is over 2.5 MB")
    return await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = () => rej(r.error); r.readAsDataURL(file) })
  }
  const bmp = await createImageBitmap(file)
  let sx = 0
  let sy = 0
  let sw = bmp.width
  let sh = bmp.height
  if (fit === "cover") {
    const r = maxW / maxH
    if (sw / sh > r) {
      sw = sh * r
      sx = (bmp.width - sw) / 2
    } else {
      sh = sw / r
      sy = (bmp.height - sh) / 2
    }
  }
  const s = Math.min(1, (maxW * 2) / sw, (maxH * 2) / sh)
  const cv = document.createElement("canvas")
  cv.width = Math.round(sw * s)
  cv.height = Math.round(sh * s)
  cv.getContext("2d")!.drawImage(bmp, sx, sy, sw, sh, 0, 0, cv.width, cv.height)
  return cv.toDataURL(file.type === "image/jpeg" ? "image/jpeg" : "image/png", 0.88)
}
