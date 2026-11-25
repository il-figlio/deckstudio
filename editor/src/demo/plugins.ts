// The demo's stand-in for src/plugins.mjs: the built-in plugins (plugins/*/deckstudio.json, bundled at build
// time; plugins/local is never included) validated by the shared src/plugin-schema.mjs, with status simulated
// from the demo's own state. Nothing runs on the visitor's machine: non-built-in actions only say "would run".
// The marketplace is a build-time copy of the public registry (virtual:deck-registry); "installing" one keeps its
// manifest in this browser's localStorage, and switching it on / granting lives in the demo profile like the real thing.
import { validateManifest, extractValues, pluginVars, pluginRecipes, pluginTrust, pluginSettings, publicSettings, checkSettings, missingGrants, checkGrant, cmdAllowed, httpAllowed, urlAllowed, type PluginManifest, type PluginGrants } from "@deck/plugin-schema.mjs"
import registry from "virtual:deck-registry"
import type { DemoEngine } from "./engine"

/* eslint-disable @typescript-eslint/no-explicit-any */
const RAW = import.meta.glob("../../../plugins/*/deckstudio.json", { eager: true, import: "default" }) as Record<string, unknown>
export const BUILTIN_PLUGINS: PluginManifest[] = Object.values(RAW)
  .map((raw) => validateManifest(raw, { source: "builtin" }))
  .filter((r) => r.ok && r.manifest)
  .map((r) => r.manifest as PluginManifest)

const INSTALLED_KEY = "deckstudio-demo-plugins-v1" // { id: { manifest: text, sha, version } } of "installed" registry plugins
type Installed = Record<string, { manifest: string; sha: string; version: string }>
function loadInstalled(): Installed {
  try { return JSON.parse(localStorage.getItem(INSTALLED_KEY) || "{}") || {} } catch { return {} }
}
function saveInstalled(v: Installed) {
  try { localStorage.setItem(INSTALLED_KEY, JSON.stringify(v)) } catch { /* private mode: forgotten on reload */ }
}
const bad = (msg: string, status = 400) => Object.assign(new Error(msg), { status })
function actionBlocked(a: any, g: PluginGrants, m?: PluginManifest): string | null {
  if (a.kind === "cmd") return cmdAllowed(a.cmd, g, m)
  if (a.kind === "http") return httpAllowed(String(a.http).replace(/\{[^}]*\}/g, "x"), g)
  if (a.kind === "url") return urlAllowed(a.url, g)
  return null
}

export class DemoPlugins {
  e: DemoEngine
  installed: Installed = loadInstalled()
  user: PluginManifest[] = []
  constructor(e: DemoEngine) {
    this.e = e
    this.rebuild()
  }
  private rebuild() {
    this.user = Object.values(this.installed)
      .map((x) => validateManifest(x.manifest, { source: "user" }))
      .filter((r) => r.ok && r.manifest && !BUILTIN_PLUGINS.some((b) => b.id === r.manifest!.id))
      .map((r) => r.manifest as PluginManifest)
  }
  all() {
    return [...BUILTIN_PLUGINS, ...this.user]
  }
  /** simulated status documents, from the same state the demo's pages show */
  private doc(m: PluginManifest): unknown {
    const live = this.e.live
    const vis = live.bots.filter((b) => !b.hidden)
    const waiting = vis.filter((b) => b.awaiting || b.unread > 0)
    switch (m.status?.builtin) {
      case "capture": {
        const v = live.vars() as Record<string, unknown>
        return { recording: v.recording, rec_time: v.rec_time, last_capture: v.last_capture }
      }
      case "bots": return { waiting: waiting.length, count: vis.length, providers: new Set(vis.map((b) => b.provider)).size }
      case "grokbot": return { available: true, calling: waiting.filter((b) => b.provider === "grokbot").length, count: vis.filter((b) => b.provider === "grokbot").length }
      default: return undefined // an installed registry plugin: its tool isn't on this machine, so values show their defaults
    }
  }
  trust(m: PluginManifest) {
    return pluginTrust(this.e.profile.plugins, m)
  }
  settings(m: PluginManifest) {
    return pluginSettings(this.e.profile.plugins, m)
  }
  private stateOf(m: PluginManifest) {
    return this.trust(m).enabled ? "ok" : "disabled"
  }
  vars(base: Record<string, unknown> = {}) {
    const out: Record<string, string> = {}
    for (const m of this.all()) {
      const on = this.trust(m).enabled
      Object.assign(out, pluginVars(m.id, on && m.status ? extractValues(m, this.docWith(m, base), { settings: this.settings(m) }) : {}, this.stateOf(m), publicSettings(m, this.settings(m))))
    }
    return out
  }
  // capture reads the live vars; avoid recursing through live.vars() when called from it
  private docWith(m: PluginManifest, base: Record<string, unknown>) {
    if (m.status?.builtin === "capture" && "recording" in base) return { recording: base.recording, rec_time: base.rec_time, last_capture: base.last_capture }
    return this.doc(m)
  }
  private info(m: PluginManifest) {
    const t = this.trust(m)
    const on = t.enabled
    const reg = registry.plugins.find((x) => x.id === m.id)
    return {
      id: m.id, name: m.name, version: m.version, author: m.author, homepage: m.homepage, description: m.description, icon: m.icon, iconUrl: m.source === "user" ? reg?.iconUrl : undefined,
      builtin: m.builtin, source: m.source, dir: m.source === "user" ? `~/.deckstudio/plugins/${m.id} (demo: kept in this browser)` : undefined,
      valid: true, errors: [], warnings: [], installed: true, install: m.install, enabled: on, permissions: m.permissions, grants: t.grants, needs: missingGrants(m, t),
      state: this.stateOf(m), error: null, values: on && m.status ? extractValues(m, this.doc(m), { settings: this.settings(m) }) : {}, updatedAt: on ? Date.now() : null,
      vars: Object.keys(pluginVars(m.id, m.status ? extractValues(m, undefined) : {}, "", publicSettings(m, this.settings(m)))).map((k) => `{${k}}`),
      settings: Object.entries(m.settings || {}).map(([name, st]) => ({ name, ...st, ...((st as any).secret ? { set: !!this.settings(m)[name] } : { value: this.settings(m)[name] }) })),
      status: m.status ? { kind: m.status.kind, interval: m.status.interval, stale: m.status.stale } : null,
      bots: m.bots ? { kind: m.bots.kind, error: null } : null,
      actions: Object.entries(m.actions).map(([name, a]: [string, any]) => ({ name, title: a.title, kind: a.kind, params: a.params, blocked: actionBlocked(a, t.grants, m) })),
      templates: Object.fromEntries(Object.entries(m.templates).map(([k, v]) => [k, Object.keys(v as object)])),
    }
  }
  summary() {
    return { demo: true, plugins: this.all().map((m) => this.info(m)), dirs: {} }
  }
  private get(id: string) {
    const m = this.all().find((x) => x.id === id)
    if (!m) throw bad(`no plugin "${id}"`, 404)
    return m
  }
  one(id: string) {
    const m = this.get(id)
    return { ...this.info(m), manifest: m }
  }
  recipes() {
    return this.all().flatMap((m) => pluginRecipes(m).map((r: any) => ({ ...r, pluginEnabled: this.trust(m).enabled, pluginInstalled: true })))
  }
  // ---- switching on / granting: saved in the demo profile, exactly like profile.plugins on a real install ----
  private patch(id: string, f: (c: { enabled?: boolean; grants: PluginGrants; settings?: Record<string, unknown> }) => void) {
    const p = structuredClone(this.e.profile) as any
    p.plugins ??= {}
    p.plugins[id] ??= { grants: { shell: false, schemes: [], network: [] } }
    p.plugins[id].grants ??= { shell: false, schemes: [], network: [] }
    f(p.plugins[id])
    this.e.setProfile(p, "plugins")
  }
  enable(id: string, on: boolean) {
    this.get(id)
    this.patch(id, (c) => { c.enabled = on })
    return this.one(id)
  }
  grant(id: string, req: unknown) {
    const g = checkGrant(this.get(id), req)
    this.patch(id, (c) => { c.grants = g })
    return this.one(id)
  }
  /** { name: value | null } merged into profile.plugins[id].settings (null: back to the default), like the real route */
  setSettings(id: string, req: unknown) {
    const patch = checkSettings(this.get(id), req)
    this.patch(id, (c) => {
      const next: Record<string, unknown> = { ...(c.settings || {}) }
      for (const [k, v] of Object.entries(patch)) { if (v === null) delete next[k]; else next[k] = v }
      if (Object.keys(next).length) c.settings = next; else delete c.settings
    })
    return this.one(id)
  }
  // ---- marketplace: the bundled registry copy ----
  registry() {
    const plugins = registry.plugins.map(({ manifest, ...e }) => {
      const b = BUILTIN_PLUGINS.find((x) => x.id === e.id)
      const inst = b ? { source: "builtin", version: b.version, sha: null } : this.installed[e.id] ? { source: "user", version: this.installed[e.id].version, sha: this.installed[e.id].sha } : null
      void manifest
      return { ...e, installed: inst, update: inst?.source === "user" && (inst.version !== e.version || inst.sha !== e.sha), conflict: b ? `"${e.id}" is already a builtin plugin` : null }
    })
    return { ok: registry.ok, demo: true, error: registry.ok ? undefined : "this demo was built without a plugin registry", source: registry.source, plugins, tags: [...new Set(plugins.flatMap((p) => p.tags))].sort() }
  }
  install(id: string) {
    const e = registry.plugins.find((x) => x.id === id)
    if (!e) throw bad(`"${id}" is not in the registry`, 404)
    if (BUILTIN_PLUGINS.some((b) => b.id === id)) throw bad(`"${id}" is already a builtin plugin`)
    this.installed = { ...this.installed, [id]: { manifest: e.manifest, sha: e.sha, version: e.version } }
    saveInstalled(this.installed)
    this.rebuild()
    if ((this.e.profile as any).plugins?.[id]?.enabled) this.patch(id, (c) => { c.enabled = false }) // a fresh install / update starts off
    else this.e.setProfile(structuredClone(this.e.profile), "plugins") // re-render: its recipes and vars now exist
    return { id, version: e.version, sha256: e.sha, dir: `~/.deckstudio/plugins/${id}`, plugin: this.one(id) }
  }
  uninstall(id: string) {
    if (!this.installed[id]) throw bad(`${id} is not an installed (user) plugin`)
    const { [id]: _gone, ...rest } = this.installed
    void _gone
    this.installed = rest
    saveInstalled(rest)
    this.rebuild()
    this.e.setProfile(structuredClone(this.e.profile), "plugins")
    return { id, movedTo: "(demo) removed from this browser" }
  }
  /** { type: 'plugin', plugin, action, args } in the demo: built-in actions run in the demo engine, the rest only "would run". */
  action(ref: any): any {
    const m = this.all().find((x) => x.id === ref?.plugin)
    if (!m) throw new Error(`no plugin "${ref?.plugin}" in the demo`)
    if (!this.trust(m).enabled) throw new Error(`plugin ${m.name} is off: switch it on in plugins`)
    const a: any = Object.hasOwn(m.actions, ref.action) ? m.actions[ref.action] : null
    if (!a) throw new Error(`${m.id} has no action "${ref.action}"`)
    const why = actionBlocked(a, this.trust(m).grants, m)
    if (why) throw new Error(why)
    const args = Object.fromEntries(Object.entries(ref.args && typeof ref.args === "object" ? ref.args : {}).filter(([k]) => a.params.includes(k)))
    if (a.kind === "builtin") return { ...a.action, ...args }
    if (a.kind === "app") return { type: "app", target: a.target === "bundle" ? m.detect.bundle[0] : a.target }
    return null
  }
}
