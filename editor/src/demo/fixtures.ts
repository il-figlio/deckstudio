// Everything the demo shows about "your Mac" is made up here. Nothing is read from the machine the
// site was built on: no ~/.deckstudio, no Rex sessions, no Grok Bot roster, no project paths.
import { defaultProfile } from "@deck/default-profile.mjs"
import type { Profile } from "../app/store"

/* eslint-disable @typescript-eslint/no-explicit-any */
export type FakeAgent = {
  blockId: string
  provider: "rex" | "claude-code" | "codex" | "agent-desk" // which agent-alerting provider reports it (src/agent-schema.mjs)
  app: "claude-code" | "codex" | "ante" | "cursor" | "gemini"
  session: string
  title: string
  msg: string
  attention: "needs" | "review" | "working" | "idle"
  state?: string
  kind?: "permission" | "question" | "auth"
  progress?: number
}
// Agents from several apps and providers: Rex terminal blocks, Claude Code hooks, Codex notify and a made-up
// "Agent Desk" app pushing agents/v1 JSON. All invented.
export const fakeAgents = (): FakeAgent[] => [
  { blockId: "a1", provider: "rex", app: "codex", session: "office-net", title: "guest wifi setup", msg: "which band should guests use?", attention: "needs", kind: "question" },
  { blockId: "a2", provider: "claude-code", app: "claude-code", session: "web-app", title: "refactor settings page", msg: "allow npm install?", attention: "needs", kind: "permission" },
  { blockId: "a3", provider: "rex", app: "claude-code", session: "api-server", title: "fix flaky ci test", msg: "running the suite", attention: "working", progress: 40 },
  { blockId: "a4", provider: "rex", app: "ante", session: "docs-site", title: "draft release notes", msg: "ready for review", attention: "review" },
  { blockId: "a5", provider: "codex", app: "codex", session: "data-pipeline", title: "", msg: "turn complete", attention: "review" },
  { blockId: "a6", provider: "agent-desk", app: "cursor", session: "mobile-app", title: "dark mode toggle", msg: "editing 3 files", attention: "working" },
  { blockId: "a7", provider: "rex", app: "ante", session: "design-kit", title: "icon audit for dark mode", msg: "", attention: "idle" },
  { blockId: "a8", provider: "agent-desk", app: "gemini", session: "infra", title: "terraform plan", msg: "", attention: "idle" },
]
/** The demo's agent providers (what GET /api/agents lists); "agent-desk" stands in for any app pushing JSON. */
export const FAKE_AGENT_PROVIDERS = [
  { id: "rex", name: "Rex", kind: "rex", logo: "app-rex", installed: true, available: true },
  { id: "claude-code", name: "Claude Code hooks", kind: "hook", logo: "app-claude" },
  { id: "codex", name: "Codex notify", kind: "hook", logo: "app-codex" },
  { id: "agent-desk", name: "Agent Desk", kind: "file", file: "agent-desk.json" },
] as const

// Sample bots ("use samples"): Grok Bot-style ones plus a made-up second bot app, so the
// bring-your-own-bots page shows how providers mix. Same documents a real app would hand over.
const grokSample = (n: number, name: string, role: string, shape: string, color: string, unread = 0, awaiting = false) => ({
  id: `00000000-demo-4000-8000-00000000000${n}`, name: `${name} · ${role}`, avatar: { shape, color }, unread, awaiting, activityAt: 1000 - n,
})
export const SAMPLE_DOCS = [
  {
    provider: "grokbot", name: "Grok Bot",
    bots: [
      grokSample(1, "Scout", "research", "blob", "blue", 0, true),
      grokSample(2, "Pixel", "design", "gem", "violet", 3),
      grokSample(3, "Ledger", "finance", "hex", "green", 1),
      grokSample(4, "Atlas", "travel", "wedge", "orange"),
      grokSample(5, "Juniper", "garden", "pebble", "cyan"),
      grokSample(6, "Mochi", "recipes", "cloud", "magenta", 2),
    ],
  },
  {
    deckstudio: "bots/v1", provider: "helper-hub", name: "Helper Hub",
    bots: [
      { id: "triage", name: "Triage", subtitle: "inbox", avatar: { glyph: "chat" }, unread: 4, activityAt: 995, open: { type: "url", url: "https://example.com/bots/triage" } },
      { id: "reviewer", name: "Reviewer", subtitle: "pull requests", avatar: { emoji: "🔍" }, awaiting: true, activityAt: 990, open: { type: "url", url: "https://example.com/bots/reviewer" } },
      { id: "planner", name: "Planner", avatar: { shape: "sparkle", color: "yellow" }, activityAt: 980 },
    ],
  },
]
export type FakeAudioDevice = { uid: string; name: string; input: boolean; output: boolean; defaultInput: boolean; defaultOutput: boolean; inputMuted?: boolean }
export const fakeAudio = (): { devices: FakeAudioDevice[]; camera: boolean; ok: boolean } => ({
  ok: true,
  camera: false,
  devices: [
    { uid: "demo-mic-1", name: "Laptop Microphone", input: true, output: false, defaultInput: true, defaultOutput: false, inputMuted: false },
    { uid: "demo-mic-2", name: "USB Podcast Mic", input: true, output: false, defaultInput: false, defaultOutput: false },
    { uid: "demo-out-1", name: "Laptop Speakers", input: false, output: true, defaultInput: false, defaultOutput: true },
    { uid: "demo-out-2", name: "Wireless Headphones", input: true, output: true, defaultInput: false, defaultOutput: false },
    { uid: "demo-out-3", name: "Desk Monitor", input: false, output: true, defaultInput: false, defaultOutput: false },
  ],
})

// Apps the demo pretends are running (lamps on launcher keys) and the fake front app.
// `logo` is the bundled assets/logos icon standing in for the app's real icon (Icon Studio's apps tab,
// "use app icon"): the demo only lists apps whose genuine icon ships with it.
export const fakeRunning: { bundleId: string; name: string; logo: string }[] = [
  { bundleId: "com.anthropic.claudefordesktop", name: "Claude", logo: "app-claude" },
  { bundleId: "com.superlogical.rex", name: "Rex", logo: "app-rex" },
  { bundleId: "com.openai.codex", name: "Codex", logo: "app-codex" },
  { bundleId: "com.openai.chat", name: "ChatGPT", logo: "app-chatgpt" },
]

// Public build (DECK_PUBLIC=1): a key whose logo didn't ship (local, gitignored art) falls back to a neutral glyph.
export const PUBLIC_BUILD = import.meta.env.VITE_PUBLIC === "1"
declare const __DECK_SHIPPED_LOGOS__: string[]
const SHIPPED = new Set<string>(typeof __DECK_SHIPPED_LOGOS__ === "undefined" ? [] : __DECK_SHIPPED_LOGOS__)
export function scrubPublic<T>(v: T): T {
  if (!PUBLIC_BUILD) return v
  const walk = (x: any): any => {
    if (Array.isArray(x)) return x.map(walk)
    if (!x || typeof x !== "object") return x
    if (typeof x.logo === "string" && !SHIPPED.has(x.logo)) { const { logo, ...rest } = x; void logo; return { ...walk(rest), glyph: "application" } }
    return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y)]))
  }
  return walk(v)
}

/** The starter profile, with every shell poll replaced by a simulated value. */
export function demoProfile(): Profile {
  const p = defaultProfile() as any
  const swap = (c: any) => {
    const cmd = String(c?.poll?.cmd || "")
    if (!cmd) return
    const kind = /date/.test(cmd) ? "clock" : /memory_pressure/.test(cmd) ? "mem" : /df /.test(cmd) ? "disk" : "cpu"
    c.poll = { demo: kind, interval: c.poll.interval }
  }
  for (const pg of Object.values<any>(p.pages)) {
    pg.keys?.forEach(swap)
    pg.dials?.forEach(swap)
  }
  p.agentProviders = [{ id: "agent-desk", enabled: true }] // a JSON provider the visitor "switched on" (new ones start off)
  return scrubPublic(p) as Profile
}
