// Agent alerting: which providers feed the agents page (Rex, Claude Code hooks, Codex notify, any app's
// agents/v1 JSON), a switch per provider, and copy-paste setup for each. Mirrors the BYOB panel (Bots.tsx).
// DeckStudio never edits ~/.claude or ~/.codex: the user (or their agent) pastes the snippets.
import * as React from "react"
import { Segmented } from "@/components/ui/segmented-control"
import { CODEX_ARGV_WARNING, EXAMPLE_AGENT_DOC, HOOK_PATH, claudeHooksSnippet, codexNotifySnippet, curlStatusSnippet } from "@deck/agent-schema.mjs"
import { DEMO, api, save, state, toast, touch } from "./store"

export type AgentProvider = {
  id: string; name: string; kind: "rex" | "hook" | "file"; logo?: string; app?: string; file?: string
  enabled?: boolean; installed?: boolean; available?: boolean; count: number; stale?: number; waiting?: boolean; duplicate?: boolean
  schemes?: string[]; allowed?: string[]; blockedSchemes?: string[]; error?: string | null
}
type AgentsInfo = { available: boolean; counts: Record<string, number>; providers: AgentProvider[]; dir?: string; hook?: string }

let info: AgentsInfo | null = null
const subs = new Set<(i: AgentsInfo) => void>()
let timer = 0
const load = () => api<AgentsInfo>("GET", "/api/agents").then((r) => { info = { ...r, providers: r.providers || [] }; subs.forEach((f) => f(info!)) }).catch(() => {})
const refreshSoon = () => setTimeout(load, 600)
function useAgentsInfo() {
  const [v, setV] = React.useState<AgentsInfo | null>(info)
  React.useEffect(() => {
    subs.add(setV)
    load()
    if (subs.size === 1) timer = window.setInterval(() => { if (!document.hidden) load() }, 5000)
    return () => { subs.delete(setV); if (!subs.size) clearInterval(timer) }
  }, [])
  return v
}
/** profile.agentProviders: the user's own say per provider (on the deck, url schemes). Never set from a document. */
function setTrust(id: string, patch: { enabled?: boolean; schemes?: string[] }) {
  const p = state.profile!
  save()
  const list = (p.agentProviders ||= [])
  const c = list.find((x) => x.id === id)
  if (c) Object.assign(c, patch)
  else list.push({ id, ...patch })
  touch(); refreshSoon()
}
const copy = (t: string, what: string) => navigator.clipboard.writeText(t).then(() => toast(`${what} copied`), () => toast("couldn't reach the clipboard", "error"))

function statusOf(p: AgentProvider): { text: string; tone: "ok" | "off" | "err" } {
  if (p.error) return { text: p.error, tone: "err" }
  if (p.kind === "rex") {
    if (!p.installed) return { text: "not installed", tone: "off" }
    if (p.enabled === false) return { text: `off · ${p.count}`, tone: "off" }
    return p.available ? { text: `detected · ${p.count}`, tone: "ok" } : { text: "not reachable", tone: "off" }
  }
  if (p.enabled === false) return { text: p.count ? `off · ${p.count}` : "off", tone: "off" }
  if (p.waiting) return { text: "not set up yet", tone: "off" }
  return { text: `${p.kind === "hook" ? "hooks" : "json"} · ${p.count}${p.stale ? ` (+${p.stale} stale)` : ""}`, tone: p.count ? "ok" : "off" }
}

function Snippet({ text, what, note }: { text: string; what: string; note?: React.ReactNode }) {
  return (
    <>
      <div data-ds-row>
        <button type="button" data-ds-chipbtn data-primary onClick={() => copy(text, what)}>copy {what}</button>
      </div>
      <pre data-ds-cmds>{text}</pre>
      {note && <span data-ds-hint>{note}</span>}
    </>
  )
}

const claudePrompt = (hook: string) => `Add DeckStudio agent alerting to my Claude Code hooks. Merge this "hooks" block into ~/.claude/settings.json, keeping every hook I already have (append to existing event arrays, don't replace them). Show me the diff before saving.\n\n${claudeHooksSnippet(hook)}`
const codexPrompt = (hook: string) => `Add DeckStudio agent alerting to Codex: in ~/.codex/config.toml set this top-level key (above any [table]). If notify is already set, tell me instead of overwriting it. Show me the diff before saving. Note for me: ${CODEX_ARGV_WARNING}\n\n${codexNotifySnippet(hook)}`

function ClaudeSetup({ hook }: { hook: string }) {
  return (
    <>
      <p data-ds-note>claude code runs <code>deck-agent-hook</code> on its hook events: working on a prompt, waiting for a permission, finished, session closed. it sends the session id, the folder name and the app you run it in — never prompts or transcripts. merge this into <code>~/.claude/settings.json</code> (or a project's <code>.claude/settings.json</code>); deckstudio never edits it for you.</p>
      <Snippet text={claudeHooksSnippet(hook)} what="hooks json" note={<>already have hooks? <button type="button" data-ds-linkbtn onClick={() => copy(claudePrompt(hook), "prompt")}>copy a prompt for claude to merge it</button>. post-tool-use keeps "allow?" from lingering after you approve; drop it if you'd rather not run a hook per tool.</>} />
    </>
  )
}
function CodexSetup({ hook }: { hook: string }) {
  return (
    <>
      <p data-ds-note>codex calls its <code>notify</code> program when a turn completes (that's the only event codex sends today), so codex sessions show as <b>done</b> when they finish. add one top-level line to <code>~/.codex/config.toml</code>:</p>
      <p data-ds-note data-ds-codex-warning><b>{CODEX_ARGV_WARNING}</b></p>
      <Snippet text={codexNotifySnippet(hook)} what="notify line" note={<>codex allows one notify program. <button type="button" data-ds-linkbtn onClick={() => copy(codexPrompt(hook), "prompt")}>copy a prompt for your agent</button></>} />
    </>
  )
}
function RexSetup({ p }: { p?: AgentProvider }) {
  if (DEMO) return <p data-ds-note>with rex installed, deckstudio reads every agent running in a rex terminal block, live: press jumps rex to it. these rex sessions are made up.</p>
  return p?.installed
    ? <p data-ds-note>detected. deckstudio reads rex's sessions live (claude code, codex, ante… in rex terminal blocks): nothing to set up. press jumps rex to the session.</p>
    : <p data-ds-note>rex isn't installed on this mac (its cli wasn't found: set <code>DECKSTUDIO_REX_CLI</code> if it lives somewhere unusual). agents in any other terminal still show up through the claude code / codex hooks.</p>
}
function AppSetup({ dir }: { dir?: string }) {
  const example = JSON.stringify(EXAMPLE_AGENT_DOC, null, 2)
  return (
    <>
      <p data-ds-note>any agent app or script: write an <code>agents/v1</code> json file to <code>{dir ? dir.replace(/^\/Users\/[^/]+/, "~") : "~/.deckstudio/agents"}/&lt;provider&gt;.json</code>, <code>POST /api/agents</code> it, or push one session at a time:</p>
      <Snippet text={DEMO ? example : curlStatusSnippet()} what={DEMO ? "example json" : "curl"} note={<>states: idle · working · done · needs (permission / question / auth) · error · gone. a new provider stays off the deck until you switch it on; links beyond https need the app to declare the scheme and you to allow it.</>} />
      {!DEMO && <details data-ds-more><summary>see the format</summary><pre data-ds-cmds>{example}</pre></details>}
    </>
  )
}

/** The agents panel: which providers feed the agents page, and how to hook one up. */
export function AgentProviders() {
  const v = useAgentsInfo()
  const [tab, setTab] = React.useState<"claude" | "codex" | "rex" | "app">("claude")
  const providers = v?.providers || []
  const hook = DEMO ? HOOK_PATH : v?.hook || HOOK_PATH
  const remove = async (p: AgentProvider) => {
    if (!DEMO && !window.confirm(`remove ${p.name}?\n\n${p.file} moves to ${v?.dir || "~/.deckstudio/agents"}/.removed.`)) return
    await api("POST", "/api/agents/remove", { provider: p.id }); load()
  }
  return (
    <div data-ds-byob>
      <p data-ds-note>{DEMO ? "agents from every app, most urgent first. these sessions are made up." : "agents from every app, most urgent first: rex is read live, claude code and codex report through a tiny hook, any other app through json."}</p>
      <ul data-ds-providers>
        {providers.map((p, i) => {
          const s = statusOf(p)
          const trustable = !p.duplicate && !(p.kind === "rex" && !p.installed)
          return (
            <li key={`${p.id}:${p.file || ""}:${i}`} data-ds-provider data-tone={s.tone}>
              <img src={p.logo ? `/logos/${p.logo}.png` : "/glyphs/bot.svg"} alt="" onError={(e) => { const im = e.currentTarget; if (im.src.endsWith(".png")) im.src = im.src.replace(/\.png$/, ".svg"); else if (!im.src.endsWith("/glyphs/bot.svg")) im.src = "/glyphs/bot.svg" }} />
              <b>{p.name}</b>
              <span data-ds-pill data-tone={s.tone} title={s.text}>{s.text}</span>
              {trustable && p.enabled != null && (
                <button type="button" data-ds-linkbtn aria-pressed={p.enabled} title={p.enabled ? "its sessions show on the agents page and count in {agents_needs}; click to hide them" : "its sessions stay off the deck until you switch it on"}
                  onClick={() => setTrust(p.id, { enabled: !p.enabled })}>{p.enabled ? "on deck" : "switch on"}</button>
              )}
              {trustable && (p.blockedSchemes || []).map((sc) => (p.schemes || []).includes(sc)
                ? <button key={sc} type="button" data-ds-linkbtn title={`let its sessions open ${sc}: links`} onClick={() => setTrust(p.id, { schemes: [...new Set([...(p.allowed || []), sc])] })}>allow {sc}:</button>
                : <span key={sc} data-ds-hint title={`its sessions open ${sc}: links but the app doesn't declare "${sc}" in schemes`}>{sc}: blocked</span>)}
              {!DEMO && p.kind !== "rex" && p.file && <button type="button" data-ds-linkbtn onClick={() => remove(p)} title={`move ${p.file} to .removed`}>remove</button>}
            </li>
          )
        })}
      </ul>
      <Segmented label="set up agents from" hideLabel value={tab} onValueChange={(x) => setTab(x as typeof tab)}
        options={[{ value: "claude", label: "claude code" }, { value: "codex", label: "codex" }, { value: "rex", label: "rex" }, { value: "app", label: "any app" }]} />
      {tab === "claude" ? <ClaudeSetup hook={hook} /> : tab === "codex" ? <CodexSetup hook={hook} /> : tab === "rex" ? <RexSetup p={providers.find((p) => p.kind === "rex")} /> : <AppSetup dir={v?.dir} />}
    </div>
  )
}
