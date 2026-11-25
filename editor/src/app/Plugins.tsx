// Plugins (docs/PLUGINS.md): the installed plugins, what they show and may do, and a marketplace
// (the registry: GET /api/plugins/registry). Plus the inspector's plugin pieces: a plugin action's
// fields, a key / dial's `plugin` binding and a picker that inserts {id.value} vars into its text.
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { Segmented } from "@/components/ui/segmented-control"
import { TextField } from "@/components/ui/text-field"
import { Switch } from "@/components/ui/switch"
import { applyRecipe } from "./Recipes"
import { Group, Note, Text, Wheel } from "./fields"
import { DEMO, api, save, setOrDel, state, toast, touch, useStore, type Action } from "./store"

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>
export type Grants = { shell: boolean; schemes: string[]; network: string[] }
export type PluginAction = { name: string; title?: string; kind: string; params: string[]; blocked: string | null; timeout?: number; detach?: boolean; running?: boolean }
export type PluginSetting = { name: string; type: "string" | "number" | "boolean"; default: string | number | boolean; title: string; description?: string; value: string | number | boolean }
export type PluginInfo = {
  id: string; name: string; version?: string; author?: string; homepage?: string; description?: string
  icon?: { file?: string; glyph?: string; logo?: string }; iconUrl?: string; builtin?: string
  source: "builtin" | "local" | "user" | "linked"; dir?: string; valid: boolean; errors: string[]; warnings: string[]
  installed: boolean | null; install?: { brew?: string; url?: string; note?: string }
  enabled: boolean; updated?: boolean; permissions?: Grants; grants?: Grants; needs?: Grants
  state: string; error: string | null; values: Record<string, string>; updatedAt: number | null; vars?: string[]
  status?: { kind: string; interval: number; stale: number } | null; bots?: { kind: string; error: string | null } | null
  actions?: PluginAction[]; templates?: { keys: string[]; dials: string[]; pages: string[] }; settings?: PluginSetting[]
}
type RegEntry = {
  id: string; name: string; version: string; description?: string; author?: string; homepage?: string; icon?: string; iconUrl?: string
  tags: string[]; needs: { bundle?: string; bin?: string; brew?: string }; verified: boolean; valid: boolean; errors: string[]; warnings: string[]
  permissions?: Grants; install?: { brew?: string; url?: string; note?: string }
  installed: { source: string; version: string; sha: string | null; enabled?: boolean } | null; update: boolean; conflict: string | null
}
type Registry = { ok: boolean; error?: string; source: string | null; plugins: RegEntry[]; tags: string[]; demo?: boolean }

// ---------- one shared, polled list for the panel and the inspector ----------
const store = { list: [] as PluginInfo[], loaded: false, demo: false, listeners: new Set<() => void>() }
let inflight: Promise<void> | null = null
export function loadPlugins() {
  return (inflight ??= api<{ plugins: PluginInfo[]; demo?: boolean }>("GET", "/api/plugins")
    .then((r) => { store.list = r.plugins; store.demo = !!r.demo; store.loaded = true; store.listeners.forEach((l) => l()) })
    .catch(() => {})
    .finally(() => { inflight = null }))
}
export function usePlugins(pollMs = 0) {
  const [, bump] = React.useReducer((x: number) => x + 1, 0)
  React.useEffect(() => {
    store.listeners.add(bump)
    if (!store.loaded) loadPlugins()
    const t = pollMs ? window.setInterval(() => document.visibilityState === "visible" && loadPlugins(), pollMs) : 0
    return () => { store.listeners.delete(bump); clearInterval(t) }
  }, [pollMs])
  return store.list
}
const replace = (p: PluginInfo) => { store.list = store.list.map((x) => (x.id === p.id ? { ...x, ...p } : x)); store.listeners.forEach((l) => l()) }

export function pluginIconUrl(p: { id: string; icon?: PluginInfo["icon"] | string; iconUrl?: string }): string | null {
  if (p.iconUrl) return p.iconUrl
  const i = p.icon
  if (!i) return null
  if (typeof i === "string") return /\.(png|svg)$/.test(i) ? null : /^[A-Za-z0-9-]+$/.test(i) ? `/glyphs/${i}.svg` : null
  if (i.file) return `/plugin-icon/${p.id}.${i.file.endsWith(".svg") ? "svg" : "png"}`
  if (i.glyph) return `/glyphs/${i.glyph}.svg`
  if (i.logo) return `/logos/${i.logo}.png`
  return null
}
function PluginIcon({ p }: { p: Parameters<typeof pluginIconUrl>[0] & { name: string } }) {
  const [broken, setBroken] = React.useState(false)
  const src = pluginIconUrl(p)
  return (
    <span data-ds-plugin-icon>
      {src && !broken ? <img src={src} alt="" onError={(e) => {
        const img = e.currentTarget
        if (img.src.endsWith(".png") && img.src.includes("/logos/")) img.src = img.src.replace(/\.png$/, ".svg") // logos come as png or svg
        else setBroken(true)
      }} /> : <b>{p.name.slice(0, 1)}</b>}
    </span>
  )
}
const TONE: Record<string, string> = { ok: "ok", stale: "warn", error: "err", invalid: "err" }
export const StatePill = ({ s }: { s: string }) => <span data-ds-pill data-tone={TONE[s]}>{s}</span>
const ago = (t: number | null) => {
  if (!t) return "never"
  const s = Math.max(0, Math.round((Date.now() - t) / 1000))
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`
}
const copy = (s: string, what = s) => navigator.clipboard.writeText(s).then(() => toast(`copied ${what}`), () => toast("couldn't copy", "error"))

// ---------- a confirm step that names exactly what is being allowed ----------
type Ask = { title: string; body: React.ReactNode; confirm: string; danger?: boolean; run(): Promise<unknown> | void }
function Confirm({ ask, onDone }: { ask: Ask; onDone(): void }) {
  const [busy, setBusy] = React.useState(false)
  return (
    <div data-ds-modal data-ds-confirm role="alertdialog" aria-modal aria-labelledby="pc-title">
      <div data-kit="module" data-ds-modal-card>
        <h2 id="pc-title">{ask.title}</h2>
        <div data-ds-confirm-body>{ask.body}</div>
        <div data-ds-row>
          <Button tone="primary" disabled={busy} autoFocus onClick={async () => {
            setBusy(true)
            try { await ask.run() } catch { /* the api already toasted */ } finally { setBusy(false); onDone() }
          }}>{ask.confirm}</Button>
          <Button onClick={onDone}>cancel</Button>
        </div>
      </div>
    </div>
  )
}

const describe = (a: any): string =>
  a.kind === "cmd" ? (Array.isArray(a.cmd) ? a.cmd.map((x: string) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ") : `zsh -lc ${JSON.stringify(a.cmd)}`)
    : a.kind === "http" ? `${a.method || "GET"} ${a.http}`
    : a.kind === "url" ? `open ${a.url}`
    : a.kind === "file" ? `read ${a.file}`
    : a.kind === "app" ? `open app ${a.target}`
    : a.kind === "builtin" ? `deckstudio ${a.builtin?.type || a.builtin || "built-in"}`
    : a.kind

/** What switching a plugin on trusts: its status source and every action it declares (from GET /api/plugins/:id's manifest). */
async function enableAsk(p: PluginInfo): Promise<Ask> {
  const one = await api<PluginInfo & { manifest?: any }>("GET", `/api/plugins/${p.id}`)
  const m = one.manifest || {}
  const lines = [
    m.status && `status   ${describe(m.status)}${m.status.interval ? `  (every ${m.status.interval} s)` : ""}`,
    m.bots && `bots     ${describe(m.bots)}`,
    ...Object.entries(m.actions || {}).map(([n, a]) => `${n.padEnd(8)} ${describe(a)}`),
  ].filter(Boolean) as string[]
  return {
    title: `switch on ${p.name}?`,
    confirm: `switch on ${p.name}`,
    body: (
      <>
        <p>a switched-on plugin runs what its manifest declares, as you, with your files. {p.source === "linked" ? "it's linked to a dev folder: edits there apply live." : "it was installed from outside DeckStudio."} review it first:</p>
        <pre data-ds-cmds>{lines.length ? lines.join("\n") : "(no commands: it only offers templates)"}</pre>
        <p data-ds-note>shell, url schemes other than https and non-local network stay blocked until you allow each one below.</p>
      </>
    ),
    run: async () => replace(await api("POST", `/api/plugins/${p.id}/enable`, { enabled: true })),
  }
}
function grantAsk(p: PluginInfo, what: { shell?: true; scheme?: string; network?: string }, revoke = false): Ask {
  const g: Grants = { shell: !!p.grants?.shell, schemes: [...(p.grants?.schemes || [])], network: [...(p.grants?.network || [])] }
  if (what.shell) g.shell = !revoke
  if (what.scheme) g.schemes = revoke ? g.schemes.filter((s) => s !== what.scheme) : [...g.schemes, what.scheme]
  if (what.network) g.network = revoke ? g.network.filter((h) => h !== what.network) : [...g.network, what.network]
  const label = what.shell ? "shell" : what.scheme ? `${what.scheme}: links` : `network access to ${what.network}`
  const unblocks = (p.actions || []).filter((a) => a.blocked && (what.shell ? /shell/.test(a.blocked) : what.scheme ? a.blocked.startsWith(`${what.scheme}:`) : a.blocked.includes(what.network!)))
  return {
    title: revoke ? `revoke ${label} from ${p.name}?` : `allow ${label} for ${p.name}?`,
    confirm: revoke ? "revoke" : `allow ${label}`,
    body: revoke ? <p>{p.name} loses {label}; actions that need it are refused again.</p> : (
      <>
        <p>
          {what.shell && <>{p.name} may run <b>shell commands</b>: shell-string commands (<code>zsh -lc …</code>) and commands whose program is a shell or interpreter (sh, python, node, osascript, open…). they run as you and can do anything you can.</>}
          {what.scheme && <>{p.name} may open <b>{what.scheme}:</b> links. whatever app handles {what.scheme}: on this mac receives the link, with any values the plugin puts in it.</>}
          {what.network && <>{p.name} may send http requests to <b>{what.network}</b> (outside this mac), including values from your deck in the url or body.</>}
        </p>
        {unblocks.length > 0 && <p data-ds-note>unblocks: {unblocks.map((a) => a.title || a.name).join(", ")}</p>}
        <p data-ds-note>only this; nothing else the manifest might add later. you can revoke it here any time.</p>
      </>
    ),
    run: async () => replace(await api("POST", `/api/plugins/${p.id}/grant`, g)),
  }
}

// ---------- the panel ----------
type Recipe = { id: string; title: string; what: string; where: string; plugin?: string }
export function Plugins({ onClose }: { onClose(): void }) {
  useStore()
  const list = usePlugins(3000)
  const [tab, setTab] = React.useState<"installed" | "marketplace">("installed")
  const [open, setOpen] = React.useState<string | null>(null)
  const [ask, setAsk] = React.useState<Ask | null>(null)
  const [q, setQ] = React.useState("")
  const [recipes, setRecipes] = React.useState<Recipe[]>([])
  const loadRecipes = React.useCallback(() => api<{ recipes: Recipe[] }>("GET", "/api/recipes").then((r) => setRecipes(r.recipes.filter((x) => x.plugin))).catch(() => {}), [])
  React.useEffect(() => { loadRecipes() }, [loadRecipes, list.length])
  const shown = list.filter((p) => !q || `${p.id} ${p.name} ${p.description || ""} ${p.source}`.toLowerCase().includes(q.toLowerCase()))
  React.useEffect(() => { // escape closes the confirm step first, then the panel, wherever focus is
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); if (ask) setAsk(null); else onClose() } }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  }, [ask, onClose])
  return (
    <div data-ds-modal role="dialog" aria-modal aria-labelledby="pl-title">
      <div data-kit="module" data-ds-modal-card data-ds-recipes data-ds-plugins>
        <header data-ds-row>
          <h2 id="pl-title" style={{ flex: 1 }}>plugins</h2>
          <Segmented label="view" hideLabel value={tab} options={[{ value: "installed", label: `installed · ${list.length}` }, { value: "marketplace", label: "marketplace" }]}
            onValueChange={(v) => setTab(v as typeof tab)} />
          <input data-kit="input" placeholder="search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 160 }} aria-label="search plugins" />
          <Button round aria-label="close" onClick={onClose}><Icon name="close" /></Button>
        </header>
        {tab === "installed" ? (
          <>
            <p data-ds-note>
              small mac tools that put their status and actions on the deck through one manifest (deckstudio.json). deckstudio never loads plugin code: it runs only what a
              switched-on plugin declares, with what you allowed. {store.demo && "in this demo nothing runs on your machine: actions only say what they would do."}
            </p>
            {!store.loaded && <p data-ds-note>loading…</p>}
            {shown.map((p) => (
              <PluginCard key={`${p.source}-${p.id}-${p.dir || ""}`} p={p} open={open === p.id} toggle={() => setOpen(open === p.id ? null : p.id)}
                recipes={recipes.filter((r) => r.plugin === p.id)} setAsk={setAsk} />
            ))}
            <p data-ds-note>
              write your own: <code>deckctl plugin init my-tool</code> → <code>deckctl plugin link my-tool</code>. folders: built-in <code>plugins/</code>, this mac's own{" "}
              <code>plugins/local/</code>, installed <code>~/.deckstudio/plugins/</code>.
            </p>
          </>
        ) : (
          <Marketplace q={q} openInstalled={(id) => { setTab("installed"); setOpen(id) }} />
        )}
      </div>
      {ask && <Confirm ask={ask} onDone={() => setAsk(null)} />}
    </div>
  )
}

function PluginCard({ p, open, toggle, recipes, setAsk }: { p: PluginInfo; open: boolean; toggle(): void; recipes: Recipe[]; setAsk(a: Ask): void }) {
  const [busy, setBusy] = React.useState(false)
  const nTpl = p.templates ? p.templates.keys.length + p.templates.dials.length + p.templates.pages.length : 0
  const setEnabled = async (on: boolean) => {
    if (on && (p.source === "user" || p.source === "linked")) return setAsk(await enableAsk(p))
    setBusy(true)
    try { replace(await api("POST", `/api/plugins/${p.id}/enable`, { enabled: on })) } catch { /* toasted */ } finally { setBusy(false) }
  }
  return (
    <article data-ds-recipe data-ds-plugin data-open={open || undefined} data-id={p.id}>
      <div data-ds-plugin-head>
        <button type="button" data-ds-recipe-head onClick={toggle} aria-expanded={open}>
          <PluginIcon p={p} />
          <strong>{p.name}</strong>
          <span data-ds-tag>{p.version}</span>
          <span data-ds-tag data-source={p.source}>{p.source}</span>
          <StatePill s={p.state} />
          <span data-ds-note data-ds-plugin-sub>{p.errors?.[0] || p.error || p.description || ""}</span>
        </button>
        {p.valid && (
          <button type="button" role="switch" aria-checked={p.enabled} aria-label={`${p.name} on`} data-kit="switch" data-checked={p.enabled || undefined}
            disabled={busy} onClick={() => setEnabled(!p.enabled)}>
            <span data-kit="switch-thumb" />
          </button>
        )}
      </div>
      {open && (
        <div data-ds-recipe-body>
          {p.description && <p data-ds-note>{p.description}{p.author ? ` · ${p.author}` : ""}{p.homepage ? <> · <a href={p.homepage} target="_blank" rel="noreferrer noopener">{p.homepage.replace(/^https:\/\//, "")}</a></> : null}</p>}
          {p.errors?.length > 0 && <ul data-ds-plugin-errors>{p.errors.map((e) => <li key={e}>✗ {e}</li>)}</ul>}
          {p.warnings?.length > 0 && <ul data-ds-plugin-warnings>{p.warnings.map((w) => <li key={w}>! {w}</li>)}</ul>}
          {p.error && <p data-ds-warn>last read failed: {p.error}</p>}
          {p.installed === false && <InstallHint p={p} />}
          {p.valid && <Permissions p={p} setAsk={setAsk} />}
          {p.valid && (p.settings?.length || 0) > 0 && <Settings p={p} />}
          {p.valid && <Values p={p} />}
          {p.valid && (p.actions?.length || 0) > 0 && <Actions p={p} />}
          {p.valid && nTpl > 0 && <Templates p={p} recipes={recipes} />}
          <div data-ds-row>
            {p.valid && !store.demo && <Button onClick={async () => { replace(await api("POST", `/api/plugins/${p.id}/refresh`)); toast(`${p.name}: re-read`) }}><Icon name="restart" /> re-read status</Button>}
            {p.source === "user" && (
              <Button onClick={() => setAsk({
                title: `uninstall ${p.name}?`, confirm: "uninstall", danger: true,
                body: <p>its folder moves to <code>~/.deckstudio/plugins/.removed/</code>. keys that use it show "plugin broken" until you remove them or reinstall it.</p>,
                run: async () => { await api("POST", "/api/plugins/uninstall", { id: p.id }); await loadPlugins(); toast(`uninstalled ${p.name}`) },
              })}><Icon name="trash" /> uninstall</Button>
            )}
            {p.source === "linked" && <span data-ds-note>linked dev folder: <code>deckctl plugin unlink {p.id}</code></span>}
            {p.dir && <span data-ds-note data-ds-plugin-dir title={p.dir}>{p.dir.replace(/^\/Users\/[^/]+/, "~")}</span>}
          </div>
        </div>
      )}
    </article>
  )
}

function InstallHint({ p }: { p: { name: string; install?: PluginInfo["install"] } }) {
  const i = p.install || {}
  const cmd = i.brew ? `brew install ${i.brew}` : ""
  return (
    <div data-ds-plugin-install>
      <p data-ds-warn>{p.name} isn't installed on this mac{cmd || i.url ? ": install it yourself, deckstudio never runs installers." : "."}</p>
      {cmd && (
        <div data-ds-row data-ds-cmdline>
          <code>{cmd}</code>
          <Button onClick={() => copy(cmd, "the install command")}><Icon name="copy" /> copy</Button>
        </div>
      )}
      {i.url && <p data-ds-note><a href={i.url} target="_blank" rel="noreferrer noopener">{i.url}</a></p>}
      {i.note && <p data-ds-note>{i.note}</p>}
      <p data-ds-note>once installed it's noticed within a minute{!store.demo && <> — or <button type="button" data-ds-linkbtn onClick={() => api("POST", "/api/plugins/rescan").then(() => loadPlugins())}>check now</button></>}.</p>
    </div>
  )
}

function Permissions({ p, setAsk }: { p: PluginInfo; setAsk(a: Ask): void }) {
  const d = p.permissions || { shell: false, schemes: [], network: [] }
  const g = p.grants || { shell: false, schemes: [], network: [] }
  const items = [
    ...(d.shell ? [{ key: "shell", label: "shell commands", on: g.shell, what: { shell: true as const } }] : []),
    ...d.schemes.map((s) => ({ key: `s-${s}`, label: `${s}: links`, on: g.schemes.includes(s), what: { scheme: s } })),
    ...d.network.map((h) => ({ key: `n-${h}`, label: `network · ${h}`, on: g.network.includes(h), what: { network: h } })),
  ]
  const blocked = (p.actions || []).filter((a) => a.blocked)
  return (
    <section data-ds-plugin-sec>
      <h4>permissions</h4>
      {!items.length ? <p data-ds-note>needs nothing beyond its own commands (argv, loopback http, files).</p> : (
        <ul data-ds-providers>
          {items.map((it) => (
            <li key={it.key} data-ds-provider>
              <b>{it.label}</b>
              <span data-ds-pill data-tone={it.on ? "ok" : undefined}>{it.on ? "allowed" : "blocked"}</span>
              <Button tone={it.on ? undefined : "primary"} onClick={() => setAsk(grantAsk(p, it.what, it.on))}>{it.on ? "revoke" : "allow…"}</Button>
            </li>
          ))}
        </ul>
      )}
      {blocked.length > 0 && <p data-ds-note>blocked now: {blocked.map((a) => `${a.title || a.name} (${a.blocked})`).join(" · ")}</p>}
      {p.updated && <p data-ds-note>⚠ updated — review changes: this plugin's manifest changed since you switched it on, so it is off (no permissions) until you review it and switch it on again.</p>}
      {!p.enabled && !p.updated && <p data-ds-note>switched off: nothing runs, its keys dim with "plugin off".</p>}
    </section>
  )
}

// The plugin's settings (manifest `settings`), saved in profile.plugins[id].settings; used as {settings.x} in its
// commands / status path / value paths and as {id.settings.x} on keys.
function Settings({ p }: { p: PluginInfo }) {
  const [draft, setDraft] = React.useState<Record<string, string | number | boolean | null>>({})
  const [n, remount] = React.useReducer((x: number) => x + 1, 0)
  const dirty = Object.keys(draft).length > 0
  const set = (s: PluginSetting, v: string | boolean) => {
    const val = s.type === "boolean" ? !!v : s.type === "number" ? (String(v).trim() === "" ? null : Number(v)) : String(v)
    setDraft((d) => ({ ...d, [s.name]: val }))
  }
  const saveAll = async () => {
    const bad = Object.entries(draft).find(([k, v]) => p.settings!.find((s) => s.name === k)?.type === "number" && v !== null && !Number.isFinite(v as number))
    if (bad) return toast(`${bad[0]}: a number`, "error")
    try { replace(await api("POST", `/api/plugins/${p.id}/settings`, { settings: draft })); setDraft({}); toast(`${p.name}: settings saved`) } catch { /* toasted */ }
  }
  return (
    <section data-ds-plugin-sec>
      <h4>settings</h4>
      <div data-ds-plugin-settings key={n}>
        {p.settings!.map((s) => (
          <div key={s.name} title={s.description}>
            {s.type === "boolean"
              ? <Switch label={s.title} defaultChecked={!!s.value} onCheckedChange={(c) => set(s, c)} />
              : <TextField label={s.title} defaultValue={String(s.value ?? "")} placeholder={String(s.default ?? "")} hint={s.description} onValueChange={(v) => set(s, v)} />}
            <span data-ds-note><code>{`{${p.id}.settings.${s.name}}`}</code>{s.description ? ` · ${s.description}` : ""}</span>
          </div>
        ))}
      </div>
      <div data-ds-row>
        <Button tone="primary" disabled={!dirty} onClick={saveAll}>save settings</Button>
        {dirty && <Button onClick={() => { setDraft({}); remount() }}>discard</Button>}
        <Button disabled={dirty} onClick={async () => { try { replace(await api("POST", `/api/plugins/${p.id}/settings`, { settings: Object.fromEntries(p.settings!.map((s) => [s.name, null])) })); remount(); toast(`${p.name}: settings reset`) } catch { /* toasted */ } }}>reset to defaults</Button>
      </div>
    </section>
  )
}

function Values({ p }: { p: PluginInfo }) {
  const names = Object.keys(p.values || {})
  const vars = names.length ? names.map((n) => `{${p.id}.${n}}`) : (p.vars || []).filter((v) => !v.endsWith("._state}"))
  return (
    <section data-ds-plugin-sec>
      <h4>values {p.status && <span data-ds-note>· {p.status.kind} every {p.status.interval} s · updated {ago(p.updatedAt)}</span>}</h4>
      {!p.status ? <p data-ds-note>no status source: only actions and templates.</p> : (
        <table data-ds-plugin-values>
          <tbody>
            {vars.map((v) => {
              const n = v.slice(p.id.length + 2, -1)
              return (
                <tr key={v}>
                  <td><button type="button" data-ds-linkbtn title="copy the template var" onClick={() => copy(v)}><code>{v}</code></button></td>
                  <td>{p.enabled ? (p.values?.[n] === "" ? <span data-ds-note>empty</span> : p.values?.[n] ?? <span data-ds-note>—</span>) : <span data-ds-note>off</span>}</td>
                </tr>
              )
            })}
            <tr><td><button type="button" data-ds-linkbtn onClick={() => copy(`{${p.id}._state}`)}><code>{`{${p.id}._state}`}</code></button></td><td>{p.state}</td></tr>
          </tbody>
        </table>
      )}
    </section>
  )
}

function Actions({ p }: { p: PluginInfo }) {
  const [args, setArgs] = React.useState<Record<string, Record<string, string>>>({})
  const [busy, setBusy] = React.useState("")
  return (
    <section data-ds-plugin-sec>
      <h4>actions</h4>
      {p.actions!.map((a) => (
        <div key={a.name} data-ds-plugin-action>
          <div data-ds-row>
            <strong>{a.title || a.name}</strong>
            <span data-ds-tag>{a.kind}</span>
            <code data-ds-note>{a.name}</code>
            <span data-ds-spacer />
            <Button disabled={!!busy || !p.enabled || !!a.blocked || p.installed === false}
              title={!p.enabled ? "switch the plugin on first" : a.blocked || (p.installed === false ? "not installed" : `run ${p.id}.${a.name} now`)}
              onClick={async () => {
                setBusy(a.name)
                try { await api("POST", `/api/plugins/${p.id}/action`, { action: a.name, args: args[a.name] || {} }); toast(`ran ${p.name} · ${a.title || a.name}`) } catch { /* toasted */ } finally { setBusy("") }
              }}>
              <Icon name="play" /> run
            </Button>
          </div>
          {a.params.length > 0 && (
            <div data-ds-row data-ds-inline>
              {a.params.map((n) => (
                <input key={n} data-kit="input" placeholder={n} aria-label={`${a.name} ${n}`} value={args[a.name]?.[n] || ""}
                  onChange={(e) => setArgs({ ...args, [a.name]: { ...args[a.name], [n]: e.target.value } })} />
              ))}
            </div>
          )}
          {a.blocked && <p data-ds-warn>{a.blocked}</p>}
        </div>
      ))}
    </section>
  )
}

function Templates({ p, recipes }: { p: PluginInfo; recipes: Recipe[] }) {
  useStore()
  const sel = state.sel as { kind: string; index?: number }
  const [slot, setSlot] = React.useState<Record<string, number>>({})
  const entries = (["keys", "dials", "pages"] as const).flatMap((k) => (p.templates?.[k] || []).map((name) => ({ name, where: k.slice(0, -1) as "key" | "dial" | "page" })))
  return (
    <section data-ds-plugin-sec>
      <h4>templates</h4>
      {entries.map(({ name, where }) => {
        const id = `plugin-${p.id}-${name}`
        const r = recipes.find((x) => x.id === id)
        const n = where === "key" ? 8 : 4
        const idx = slot[id] ?? (sel.kind === where && sel.index != null ? sel.index : 0)
        return (
          <div key={id} data-ds-plugin-action>
            <div data-ds-row>
              <strong>{r?.title || name}</strong>
              <span data-ds-tag>{where}</span>
              <span data-ds-spacer />
              {where !== "page" && (
                <Segmented label={`${where} slot`} hideLabel options={Array.from({ length: n }, (_, i) => ({ value: String(i), label: String(i + 1) }))}
                  value={String(idx)} onValueChange={(v) => setSlot({ ...slot, [id]: Number(v) })} />
              )}
              <Button tone="primary" disabled={!p.enabled} title={p.enabled ? undefined : "switch the plugin on first"} onClick={() => applyRecipe(id, where, where === "page" ? undefined : idx, {}, r?.title || name)}>
                <Icon name="plus" /> {where === "page" ? "add as a page" : `add to ${where} ${idx + 1}`}
              </Button>
            </div>
            {r?.what && <p data-ds-note>{r.what}</p>}
          </div>
        )
      })}
      <p data-ds-note>applies to the page you're on ({state.profile?.pages[state.page]?.name}); ⌘z undoes it.{!p.enabled && " switch the plugin on to add its keys."}</p>
    </section>
  )
}

// ---------- marketplace ----------
function Marketplace({ q, openInstalled }: { q: string; openInstalled(id: string): void }) {
  const [reg, setReg] = React.useState<Registry | null>(null)
  const [tag, setTag] = React.useState("")
  const [busy, setBusy] = React.useState("")
  const load = React.useCallback(() => api<Registry>("GET", "/api/plugins/registry").then(setReg).catch((e) => setReg({ ok: false, error: (e as Error).message, source: null, plugins: [], tags: [] })), [])
  React.useEffect(() => { load() }, [load])
  if (!reg) return <p data-ds-note>loading the registry…</p>
  const shown = reg.plugins.filter((p) => (!tag || p.tags.includes(tag)) && (!q || `${p.id} ${p.name} ${p.description || ""} ${p.tags.join(" ")}`.toLowerCase().includes(q.toLowerCase())))
  const install = async (e: RegEntry) => {
    setBusy(e.id)
    try {
      await api("POST", "/api/plugins/install", { id: e.id })
      await Promise.all([load(), loadPlugins()])
      toast(`${e.update ? "updated" : "installed"} ${e.name}: it starts switched off — review it, then switch it on`)
      openInstalled(e.id)
    } catch { /* toasted */ } finally { setBusy("") }
  }
  return (
    <>
      <p data-ds-note>
        {reg.ok ? <>plugins from <code>{reg.source}</code>{reg.demo ? " (a bundled copy)" : ""}. each manifest is checked against the registry's sha-256 before it can be installed. installing only copies its folder to <code>~/.deckstudio/plugins/</code>: it starts switched off and runs nothing until you switch it on.</>
          : <>no registry {reg.source ? <>at <code>{reg.source}</code></> : ""}: {reg.error}. {store.demo ? "" : <>the registry ships in deckstudio's <code>registry/</code> folder (<code>git pull</code> updates it). to use another one, set <code>DECKSTUDIO_REGISTRY</code> (a folder or an https url to its index.json), then restart deckstudio.</>}</>}
      </p>
      {reg.tags.length > 0 && (
        <div data-ds-row data-ds-tags role="group" aria-label="filter by tag">
          {["", ...reg.tags].map((t) => <button key={t || "all"} type="button" data-ds-chip data-on={tag === t || undefined} onClick={() => setTag(t)}>{t || "all"}</button>)}
        </div>
      )}
      {reg.ok && !shown.length && <p data-ds-note>nothing matches.</p>}
      {shown.map((e) => {
        const ok = e.verified && e.valid
        const st = e.conflict ? "conflict" : e.update ? "update available" : e.installed ? "installed" : ok ? "" : "can't install"
        return (
          <article key={e.id} data-ds-recipe data-ds-plugin data-ds-market data-id={e.id}>
            <div data-ds-plugin-head>
              <div data-ds-recipe-head>
                <PluginIcon p={e} />
                <strong>{e.name}</strong>
                <span data-ds-tag>{e.version}</span>
                {st && <span data-ds-pill data-tone={e.update ? "warn" : e.installed && !e.conflict ? "ok" : !ok || e.conflict ? "err" : undefined}>{st}</span>}
                {e.tags.map((t) => <span key={t} data-ds-tag>{t}</span>)}
              </div>
              {e.installed && !e.update ? (
                <Button onClick={() => openInstalled(e.id)}>show</Button>
              ) : (
                <Button tone={ok && !e.conflict ? "primary" : undefined} disabled={!ok || !!e.conflict || !!busy} title={!ok ? e.errors[0] : e.conflict || undefined} onClick={() => install(e)}>
                  <Icon name="download" /> {busy === e.id ? "installing…" : e.update ? "update" : "install"}
                </Button>
              )}
            </div>
            <div data-ds-recipe-body>
              {e.description && <p data-ds-note>{e.description}{e.author ? ` · ${e.author}` : ""}</p>}
              {e.update && e.installed && <p data-ds-note>installed {e.installed.version} → {e.version}{e.installed.version === e.version ? " (same version, different manifest)" : ""}. updating switches it off for review.</p>}
              <p data-ds-note>
                {[e.needs.bundle && `app ${e.needs.bundle}`, e.needs.bin && `program ${e.needs.bin}`].filter(Boolean).join(" · ") || "needs no other app"}
                {e.permissions && (e.permissions.shell || e.permissions.schemes.length || e.permissions.network.length)
                  ? ` · asks for ${[e.permissions.shell && "shell", ...e.permissions.schemes.map((s) => `${s}: links`), ...e.permissions.network.map((h) => `network ${h}`)].filter(Boolean).join(", ")}` : ""}
              </p>
              {e.needs.brew && (
                <div data-ds-row data-ds-cmdline>
                  <code>brew install {e.needs.brew}</code>
                  <Button onClick={() => copy(`brew install ${e.needs.brew}`, "the install command")}><Icon name="copy" /> copy</Button>
                </div>
              )}
              {!ok && <ul data-ds-plugin-errors>{e.errors.map((x) => <li key={x}>✗ {x}</li>)}</ul>}
            </div>
          </article>
        )
      })}
    </>
  )
}

// ---------- inspector pieces ----------
/** Fields for { type: "plugin", plugin, action, args }: pick a plugin, then one of its actions, then its params. */
export function PluginActionFields({ cur }: { cur: Action }) {
  useStore()
  const list = usePlugins()
  const valid = list.filter((p) => p.valid)
  const p = valid.find((x) => x.id === cur.plugin)
  const args = React.useMemo<Obj>(() => cur.args ?? {}, [cur])
  const sync = () => { if (Object.keys(args).length) cur.args = args; else delete cur.args }
  const pick = React.useCallback((id: string) => {
    if (id === cur.plugin) return
    save()
    cur.plugin = id
    const np = store.list.find((x) => x.id === id)
    cur.action = np?.actions?.[0]?.name
    if (!cur.action) delete cur.action
    delete cur.args
    state.formKey++
    touch()
  }, [cur])
  const pickAction = React.useCallback((a: string) => { save(); cur.action = a; delete cur.args; state.formKey++; touch() }, [cur])
  const a = p?.actions?.find((x) => x.name === cur.action)
  return (
    <>
      <Wheel key={`p-${cur.plugin}`} obj={{ v: cur.plugin || "" }} k="v" label="plugin" dflt=""
        options={[...(cur.plugin && !p ? [{ value: cur.plugin, label: `${cur.plugin} (not found)` }] : []), ...(!cur.plugin ? [{ value: "", label: "choose a plugin…" }] : []),
          ...valid.map((x) => ({ value: x.id, label: `${x.name}${x.enabled ? "" : " (off)"}` }))]} onChange={pick} />
      {p && (
        <Wheel key={`a-${cur.plugin}-${cur.action}`} obj={{ v: cur.action || "" }} k="v" label="action" dflt=""
          options={[...(!a ? [{ value: cur.action || "", label: cur.action ? `${cur.action} (not found)` : "choose an action…" }] : []), ...(p.actions || []).map((x) => ({ value: x.name, label: x.title || x.name }))]}
          onChange={pickAction} />
      )}
      {a?.params.map((n) => <Text key={`${a.name}-${n}`} obj={args} k={n} label={n} placeholder="text · {value} {delta} {index} · {plugin.value}" after={sync} />)}
      {p && (!p.enabled || p.installed === false || a?.blocked) && (
        <Note>⚠ {!p.enabled ? `${p.name} is switched off: open plugins to switch it on.` : p.installed === false ? `${p.name} isn't installed on this mac.` : a!.blocked}</Note>
      )}
    </>
  )
}

/** A key / dial's `plugin` binding (dims it when the plugin can't work) and an inserter for {id.value} vars. */
export function PluginGroup({ obj, fields }: { obj: Obj; fields: { k: string; label: string }[] }) {
  useStore()
  const list = usePlugins(5000)
  const valid = list.filter((p) => p.valid)
  const [target, setTarget] = React.useState(fields[0].k)
  const bound = valid.find((p) => p.id === obj.plugin)
  const sources = bound ? [bound, ...valid.filter((p) => p !== bound)] : valid
  const insert = (v: string) => {
    save()
    obj[target] = `${obj[target] ?? ""}${v}`
    if (!obj.plugin && !bound) obj.plugin = v.slice(1, v.indexOf("."))
    state.formKey++
    touch()
  }
  if (!valid.length) return null
  return (
    <Group legend="plugin">
      <Wheel key={`pb-${obj.plugin || ""}`} obj={{ v: obj.plugin || "none" }} k="v" label="uses plugin (dims when it can't work)" dflt="none"
        options={[{ value: "none", label: "none" }, ...(obj.plugin && !bound ? [{ value: obj.plugin, label: `${obj.plugin} (not found)` }] : []), ...valid.map((p) => ({ value: p.id, label: p.name }))]}
        onChange={(v) => { setOrDel(obj, "plugin", v === "none" ? "" : v); state.formKey++ }} />
      {bound && <Note><StatePill s={bound.state} /> {bound.state === "disabled" ? "switched off in plugins" : bound.state === "missing" ? "not installed on this mac" : bound.error || ""}</Note>}
      <Segmented label="insert a live value into" options={fields.map((f) => ({ value: f.k, label: f.label }))} value={target} onValueChange={setTarget} />
      <div data-ds-plugin-vars role="list" aria-label="plugin values">
        {sources.flatMap((p) => {
          const names = Object.keys(p.values || {}).length ? Object.keys(p.values) : (p.vars || []).map((v) => v.slice(p.id.length + 2, -1)).filter((n) => n !== "_state")
          return [...names, "_state"].map((n) => {
            const v = `{${p.id}.${n}}`
            const val = n === "_state" ? p.state : p.values?.[n]
            return (
              <button key={v} type="button" role="listitem" data-ds-chip title={`insert ${v} into ${target}`} onClick={() => insert(v)}>
                <code>{v}</code>{val != null && val !== "" && <em>{String(val).slice(0, 16)}</em>}
              </button>
            )
          })
        })}
      </div>
      {DEMO && <Note>demo: values are simulated from the demo's own state.</Note>}
    </Group>
  )
}
