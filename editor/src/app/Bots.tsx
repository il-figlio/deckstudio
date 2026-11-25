// Bots · bring your own (BYOB): Grok Bot is built in, any other bot app joins with one small JSON
// document (a file in ~/.deckstudio/bots, POST /api/bots, or a command that prints it).
// Here: the provider list + setup, the key binding (key.bot) and a bots page's filter / slot order.
import * as React from "react"
import { Segmented } from "@/components/ui/segmented-control"
import { EXAMPLE_DOC, GROK, botPress, findBot, parseBotDocs, pressSummary, providerId, providerTrust } from "@deck/bot-schema.mjs"
import { DEMO, api, save, select, state, toast, touch } from "./store"

/* eslint-disable @typescript-eslint/no-explicit-any */
export type Bot = {
  key: string; id: string; provider: string; name: string; fullName: string
  avatar?: { shape?: string; color?: string; image?: string; logo?: string; glyph?: string; emoji?: string } | null
  thumb?: string | null; unread: number; awaiting: boolean; press?: string; blocked?: boolean
}
export type Provider = {
  id: string; name: string; kind: "grokbot" | "file" | "command" | "import" | "sample"
  app?: string; logo?: string; available?: boolean; count: number; error?: string | null; file?: string; cmd?: string; interval?: number
  enabled?: boolean; stale?: boolean; duplicate?: boolean; schemes?: string[]; allowed?: string[]; allowShell?: boolean; blockedSchemes?: string[]; shell?: number
}
type BotsInfo = { providers: Provider[]; bots: Bot[]; source?: string; dir?: string }

// one shared poll for every component that shows bots; paused while the tab is hidden
const changed = () => dispatchEvent(new Event("deck-bots-changed"))
let botsInfo: BotsInfo | null = null
const botsSubs = new Set<(i: BotsInfo) => void>()
let botsTimer = 0
function loadBots() {
  api<BotsInfo>("GET", "/api/bots").then((r) => { botsInfo = { ...r, providers: r.providers || [], bots: r.bots || [] }; botsSubs.forEach((f) => f(botsInfo!)) }).catch(() => {})
}
function pollBots() {
  clearInterval(botsTimer); botsTimer = 0
  if (!DEMO && botsSubs.size && !document.hidden) botsTimer = window.setInterval(loadBots, 5000) // files and commands change on their own
}
addEventListener("deck-bots-changed", loadBots)
document.addEventListener("visibilitychange", () => { pollBots(); if (!document.hidden && botsSubs.size) loadBots() })
export function useBotsInfo() {
  const [info, setInfo] = React.useState<BotsInfo | null>(botsInfo)
  React.useEffect(() => {
    botsSubs.add(setInfo)
    if (botsSubs.size === 1) { loadBots(); pollBots() } else if (botsInfo) setInfo(botsInfo)
    return () => { botsSubs.delete(setInfo); if (!botsSubs.size) pollBots() }
  }, [])
  return info
}
/** profile.botProviders: the user's own say per provider (on the deck, url schemes, shell). Never set from a bots document. */
function setTrust(id: string, patch: { enabled?: boolean; schemes?: string[]; allowShell?: boolean }) {
  const p = state.profile!
  save()
  const list = (p.botProviders ||= [])
  const c = list.find((x) => x.id === id)
  if (c) Object.assign(c, patch)
  else list.push({ id, ...patch })
  touch(); setTimeout(changed, 600)
}
export const useBots = () => useBotsInfo()?.bots || []

const copy = (t: string, what: string) => navigator.clipboard.writeText(t).then(() => toast(`${what} copied`), () => toast("couldn't reach the clipboard", "error"))

// ---------- Grok Bot export (the browser demo can't read the visitor's Mac, so they export it) ----------
// Reads Grok Bot's local roster on the visitor's own Mac (JavaScript for Automation ships with macOS)
// and copies ONLY id, name, avatar shape/color and unread/awaiting to the clipboard. Nothing is uploaded.
const EXPORT_JXA = 'ObjC.import("Foundation");const dir=$("~/Library/Application Support/Grok Bot/sand-client-persistence").stringByExpandingTildeInPath.js;const files=ObjC.deepUnwrap($.NSFileManager.defaultManager.contentsOfDirectoryAtPathError(dir,null))||[];let bots=[];for(const f of files){const s=ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(dir+"/"+f,$.NSUTF8StringEncoding,null));if(!s||s.indexOf("avatarShape")<0)continue;try{const rows=JSON.parse(s).value.rows;if(Array.isArray(rows)&&rows.length&&"avatarShape" in rows[0]){bots=rows.filter(r=>!r.isRemovedFromSidebar&&!r.isHiddenFromSidebar).map(r=>({id:r.id,name:r.name,shape:r.avatarShape||"blob",color:r.avatarColor||"black",unread:r.unreadCount||0,awaiting:!!r.awaitingUserResponse}));break}}catch(e){}}JSON.stringify({grokbots:1,bots})'
export const EXPORT_COMMAND = `osascript -l JavaScript -e '${EXPORT_JXA}' | pbcopy && echo "copied your grok bots — paste them into DeckStudio"`
const EXPORT_PREVIEW = `osascript -l JavaScript -e '…reads grok bot's list…' | pbcopy`
export const EXPORT_PROMPT = `Export my Grok Bot roster for DeckStudio. Grok Bot keeps a local cache in ~/Library/Application Support/Grok Bot/sand-client-persistence; one of those files is JSON whose value.rows is the bot roster (fields id, name, avatarShape, avatarColor, unreadCount, awaitingUserResponse, isHiddenFromSidebar, isRemovedFromSidebar). Output ONLY {"grokbots":1,"bots":[{"id","name","shape","color","unread","awaiting"}]} for bots that aren't hidden or removed, and copy it to my clipboard with pbcopy. Don't print or keep any other data (no transcripts, no secrets files). Or simply run:\n\n${EXPORT_COMMAND}`

// ---------- any bot app: the JSON format ----------
export const EXAMPLE_JSON = JSON.stringify(EXAMPLE_DOC, null, 2)
const FORMAT_NOTES = `Format "bots/v1" (only id and name are required per bot):
- provider: a short id for the app (a-z, 0-9, -). name: how the app is shown. app: its macOS bundle id (optional; hold a bot key to open the app).
- avatar: {"shape","color"} (shapes: arch bean blob capsule cloud clover crystal cylinder dome egg flower gem heart hex house leaf pebble pumpkin shield sparkle square squircle star tablet teardrop wedge; colors: red orange yellow green cyan blue violet magenta brown gray black white) | {"glyph": "<carbon icon name>"} | {"emoji": "🤖"} | {"image": "https://… or data:image/png;base64,…"} | {"logo": "<DeckStudio logo name>"}
- unread: a number (shows a badge). awaiting: true when the bot is waiting on the user (red lamp, the key shakes). hidden: true keeps it off the deck. activityAt: ISO time or ms (recent first).
- open: what pressing the key does: {"type":"url","url":"https://… or <scheme>://…"} | {"type":"app","target":"<bundle id>"} | {"type":"shell","cmd":"…"}
- schemes: url schemes besides https the bots open (e.g. ["myapp"]). The user still has to allow them (and shell) for this provider in DeckStudio; until then those presses are blocked. New providers stay off the deck until the user switches them on.`
function agentPrompt(app: string) {
  const who = app.trim() || "my bot app"
  const deliver = DEMO
    ? `Print the JSON and copy it to my clipboard with pbcopy, so I can paste it into DeckStudio's "any bot app" import box. Don't print or keep anything else.`
    : `Deliver it one of these ways (pick what fits ${who}):
- write it to ~/.deckstudio/bots/<provider>.json — DeckStudio re-reads that folder every few seconds; rewrite it whenever a bot's unread/awaiting status changes;
- or POST it to http://127.0.0.1:7337/api/bots with header "x-deck-token: $(cat ~/.deckstudio/token)" (add "merge": true to update some bots and keep the rest), and POST /api/bots/status {"provider","id","unread","awaiting"} for quick status changes;
- or, if ${who} has a CLI, make a command that prints the JSON and add it to my DeckStudio profile as profile.botProviders: [{"type":"command","id":"<provider>","cmd":"…","interval":15}].
Then check GET /api/bots (same token header): the bots should be listed under that provider.`
  return `Make ${who}'s bots show up on my Stream Deck through DeckStudio's "bring your own bots" format.
1. Find where ${who} keeps its bots/agents and their status (local files, a CLI or an API). Read only ids, names, avatar hints and unread/waiting state — no conversations, no secrets.
2. Produce JSON like this example:
${EXAMPLE_JSON}

${FORMAT_NOTES}

3. ${deliver}`
}
const curlFor = () => `curl -s -X POST http://127.0.0.1:7337/api/bots -H "x-deck-token: $(cat ~/.deckstudio/token)" -H "content-type: application/json" -d @my-bot-app.json`

// ---------- avatar chip ----------
export function BotAvatar({ b }: { b: Bot }) {
  if (b.thumb) return <img src={b.thumb} alt="" />
  return <span data-ds-bot-emoji aria-hidden>{b.avatar?.emoji || "🤖"}</span>
}
function BotChip({ b, on, onClick, showProvider }: { b: Bot; on?: boolean; onClick(): void; showProvider?: boolean }) {
  return (
    <button type="button" data-ds-bot data-on={on || undefined} data-blocked={b.blocked || undefined} title={`${b.fullName} · ${b.provider}${b.press ? `\npress: ${b.press}` : ""}`} onClick={onClick}>
      <BotAvatar b={b} />
      <span>{b.name}</span>
      {showProvider && b.provider !== GROK.id && <small>{b.provider}</small>}
      {(b.unread > 0 || b.awaiting) && <em>{b.awaiting ? "!" : b.unread}</em>}
    </button>
  )
}

// ---------- paste-to-import box, with a reason whenever the button is off ----------
function ImportBox({ placeholder, step }: { placeholder: string; step?: number }) {
  const hint = React.useId()
  const [text, setText] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const check = React.useMemo(() => {
    const t = text.trim()
    if (!t) return { ok: false, msg: step ? `paste what step ${step - 1} copied, then import.` : "paste the json first, then import." }
    try {
      const docs = parseBotDocs(t)
      const n = docs.reduce((s, d) => s + d.bots.length, 0)
      if (!DEMO && docs.some((d) => d.provider === GROK.id)) return { ok: false, msg: "that's a grok bot export — on this mac grok bot is already read live." }
      // what presses would do, under what this profile trusts today
      const presses = docs.flatMap((d) => d.bots.map((b) => botPress(b, providerTrust(state.profile?.botProviders, d.provider, d.schemes), d.app)))
      return { ok: true, ids: docs.map((d) => d.provider), msg: `ready: ${n} bot${n === 1 ? "" : "s"} from ${docs.map((d) => d.name).join(", ")}. ${pressSummary(presses)}.` }
    } catch (e) {
      const m = (e as Error).message
      return { ok: false, msg: /JSON|Unexpected|token/i.test(m) ? "that isn't complete json yet — paste the whole output." : m }
    }
  }, [text, step])
  return (
    <div data-ds-import>
      <textarea data-kit="input" data-multiline="" rows={3} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} aria-describedby={hint} />
      <div data-ds-row>
        <button type="button" data-ds-chipbtn data-primary disabled={!check.ok || busy} onClick={async () => {
          setBusy(true)
          try {
            const r = await api<{ count: number }>("POST", "/api/bots/import", { text })
            // pasting it here is the user's own act: switch those providers on (urls beyond https and shell stay off)
            if (!DEMO && "ids" in check) for (const id of check.ids ?? []) if (!providerTrust(state.profile?.botProviders, id).enabled) setTrust(id, { enabled: true })
            toast(`imported ${r.count} bots`); setText(""); changed(); state.formKey++; touch()
          } catch { /* toasted by api() */ } finally { setBusy(false) }
        }}>{busy ? "importing…" : "import bots"}</button>
        <span id={hint} data-ds-hint data-ok={check.ok || undefined}>{check.msg}</span>
      </div>
    </div>
  )
}

function GrokSetup({ p }: { p?: Provider }) {
  if (!DEMO) {
    return p?.available
      ? <p data-ds-note>detected. deckstudio reads grok bot's own list on this mac, live: nothing to set up. {p.count} bots.</p>
      : <p data-ds-note>grok bot isn't installed on this mac (its roster wasn't found). install it, or bring bots from another app with the <b>any bot app</b> tab.</p>
  }
  return (
    <ol data-ds-steps>
      <li>
        <b>copy the export command</b>
        <div data-ds-cmdline>
          <code title={EXPORT_COMMAND}>{EXPORT_PREVIEW}</code>
          <button type="button" data-ds-chipbtn data-primary onClick={() => copy(EXPORT_COMMAND, "command")}>copy command</button>
        </div>
        <details data-ds-more><summary>see the whole command</summary><pre data-ds-cmds>{EXPORT_COMMAND}</pre></details>
        <span data-ds-hint>it reads grok bot's local list and copies only names, avatar shapes and colors, and unread counts. nothing is uploaded.</span>
      </li>
      <li>
        <b>run it in terminal</b>
        <span data-ds-hint>open terminal, paste, press return. it answers “copied your grok bots”. rather not? <button type="button" data-ds-linkbtn onClick={() => copy(EXPORT_PROMPT, "prompt")}>copy a prompt for your agent</button> instead.</span>
      </li>
      <li>
        <b>paste it here</b>
        <ImportBox placeholder='{"grokbots":1,"bots":[…]}' step={3} />
      </li>
    </ol>
  )
}

function JsonSetup({ dir }: { dir?: string }) {
  const [app, setApp] = React.useState("")
  const file = `${dir ? dir.replace(/^\/Users\/[^/]+/, "~") : "~/.deckstudio/bots"}/${providerId(app, "my-bot-app")}.json`
  return (
    <>
      <p data-ds-note>any bot or agent app can sit on the deck next to grok's: it describes its bots in one small json document. only <code>id</code> and <code>name</code> are required; avatar, unread, waiting and what a press opens are optional.</p>
      <div data-ds-row>
        <input data-kit="input" placeholder="your bot app's name" value={app} onChange={(e) => setApp(e.target.value)} style={{ flex: 1, minWidth: 120 }} />
      </div>
      <div data-ds-row>
        <button type="button" data-ds-chipbtn data-primary onClick={() => copy(agentPrompt(app), "agent prompt")}>copy a prompt for your agent</button>
        <button type="button" data-ds-chipbtn onClick={() => copy(EXAMPLE_JSON, "example json")}>copy example json</button>
        {!DEMO && <button type="button" data-ds-chipbtn onClick={() => copy(curlFor(), "curl command")}>copy curl</button>}
      </div>
      <details data-ds-more><summary>see the format</summary><pre data-ds-cmds>{EXAMPLE_JSON}</pre><p data-ds-note data-ds-pre>{FORMAT_NOTES}</p></details>
      <ol data-ds-steps>
        <li><b>get the json</b><span data-ds-hint>hand the prompt to your agent (claude code, codex, ante…), or have the app export it.</span></li>
        {DEMO
          ? <li><b>paste it here</b><ImportBox placeholder='{"provider":"my-bot-app","bots":[…]}' step={2} /></li>
          : <li><b>save it</b><span data-ds-hint>as <code>{file}</code> (picked up within seconds; rewrite it when status changes), or <code>POST /api/bots</code>, or paste it here and deckstudio saves the file:</span>
              <ImportBox placeholder='{"provider":"my-bot-app","bots":[…]}' /></li>}
      </ol>
    </>
  )
}

function CommandSetup() {
  const p = state.profile!
  const all = p.botProviders || []
  const list = all.filter((c) => c.type === "command")
  const [f, setF] = React.useState({ name: "", cmd: "", interval: "15" })
  const id = providerId(f.name, "")
  const why = !f.name.trim() ? "name the provider first." : !id ? "use letters or digits in the name." : id === GROK.id || all.some((c) => c.id === id) ? `"${id}" is already a provider.` : !f.cmd.trim() ? "add the command that prints the json." : ""
  return (
    <>
      <p data-ds-note>a command (script or cli) that prints the bots json. deckstudio runs it every few seconds and shows the result. it runs as you, like a shell action.</p>
      {list.map((c) => (
        <div key={c.id} data-ds-row data-ds-cmdline>
          <code title={c.cmd}>{c.id}: {c.cmd}</code>
          <button type="button" data-ds-linkbtn onClick={() => { save(); p.botProviders = all.filter((x) => x !== c); if (!p.botProviders.length) delete p.botProviders; touch() }}>remove</button>
        </div>
      ))}
      <div data-ds-row>
        <input data-kit="input" placeholder="name (e.g. my bot app)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} style={{ flex: 1, minWidth: 110 }} />
        <input data-kit="input" placeholder="every s" value={f.interval} onChange={(e) => setF({ ...f, interval: e.target.value.replace(/\D/g, "") })} style={{ width: 56 }} aria-label="interval in seconds" />
      </div>
      <input data-kit="input" placeholder="command, e.g. mybots --json" value={f.cmd} onChange={(e) => setF({ ...f, cmd: e.target.value })} />
      <div data-ds-row>
        <button type="button" data-ds-chipbtn data-primary disabled={!!why} onClick={() => {
          save(); p.botProviders = [...all, { type: "command", id, name: f.name.trim(), cmd: f.cmd.trim(), interval: Math.max(5, Number(f.interval) || 15) }]; touch()
          setF({ name: "", cmd: "", interval: "15" }); toast(`added ${id}: bots appear after its first run`); setTimeout(changed, 4000)
        }}>add command</button>
        {why && <span data-ds-hint>{why}</span>}
      </div>
    </>
  )
}

function statusOf(p: Provider): { text: string; tone: "ok" | "off" | "err" } {
  if (p.error) return { text: p.error, tone: "err" }
  if (p.stale) return { text: `stale · ${p.count}`, tone: "off" }
  if (p.enabled === false && p.count) return { text: `off · ${p.count}`, tone: "off" }
  if (p.kind === "grokbot") return DEMO ? (p.count ? { text: `imported · ${p.count}`, tone: "ok" } : { text: "not imported", tone: "off" })
    : p.available ? { text: `detected · ${p.count}`, tone: "ok" } : { text: "not installed", tone: "off" }
  const kind = p.kind === "file" ? "json file" : p.kind === "command" ? "command" : p.kind === "sample" ? "sample" : "imported"
  return { text: `${kind} · ${p.count}`, tone: p.count ? "ok" : "off" }
}

/** The BYOB panel: which providers feed the deck, and how to add one. */
export function BotProviders() {
  const info = useBotsInfo()
  const [tab, setTab] = React.useState<"grok" | "json" | "command">("grok")
  const providers = info?.providers || []
  const grok = providers.find((p) => p.kind === "grokbot" || p.id === GROK.id)
  const rows: Provider[] = grok ? providers : [{ id: GROK.id, name: GROK.name, kind: "grokbot", count: 0 }, ...providers]
  const remove = async (p: Provider) => {
    if (p.kind === "command") { save(); state.profile!.botProviders = (state.profile!.botProviders || []).filter((c) => !(c.id === p.id && c.type === "command")); touch(); return setTimeout(changed, 600) }
    if (!DEMO && !window.confirm(`remove ${p.name}?\n\n${p.file} moves to ${info?.dir || "~/.deckstudio/bots"}/.removed (a file shared with other providers is rewritten without ${p.id}).`)) return
    const r = await api<{ moved?: string[]; rewritten?: string[] }>("POST", "/api/bots/remove", { provider: p.id }); changed(); touch()
    if (r.moved?.length || r.rewritten?.length) toast(`${[...(r.moved || []).map((f) => `moved ${f} to .removed`), ...(r.rewritten || []).map((f) => `rewrote ${f}`)].join(" · ")}`)
  }
  return (
    <div data-ds-byob>
      <p data-ds-note>
        {DEMO
          ? "bring your own bots: grok bot first, any other bot app too. what you import stays in this browser."
          : "bring your own bots: grok bot is built in; any other bot app joins with one small json file."}
      </p>
      <ul data-ds-providers>
        {rows.map((p, i) => {
          const s = statusOf(p)
          const trustable = !p.duplicate && p.kind !== "sample"
          return (
            <li key={`${p.kind}:${p.id}:${p.file || ""}:${i}`} data-ds-provider data-tone={s.tone}>
              <img src={p.logo ? `/logos/${p.logo}.png` : "/glyphs/bot.svg"} alt="" onError={(e) => { const i = e.currentTarget; if (i.src.endsWith(".png")) i.src = i.src.replace(/\.png$/, ".svg"); else if (!i.src.endsWith("/glyphs/bot.svg")) i.src = "/glyphs/bot.svg" }} />
              <b>{p.name}</b>
              <span data-ds-pill data-tone={s.tone} title={s.text}>{s.text}</span>
              {!DEMO && trustable && p.enabled != null && (p.count > 0 || p.kind === "grokbot" || p.kind === "command") && (
                <button type="button" data-ds-linkbtn aria-pressed={p.enabled} title={p.enabled ? "its bots show on bots pages; click to hide them" : "its bots stay off the deck until you switch it on"}
                  onClick={() => setTrust(p.id, { enabled: !p.enabled })}>{p.enabled ? "on deck" : "switch on"}</button>
              )}
              {trustable && (p.blockedSchemes || []).map((sc) => (p.schemes || []).includes(sc)
                ? <button key={sc} type="button" data-ds-linkbtn title={`let its bots open ${sc}: links`} onClick={() => setTrust(p.id, { schemes: [...new Set([...(p.allowed || []), sc])] })}>allow {sc}:</button>
                : <span key={sc} data-ds-hint title={`its bots open ${sc}: links but the app doesn't declare "${sc}" in schemes`}>{sc}: blocked</span>)}
              {trustable && !!p.shell && (
                <button type="button" data-ds-linkbtn title={p.allowShell ? "stop running its bots' shell commands" : `${p.shell} bot${p.shell === 1 ? "" : "s"} run a shell command as you on press: only trust an app you control`}
                  onClick={() => (p.allowShell || window.confirm(`let ${p.name}'s bots run shell commands as you when pressed?`)) && setTrust(p.id, { allowShell: !p.allowShell })}>{p.allowShell ? "shell allowed" : `allow shell (${p.shell})`}</button>
              )}
              {p.kind !== "grokbot" && p.kind !== "sample" && <button type="button" data-ds-linkbtn onClick={() => remove(p)} title={p.kind === "file" ? `move ${p.file} to .removed` : "remove"}>remove</button>}
            </li>
          )
        })}
      </ul>
      <Segmented label="add bots from" hideLabel value={tab} onValueChange={(v) => setTab(v as typeof tab)}
        options={[{ value: "grok", label: "grok bot" }, { value: "json", label: "any bot app" }, ...(DEMO ? [] : [{ value: "command", label: "command" }])]} />
      {tab === "grok" ? <GrokSetup p={grok} /> : tab === "json" ? <JsonSetup dir={info?.dir} /> : <CommandSetup />}
      {DEMO && (
        <div data-ds-row>
          <button type="button" data-ds-chipbtn onClick={async () => { await api("POST", "/api/bots/sample"); changed(); state.formKey++; touch() }}>use samples</button>
          {info?.source && info.source !== "none" && <button type="button" data-ds-chipbtn onClick={async () => { await api("POST", "/api/bots/clear"); changed(); state.formKey++; touch() }}>remove all</button>}
        </div>
      )}
    </div>
  )
}
/** Older name, kept for imports elsewhere. */
export const BotSource = BotProviders

/** Bind one key to one bot (key.bot = "provider:id"; older bare Grok ids/names still resolve). */
export function KeyBotPicker({ k }: { k: Record<string, any> }) {
  const bots = useBots()
  const [q, setQ] = React.useState("")
  if (!bots.length) return DEMO ? <BotProviders /> : null
  const cur = k.bot ? findBot(bots, k.bot) : null
  const many = new Set(bots.map((b) => b.provider)).size > 1
  const shown = bots.filter((b) => !q || `${b.fullName} ${b.provider}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div data-kit="field">
      <span data-kit="label">bot on this key {cur ? `· ${cur.name}` : k.bot ? "· not found" : ""}</span>
      <div data-ds-row>
        <input data-kit="input" placeholder="filter bots…" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: 1 }} />
        {k.bot && <button type="button" data-ds-linkbtn onClick={() => { save(); delete k.bot; select(state.sel) }}>unbind</button>}
      </div>
      <div data-ds-bots>
        {shown.slice(0, 40).map((b, i) => (
          <BotChip key={`${b.key}:${i}`} b={b} showProvider={many} on={cur?.key === b.key} onClick={() => { save(); k.bot = b.key; select(state.sel) }} />
        ))}
      </div>
    </div>
  )
}

/** A bots page: which providers it shows (page.providers, empty = all) and pinned slots (page.bots). */
export function PageBots({ pg }: { pg: Record<string, any> }) {
  const info = useBotsInfo()
  const all = info?.bots || []
  const legacy = pg.source === "grokbots"
  const want: string[] = legacy ? [GROK.id] : Array.isArray(pg.providers) ? pg.providers : []
  const bots = want.length ? all.filter((b) => want.includes(b.provider)) : all
  const list: string[] = Array.isArray(pg.bots) ? pg.bots : []
  const set = (next: string[]) => { save(); if (next.length) pg.bots = next; else delete pg.bots; touch() }
  const setProviders = (next: string[]) => { save(); if (next.length) pg.providers = next; else delete pg.providers; touch() }
  const byRef = (r: string) => findBot(all, r)
  const ids = [...new Set([...(info?.providers || []).filter((p) => p.count > 0 || p.kind === "grokbot").map((p) => p.id), ...want])]
  const nameOf = (id: string) => info?.providers.find((p) => p.id === id)?.name || id
  const many = new Set(bots.map((b) => b.provider)).size > 1
  return (
    <>
      {legacy ? (
        <div data-ds-row>
          <p data-ds-note style={{ flex: 1 }}>this page uses the older “grok bots” setup: grok bot only. it keeps working as is.</p>
          <button type="button" data-ds-chipbtn onClick={() => { save(); pg.source = "bots"; pg.providers = [GROK.id]; touch(); select(state.sel) }}>switch to bring your own</button>
        </div>
      ) : (
        <>
          <span data-kit="label">providers on this page</span>
          <div data-ds-bots>
            <button type="button" data-ds-bot data-on={!want.length || undefined} onClick={() => setProviders([])}><span>all</span></button>
            {ids.map((id) => (
              <button key={id} type="button" data-ds-bot data-on={want.includes(id) || undefined}
                onClick={() => setProviders(want.includes(id) ? want.filter((x) => x !== id) : [...want, id])}><span>{nameOf(id)}</span></button>
            ))}
          </div>
        </>
      )}
      <p data-ds-note>{list.length ? `slots 1–${Math.min(7, list.length)} in this order (more go to “more”). click a pinned bot to unpin, ◀ ▶ to move.` : "automatic: bots calling you first, then most recently active. pin bots to fix their slots."}</p>
      <div data-ds-bots>
        {list.map((r, i) => {
          const b = byRef(r)
          if (!b) return <button key={`${r}:${i}`} type="button" data-ds-bot onClick={() => set(list.filter((x) => x !== r))}>{r} ✕</button>
          return (
            <span key={`${r}:${i}`} data-ds-bot-slot>
              <b>{i + 1}</b>
              <BotChip b={b} on showProvider={many} onClick={() => set(list.filter((x) => x !== r))} />
              <span data-ds-row>
                <button type="button" data-ds-linkbtn disabled={i === 0} onClick={() => { const n = [...list]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; set(n) }}>◀</button>
                <button type="button" data-ds-linkbtn disabled={i === list.length - 1} onClick={() => { const n = [...list]; [n[i + 1], n[i]] = [n[i], n[i + 1]]; set(n) }}>▶</button>
              </span>
            </span>
          )
        })}
      </div>
      <span data-kit="label">add bots</span>
      <div data-ds-bots>
        {bots.filter((b) => !list.some((r) => byRef(r)?.key === b.key)).map((b, i) => (
          <BotChip key={`${b.key}:${i}`} b={b} showProvider={many} onClick={() => set([...list, b.key])} />
        ))}
        {!bots.length && <p data-ds-note>no bots yet: add a provider above.</p>}
      </div>
    </>
  )
}
