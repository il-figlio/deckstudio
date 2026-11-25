// Agent alerting: the one session model every agent provider maps into (Rex's terminal blocks,
// JSON files / pushes from any app, and the ready-made hooks for Claude Code and Codex).
// Pure functions only, so the browser demo, the hook script (bin/deck-agent-hook) and the server
// all share the exact same parsing, trust rules and attention logic.
//
// A provider document ("agents/v1"; what an app writes to ~/.deckstudio/agents/<provider>.json or
// POSTs to /api/agents):
//   { "deckstudio": "agents/v1", "provider": "my-app", "name": "My App", "app": "com.example.myapp", "schemes": ["myapp"],
//     "sessions": [ { "id", "name", "title"?, "app"?, "state", "needs"?, "message"?, "progress"?, "updatedAt"?, "open"? } ] }
// state: idle | working | done | needs (needs: permission | question | auth) | error
// open:  { type: "url", url } | { type: "app", target: <bundle id> }   (no shell: a document never runs commands)
//
// Trust (same rules as bring-your-own-bots, kept in profile.agentProviders[{ id, enabled?, schemes? }], never in a doc):
//   - rex, claude-code and codex (fed by DeckStudio's own hook script) are on by default; any other provider stays
//     off the deck until the user switches it on;
//   - url: https always; another scheme only if the doc declares it in `schemes` AND the user allowed it;
//     javascript: data: file: … never; app: bundle ids only (open -b).
import { BUNDLE_RE, PROVIDER_RE, activityMs, clampN } from './bot-schema.mjs'

export const AGENT_SCHEMA = 'agents/v1'
export const STATES = ['idle', 'working', 'done', 'needs', 'error']
export const NEEDS_KINDS = ['permission', 'question', 'auth']
/** Agent apps with a logo / glyph on the deck; anything else is shown as "custom" with a generic bot glyph. */
export const AGENT_APPS = ['claude-code', 'codex', 'ante', 'cursor', 'gemini', 'opencode', 'aider', 'amp', 'copilot', 'grok', 'custom']
export const APP_NAMES = { 'claude-code': 'Claude Code', codex: 'Codex', ante: 'Ante', cursor: 'Cursor', gemini: 'Gemini CLI', opencode: 'opencode', aider: 'Aider', amp: 'Amp', copilot: 'Copilot', grok: 'Grok', custom: 'agent' }
/** Providers DeckStudio ships (rex is read live; the other two are fed by bin/deck-agent-hook). On by default. */
export const BUILTIN_PROVIDERS = {
  rex: { id: 'rex', name: 'Rex', app: 'com.superlogical.rex', logo: 'app-rex', kind: 'rex' },
  'claude-code': { id: 'claude-code', name: 'Claude Code hooks', logo: 'app-claude', kind: 'hook' },
  codex: { id: 'codex', name: 'Codex notify', logo: 'app-codex', kind: 'hook' },
}
export const MAX_SESSIONS = 200
export const MAX_AGENT_DOC = 1 << 20
export const STALE_MS = 24 * 3600e3 // a session not updated for a day is dropped from the deck

const NEVER = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'view-source', 'jar', 'about', 'filesystem'])
const SCHEME_RE = /^[a-z][a-z0-9+.-]{1,30}$/
const ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/
const str = (v, n) => (v == null || typeof v === 'object' ? '' : String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n))
const schemeOf = u => u.slice(0, u.indexOf(':')).toLowerCase()
const safeUrl = u => /^[a-z][a-z0-9+.-]{1,30}:/i.test(u) && !NEVER.has(schemeOf(u)) && u.length <= 2000

/** "blocked", "waiting", "finished", … → one of STATES (unknown → idle). */
export function normState(v) {
  const s = String(v ?? '').toLowerCase().trim()
  if (STATES.includes(s)) return s
  if (/^(blocked|waiting|attention|input|ask|approval)/.test(s)) return 'needs'
  if (/^(done|finished|complete|completed|stopped|review)/.test(s)) return 'done'
  if (/^(working|running|busy|thinking|active|started)/.test(s)) return 'working'
  if (/^(error|failed|failure|crashed)/.test(s)) return 'error'
  return 'idle'
}
export function normApp(v) {
  const s = String(v ?? '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-')
  if (s === 'claude' || s === 'claudecode') return 'claude-code'
  if (s === 'gemini-cli') return 'gemini'
  return AGENT_APPS.includes(s) ? s : 'custom'
}
function normOpen(o) {
  if (!o) return null
  if (typeof o === 'string') return safeUrl(o) ? { type: 'url', url: o } : null
  if (typeof o !== 'object') return null
  const type = String(o.type || (o.url ? 'url' : o.target ? 'app' : ''))
  if (type === 'url') { const url = str(o.url, 2000); return safeUrl(url) ? { type, url } : null }
  if (type === 'app') { const target = str(o.target, 200); return BUNDLE_RE.test(target) ? { type, target } : null }
  return null // shell and anything else: never from a document
}

/** One session from any provider, cleaned (null when id is missing). */
export function normalizeSession(r, provider) {
  if (!r || typeof r !== 'object') return null
  const id = typeof r.id === 'string' || Number.isFinite(r.id) ? str(r.id, 128) : ''
  if (!id || !ID_RE.test(id)) return null
  const state = normState(r.state ?? r.status)
  const kind = String(r.needs ?? r.kind ?? '').toLowerCase()
  const app = normApp(r.app ?? provider)
  const s = {
    key: `${provider}:${id}`, provider, id,
    name: str(r.name ?? r.session, 60) || APP_NAMES[app] || provider,
    title: str(r.title, 120), app, state,
    needs: state === 'needs' ? (NEEDS_KINDS.includes(kind) ? kind : 'question') : undefined,
    message: str(r.message ?? r.msg, 200),
    progress: r.progress == null || r.progress === '' ? null : clampN(r.progress, 0, 100),
    updatedAt: activityMs(r.updatedAt ?? r.updated_at) || 0,
    open: normOpen(r.open),
  }
  return s
}

/** The raw docs in any accepted shape: a doc, { providers: [docs] }, an array of docs, or a bare array of sessions. */
export function splitAgentDocs(d, fallback = 'agents') {
  let docs
  if (Array.isArray(d)) docs = d.length && d.every(x => x && Array.isArray(x.sessions)) ? d : [{ provider: fallback, sessions: d }]
  else if (d && Array.isArray(d.providers)) docs = d.providers
  else if (d && Array.isArray(d.sessions)) docs = [d]
  else throw new Error('expected {"provider": …, "sessions": [ … ]}')
  const pid = v => { const id = String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32); return PROVIDER_RE.test(id) ? id : fallback }
  return docs.slice(0, 20).filter(x => x && typeof x === 'object').map(doc => ({ provider: pid(doc.provider ?? doc.id ?? doc.name), doc, rows: Array.isArray(doc.sessions) ? doc.sessions : [] }))
}
export function parseAgentDocs(input, fallback = 'agents') {
  const d = typeof input === 'string' ? JSON.parse(input) : input
  return splitAgentDocs(d, fallback).map(({ provider, doc, rows }) => {
    const sessions = [], seen = new Set()
    for (const r of rows.slice(0, MAX_SESSIONS)) {
      const s = normalizeSession(r, provider)
      if (s && !seen.has(s.id)) { seen.add(s.id); sessions.push(s) }
    }
    const app = str(doc.app, 200)
    const schemes = [...new Set((Array.isArray(doc.schemes) ? doc.schemes : []).map(x => String(x).toLowerCase().replace(/:$/, '')))].filter(x => SCHEME_RE.test(x) && !NEVER.has(x) && x !== 'https').slice(0, 8)
    const builtin = BUILTIN_PROVIDERS[provider]
    return {
      provider, name: str(doc.name, 40) || builtin?.name || provider,
      app: BUNDLE_RE.test(app) ? app : undefined,
      logo: /^[a-z0-9-]{1,80}$/.test(String(doc.logo || '')) ? doc.logo : builtin?.logo,
      ...(schemes.length ? { schemes } : {}),
      sessions,
    }
  })
}

/** POST /api/agents/status → the fields to upsert ({ remove: true } for state "gone" / "removed"). */
export function cleanAgentStatus(b) {
  if (!b || typeof b !== 'object') throw new Error('expected { provider, id, state }')
  const provider = String(b.provider ?? '')
  if (!PROVIDER_RE.test(provider)) throw new Error('bad provider id (a-z 0-9 -, up to 32)')
  if (provider === 'rex') throw new Error('rex is read live from Rex — push under your own provider id')
  const id = str(b.id, 128)
  if (!ID_RE.test(id)) throw new Error('bad session id (A-Z a-z 0-9 . _ : @ -, up to 128)')
  if (/^(gone|removed|ended|closed)$/i.test(String(b.state ?? '')) || b.remove === true) return { provider, id, remove: true }
  const o = { provider, id }
  for (const k of ['name', 'title', 'app', 'message', 'needs', 'progress', 'open']) if (k in b) o[k] = b[k]
  if ('state' in b) o.state = normState(b.state)
  return o
}

/** What the user allowed a provider (profile.agentProviders[{ id, enabled, schemes }]), given the doc's declared schemes. */
export function agentTrust(list, id, declared = []) {
  const c = (Array.isArray(list) ? list : []).find(x => x && x.id === id) || {}
  const ok = Array.isArray(c.schemes) ? c.schemes.map(x => String(x).toLowerCase()) : []
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : !!BUILTIN_PROVIDERS[id],
    schemes: (declared || []).filter(x => ok.includes(x) && !NEVER.has(x)),
  }
}
/** What a press on a session does (besides marking it seen): { kind: url|app|none, url?, target?, blocked? }. */
export function agentPress(s, trust = {}, providerApp) {
  const o = s.open
  if (o?.type === 'url') {
    const sc = schemeOf(o.url)
    return sc === 'https' || (trust.schemes || []).includes(sc) ? { kind: 'url', url: o.url } : { kind: 'url', url: o.url, blocked: `${sc}: links are off until you allow them for this provider` }
  }
  if (o?.type === 'app') return { kind: 'app', target: o.target }
  return providerApp ? { kind: 'app', target: providerApp } : { kind: 'none' }
}

/**
 * needs you > ready for review > working > idle. `seen` = when the user last looked (ms), `baseline` = when
 * DeckStudio started: anything that changed before counts as seen (same rule Rex sessions always had).
 */
export function attentionOf(s, { seen = 0, baseline = 0 } = {}) {
  const changed = s.updatedAt || 0
  const base = Math.max(seen, baseline)
  if (s.state === 'needs' && !(seen && seen >= changed)) return 'needs'
  if (s.state === 'error' && changed > base) return 'needs'
  if (s.alertAt && s.alertAt > base) return 'needs'
  if (s.state === 'done' && changed > base) return 'review'
  if (s.state === 'working' || s.state === 'needs') return 'working'
  return 'idle'
}
export const RANK = { needs: 0, review: 1, working: 2, idle: 3 }
export function sortAgents(list, order = () => 0) {
  return [...list].sort((a, b) => RANK[a.attention] - RANK[b.attention] || order(a) - order(b) || a.key.localeCompare(b.key))
}
export function countAgents(list) {
  const c = { needs: 0, review: 0, working: 0, idle: 0 }
  for (const a of list) c[a.attention]++
  return c
}

// ---------- ready-made hooks: map an agent CLI's hook payload to a status push ----------
const base = p => String(p || '').split('/').filter(Boolean).pop() || ''
/** The terminal / editor the agent runs in, from the env macOS gives apps' children (__CFBundleIdentifier) or TERM_PROGRAM. */
export function hostApp(env = {}) {
  const b = String(env.__CFBundleIdentifier || '')
  if (BUNDLE_RE.test(b)) return b
  const t = String(env.TERM_PROGRAM || '')
  return { Apple_Terminal: 'com.apple.Terminal', 'iTerm.app': 'com.googlecode.iterm2', WezTerm: 'com.github.wez.wezterm', ghostty: 'com.mitchellh.ghostty', vscode: 'com.microsoft.VSCode', WarpTerminal: 'dev.warp.Warp-Stable' }[t] || ''
}
const NOTIFY = {
  permission_prompt: ['needs', 'permission'], elicitation_dialog: ['needs', 'question'], elicitation_url_dialog: ['needs', 'question'], agent_needs_input: ['needs', 'question'],
  auth_storage_failure: ['needs', 'auth'], idle_prompt: ['done'], agent_completed: ['done'],
}
/**
 * A Claude Code hook payload (stdin JSON) or a Codex `notify` payload (last argv) → a POST /api/agents/status body,
 * or null when the event says nothing about attention. Only ids, the folder name, the event's own short
 * message and the host app are sent — never prompts, transcripts or tool input.
 */
export function hookStatus(source, p, env = {}) {
  if (!p || typeof p !== 'object') return null
  const open = hostApp(env) ? { type: 'app', target: hostApp(env) } : undefined
  if (source === 'codex') {
    const id = str(p['thread-id'] ?? p.thread_id ?? p['session-id'] ?? p.session_id, 128)
    if (!id) return null
    const st = { provider: 'codex', id, app: 'codex', name: base(p.cwd) || 'codex', ...(open ? { open } : {}) }
    const t = String(p.type || '')
    if (t === 'agent-turn-complete') return { ...st, state: 'done', message: 'turn complete' }
    if (/approval/.test(t)) return { ...st, state: 'needs', needs: 'permission', message: 'approval requested' }
    if (/input|question/.test(t)) return { ...st, state: 'needs', needs: 'question', message: 'needs input' }
    return null
  }
  // claude-code (and agents with the same hook payloads)
  const id = str(p.session_id, 128)
  if (!id) return null
  const ev = String(p.hook_event_name || '')
  const st = { provider: 'claude-code', id, app: 'claude-code', name: base(p.cwd || env.CLAUDE_PROJECT_DIR) || 'claude', ...(p.session_title ? { title: str(p.session_title, 120) } : {}), ...(open ? { open } : {}) }
  switch (ev) {
    case 'SessionStart': return { ...st, state: 'idle', message: '' }
    case 'UserPromptSubmit': return { ...st, state: 'working', message: 'working' }
    case 'PreToolUse': case 'PostToolUse': case 'PostToolUseFailure':
      return { ...st, state: 'working', message: str(p.tool_name, 40) }
    case 'PermissionRequest': return { ...st, state: 'needs', needs: 'permission', message: `allow ${str(p.tool_name, 40) || 'tool'}?` }
    case 'Notification': {
      const m = NOTIFY[String(p.notification_type || '')]
      if (!m) return /permission/i.test(String(p.message || '')) ? { ...st, state: 'needs', needs: 'permission', message: str(p.message, 120) } : null
      return { ...st, state: m[0], ...(m[1] ? { needs: m[1] } : {}), message: str(p.message, 120) }
    }
    case 'Stop': return { ...st, state: 'done', message: 'finished' }
    case 'StopFailure': return { ...st, state: 'error', message: 'stopped with an error' }
    case 'SessionEnd': return { provider: 'claude-code', id, state: 'gone' }
    default: return null
  }
}

/** The schema example shown in the editor and docs. */
export const EXAMPLE_AGENT_DOC = {
  deckstudio: AGENT_SCHEMA,
  provider: 'my-agent-app',
  name: 'My Agent App',
  app: 'com.example.myagentapp',
  schemes: ['myagentapp'],
  sessions: [
    { id: 'build-42', name: 'web-app', title: 'refactor settings page', app: 'custom', state: 'needs', needs: 'permission', message: 'allow npm install?', open: { type: 'url', url: 'myagentapp://session/build-42' } },
    { id: 'docs-7', name: 'docs-site', title: 'draft release notes', app: 'custom', state: 'done', message: 'ready for review', open: { type: 'app', target: 'com.example.myagentapp' } },
    { id: 'ci-3', name: 'api-server', title: 'fix flaky test', state: 'working', progress: 40 },
  ],
}

// ---------- copy-paste setup for the ready-made hooks (editor, demo, recipes and docs all show these) ----------
export const HOOK_PATH = '~/deckstudio/bin/deck-agent-hook'
/** The Claude Code hook events the script understands, merged into the user's own settings by hand (never by DeckStudio). */
export const CLAUDE_HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PermissionRequest', 'PostToolUse', 'Notification', 'Stop', 'StopFailure', 'SessionEnd']
/** The "hooks" block for ~/.claude/settings.json (or a project's .claude/settings.json). */
export function claudeHooksSnippet(hook = HOOK_PATH) {
  const cmd = { type: 'command', command: `${/\s/.test(hook) ? JSON.stringify(hook) : hook} claude-code`, timeout: 5 }
  return JSON.stringify({ hooks: Object.fromEntries(CLAUDE_HOOK_EVENTS.map(ev => [ev, [{ ...(ev === 'PostToolUse' ? { matcher: '*' } : {}), hooks: [cmd] }]])) }, null, 2)
}
/** Codex hands notify its JSON payload (with your latest prompt and the agent's reply) as a command-line argument, and
 *  every user on the Mac can read other processes' arguments (`ps -axww`) while the hook runs. DeckStudio can't change
 *  how Codex calls it, so say so wherever the setup is shown. */
export const CODEX_ARGV_WARNING = 'Shared Mac? Codex passes notify its payload, including your last prompt and the agent\'s reply, as a command-line argument, which other users on this Mac can see (ps) while the hook runs. Only set this up on a Mac where you are the only user.'
/** The line for ~/.codex/config.toml (top level, above any [table]). */
export function codexNotifySnippet(hook = HOOK_PATH) {
  return `notify = [${JSON.stringify(hook.replace(/^~(?=\/)/, '/Users/<you>'))}, "codex"]`
}
export function curlStatusSnippet(base = 'http://127.0.0.1:7337') {
  return `curl -s -X POST ${base}/api/agents/status -H "x-deck-token: $(cat ~/.deckstudio/token)" -H "content-type: application/json" \\\n  -d '{"provider":"my-agent-app","id":"build-42","name":"web-app","state":"needs","needs":"permission","message":"allow npm install?"}'`
}
