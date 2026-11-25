// Agent alerting: every agent provider in one attention-sorted list.
//   rex          — Rex terminal blocks, read live (src/rex.mjs); press jumps Rex to the block
//   file / push  — any app: agents/v1 JSON in ~/.deckstudio/agents/<provider>.json (written directly,
//                  via POST /api/agents, or one session at a time via POST /api/agents/status)
//   hooks        — bin/deck-agent-hook: Claude Code hooks and Codex `notify` push into the
//                  "claude-code" / "codex" providers through /api/agents/status
// Schema, trust and attention rules: src/agent-schema.mjs.
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { RexAgents, REX_BUNDLE } from './rex.mjs'
import { PROVIDER_RE, activityMs } from './bot-schema.mjs'
import { AGENT_SCHEMA, BUILTIN_PROVIDERS, MAX_AGENT_DOC, MAX_SESSIONS, STALE_MS, agentPress, agentTrust, attentionOf, cleanAgentStatus, countAgents, parseAgentDocs, sortAgents, splitAgentDocs } from './agent-schema.mjs'

const HOME_DIR = process.env.DECKSTUDIO_HOME || path.join(process.env.HOME, '.deckstudio')
export const AGENTS_DIR = path.join(HOME_DIR, 'agents')
const REMOVED_DIR = path.join(AGENTS_DIR, '.removed')
const SEEN_FILE = path.join(HOME_DIR, 'agents-seen.json')
export const HOOK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../bin/deck-agent-hook') // shown in the editor's setup snippets
const err = (msg, code = 400) => Object.assign(new Error(msg), { code })
const fallbackOf = f => f.replace(/\.json$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 32) || 'agents'
const writeAtomic = (file, json) => { const tmp = `${file}.${process.pid}.tmp`; fs.writeFileSync(tmp, json, { mode: 0o600 }); fs.renameSync(tmp, file) }
const NEEDS = new Set(['needs', 'error'])

/** A Rex agent (src/rex.mjs list row) in the shared session shape; Rex's own fields stay for older readers. */
function fromRex(a) {
  return {
    ...a, records: undefined, key: `rex:${a.blockId}`, provider: 'rex', id: a.blockId,
    name: a.session, state: a.state === 'blocked' ? 'needs' : a.state, needs: a.state === 'blocked' ? a.kind || 'question' : undefined,
    message: a.msg || a.alert || '', updatedAt: Date.parse(a.updatedAt || '') || 0,
  }
}

export class AgentHub extends EventEmitter {
  constructor({ cfg = () => [], rex = new RexAgents() } = {}) {
    super()
    this.cfg = cfg                // profile.agentProviders: what the user enabled / allowed per provider
    this.rex = rex
    this.files = new Map()        // file name → { mtime, docs, error }
    this.startedAt = Date.now()
    this.seen = new Map(Object.entries(this.loadSeen())) // "provider:id" → ms the user last looked (rex keeps its own)
    this.firstSeen = new Map()
    this.prev = new Map()         // "provider:id" → state, to raise an alert on a change into needs / error
  }
  loadSeen() { try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) } catch { return {} } }
  saveSeen() {
    clearTimeout(this.seenTimer)
    this.seenTimer = setTimeout(() => {
      const live = new Set(this.sessions().map(s => s.key))
      try { fs.writeFileSync(SEEN_FILE, JSON.stringify(Object.fromEntries([...this.seen].filter(([k]) => live.has(k)))), { mode: 0o600 }) } catch {}
    }, 500)
  }

  start() {
    try { fs.mkdirSync(AGENTS_DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(AGENTS_DIR, 0o700) } catch {}
    this.rex.on('change', () => this.changed())
    this.rex.on('alert', a => { if (this.enabled('rex')) this.emit('alert', { ...fromRex(a), attention: 'needs' }) })
    if (this.enabled('rex')) this.rex.start()
    this.scan(true)
    this.timer = setInterval(() => { this.rexFollow(); if (this.scan()) this.changed() }, 2000)
  }
  stop() { clearInterval(this.timer); clearTimeout(this.seenTimer); clearTimeout(this.chg); this.rex.stop() }
  /** switching Rex on in the editor starts it; nothing runs for a provider that's off */
  rexFollow() { if (this.enabled('rex') && !this.rex.started && !this.rex.located && !this.rex.stopped) this.rex.start() }
  changed() { clearTimeout(this.chg); this.chg = setTimeout(() => this.emit('change'), 40) }
  enabled(id) { return this.trust(id).enabled }
  trust(id, own) { return agentTrust(this.cfg(), id, (own || this.owners()).get(id)?.doc?.schemes) }

  // ---------- json files (~/.deckstudio/agents) ----------
  scan(quiet = false) {
    let names = []
    try { names = fs.readdirSync(AGENTS_DIR).filter(f => /^[A-Za-z0-9._-]{1,80}\.json$/.test(f) && !f.startsWith('.')) } catch {}
    let changed = false
    for (const f of [...this.files.keys()]) if (!names.includes(f)) { this.files.delete(f); changed = true }
    for (const f of names) {
      const file = path.join(AGENTS_DIR, f)
      try {
        const st = fs.statSync(file)
        if (!st.isFile()) continue
        const prev = this.files.get(f)
        if (prev && prev.mtime === st.mtimeMs) continue
        if (st.size > MAX_AGENT_DOC) { this.files.set(f, { mtime: st.mtimeMs, docs: [], error: 'file over 1 MB' }); changed = true; continue }
        let docs = [], error = null
        try { docs = parseAgentDocs(fs.readFileSync(file, 'utf8'), fallbackOf(f)) }
        catch (e) { error = e.message.slice(0, 160); if (prev?.docs.length) { docs = prev.docs; error += ' (showing the last good version)' } }
        docs = docs.filter(d => d.provider !== 'rex') // Rex is read live; a file can't impersonate it
        // a session with no updatedAt of its own changed when its file did
        for (const d of docs) for (const s of d.sessions) if (!s.updatedAt) s.updatedAt = st.mtimeMs
        this.files.set(f, { mtime: st.mtimeMs, docs, error }); changed = true
      } catch {}
    }
    if (changed) this.alerts(quiet)
    return changed
  }
  /** provider id → its one owner (first file by name); later claims are duplicates */
  owners() {
    const own = new Map(), dups = []
    for (const f of [...this.files.keys()].sort()) {
      for (const d of this.files.get(f).docs) {
        if (own.has(d.provider)) dups.push({ file: f, doc: d, owner: own.get(d.provider) })
        else own.set(d.provider, { file: f, doc: d })
      }
    }
    own.dups = dups
    return own
  }
  /** every non-Rex session of an enabled provider, minus stale ones */
  sessions(own = this.owners()) {
    const now = Date.now(), out = []
    for (const [id, o] of own) {
      if (!this.trust(id, own).enabled) continue
      for (const s of o.doc.sessions) if (now - s.updatedAt < STALE_MS) out.push(s)
    }
    return out
  }
  alerts(quiet) {
    const next = new Map()
    for (const s of this.sessions()) {
      next.set(s.key, s.state)
      if (!quiet && NEEDS.has(s.state) && this.prev.get(s.key) !== s.state && s.updatedAt > this.startedAt) this.emit('alert', { ...s, session: s.name, attention: 'needs' })
    }
    this.prev = next
  }

  /** POST /api/agents: a document → ~/.deckstudio/agents/<provider>.json. merge: true upserts the listed sessions, keeps the rest. */
  push(body) {
    const merge = body?.merge === true
    const text = body?.text != null ? String(body.text) : null
    if (Buffer.byteLength(text ?? JSON.stringify(body ?? {})) > MAX_AGENT_DOC) throw err('agents document over 1 MB', 413)
    let input
    if (text != null) try { input = JSON.parse(text) } catch (e) { throw err(`not json: ${e.message}`) }
    else { const { merge: _m, ...rest } = body || {}; input = rest }
    const writes = []
    for (const { provider, doc, rows } of splitAgentDocs(input, 'agents')) {
      if (provider === 'rex') throw err('rex is read live from Rex — push under your own provider id')
      const file = path.join(AGENTS_DIR, `${provider}.json`)
      const { sessions: _s, ...meta } = doc
      let head = meta, list = rows.map(r => (r && typeof r === 'object' && r.updatedAt == null ? { ...r, updatedAt: Date.now() } : r))
      if (merge) {
        const old = this.readRaw(file, provider)
        if (old) {
          head = { ...old.meta, ...meta }
          const byId = new Map(old.rows.map(r => [String(r.id), r]))
          for (const r of list) if (r && typeof r === 'object') byId.set(String(r.id), { ...(byId.get(String(r.id)) || {}), ...r })
          list = [...byId.values()]
        }
      }
      const [d] = parseAgentDocs({ ...head, provider, sessions: list.slice(-MAX_SESSIONS) }, provider)
      writes.push({ file, provider, json: this.serialize(d), count: d.sessions.length })
    }
    if (!writes.length) throw err('no providers found')
    fs.mkdirSync(AGENTS_DIR, { recursive: true, mode: 0o700 })
    for (const w of writes) writeAtomic(w.file, w.json)
    if (this.scan()) this.changed()
    return { providers: writes.map(({ provider, count }) => ({ provider, count, enabled: this.enabled(provider) })) }
  }
  readRaw(file, provider) {
    try {
      const x = splitAgentDocs(JSON.parse(fs.readFileSync(file, 'utf8')), provider).find(d => d.provider === provider)
      if (!x) return null
      const { sessions: _s, ...meta } = x.doc
      return { meta, rows: x.rows.filter(r => r && typeof r === 'object') }
    } catch { return null }
  }
  serialize(d) {
    const sessions = d.sessions.map(({ key, provider, ...s }) => ({ ...s, needs: s.needs || undefined, title: s.title || undefined, message: s.message || undefined, progress: s.progress ?? undefined, open: s.open || undefined, updatedAt: new Date(s.updatedAt || Date.now()).toISOString() }))
    return JSON.stringify({ deckstudio: AGENT_SCHEMA, provider: d.provider, name: d.name, app: d.app, logo: d.logo, schemes: d.schemes, sessions }, null, 2)
  }
  /** POST /api/agents/status: { provider, id, state, needs?, message?, name?, title?, app?, progress?, open? } upserts one session ("gone" removes it). */
  status(body) {
    const s = cleanAgentStatus(body)
    const file = path.join(AGENTS_DIR, `${s.provider}.json`)
    this.scan()
    const owner = this.owners().get(s.provider)
    if (owner && owner.file !== `${s.provider}.json`) throw err(`"${s.provider}" comes from ${owner.file}: update that file, or push under another id`)
    const old = this.readRaw(file, s.provider) || { meta: { provider: s.provider }, rows: [] }
    const { provider: _p, remove, ...fields } = s
    let rows = old.rows.filter(r => String(r.id) !== s.id)
    const prev = old.rows.find(r => String(r.id) === s.id)
    if (!remove) {
      const row = { ...(prev || {}), ...fields, updatedAt: Date.now() }
      if (row.state !== 'needs') delete row.needs
      rows.push(row)
    }
    // the oldest go first once a provider holds too many
    rows = rows.sort((a, b) => activityMs(a.updatedAt) - activityMs(b.updatedAt)).slice(-MAX_SESSIONS)
    const [d] = parseAgentDocs({ ...old.meta, provider: s.provider, sessions: rows }, s.provider)
    fs.mkdirSync(AGENTS_DIR, { recursive: true, mode: 0o700 })
    writeAtomic(file, this.serialize(d))
    if (this.scan()) this.changed()
    return { ok: true, provider: s.provider, id: s.id, removed: !!remove, enabled: this.enabled(s.provider) }
  }
  /** POST /api/agents/remove { provider, id? }: one session, or the provider's file (moved to agents/.removed). */
  remove(provider, id) {
    if (!PROVIDER_RE.test(provider) || provider === 'rex') throw err('bad provider')
    if (id) return this.status({ provider, id, state: 'gone' })
    const moved = []
    for (const [f, e] of this.files) {
      if (f !== `${provider}.json` && !e.docs.some(d => d.provider === provider)) continue
      try {
        fs.mkdirSync(REMOVED_DIR, { recursive: true, mode: 0o700 })
        fs.renameSync(path.join(AGENTS_DIR, f), path.join(REMOVED_DIR, `${f.replace(/\.json$/, '')}.${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
        moved.push(f)
      } catch {}
    }
    if (this.scan()) this.changed()
    return { removed: moved.length, moved, to: REMOVED_DIR }
  }

  // ---------- the combined list ----------
  attention(s) {
    if (s.provider === 'rex') return s.attention
    return attentionOf(s, { seen: this.seen.get(s.key) || 0, baseline: this.startedAt })
  }
  /** Every enabled provider's sessions: needs you > ready for review > working > idle; stable within a group. */
  list() {
    const own = this.owners()
    const rex = this.trust('rex', own).enabled && this.rex.available ? this.rex.list().map(fromRex) : []
    const rest = this.sessions(own).map(s => ({ ...s, session: s.name, msg: s.message, kind: s.needs || '', blockId: s.key, attention: this.attention(s) }))
    for (const s of rest) if (!this.firstSeen.has(s.key)) this.firstSeen.set(s.key, Date.now())
    const order = a => (a.provider === 'rex' ? this.rex.firstSeen.get(a.id) : this.firstSeen.get(a.key)) || 0
    return sortAgents([...rex, ...rest], order).map(a => ({ ...a, press: this.pressText(a, own) }))
  }
  counts() { return countAgents(this.list()) }
  get(key) { return this.list().find(a => a.key === key) || null }

  providers() {
    const own = this.owners()
    const t = this.trust('rex', own)
    const rexCount = this.rex.available ? this.rex.list().length : 0
    const out = [{
      ...BUILTIN_PROVIDERS.rex, enabled: t.enabled, installed: !!this.rex.installed, available: !!this.rex.available, count: rexCount,
      error: this.rex.installed && !this.rex.available && this.rex.error ? this.rex.error : null,
    }]
    const now = Date.now()
    for (const [id, o] of own) {
      const tr = this.trust(id, own), d = o.doc
      const presses = d.sessions.map(s => agentPress(s, tr, d.app))
      out.push({
        id, name: d.name, kind: BUILTIN_PROVIDERS[id]?.kind || 'file', file: o.file, app: d.app, logo: d.logo, enabled: tr.enabled,
        count: d.sessions.filter(s => now - s.updatedAt < STALE_MS).length, stale: d.sessions.filter(s => now - s.updatedAt >= STALE_MS).length,
        schemes: d.schemes || [], allowed: tr.schemes,
        blockedSchemes: [...new Set(presses.filter(p => p.blocked).map(p => p.url.slice(0, p.url.indexOf(':')).toLowerCase()))],
        error: this.files.get(o.file)?.error || null,
      })
    }
    // the ready-made hooks show up even before their first push, so the editor can explain how to set them up
    for (const id of ['claude-code', 'codex']) if (!own.has(id)) out.push({ ...BUILTIN_PROVIDERS[id], enabled: this.trust(id, own).enabled, count: 0, waiting: true })
    for (const x of own.dups) out.push({ id: x.doc.provider, name: x.doc.name, kind: 'file', file: x.file, count: 0, enabled: false, duplicate: true, error: `duplicate: "${x.doc.provider}" already comes from ${x.owner.file}` })
    for (const [f, e] of this.files) if (!e.docs.length) out.push({ id: f.replace(/\.json$/, ''), name: f, kind: 'file', file: f, count: 0, enabled: false, error: e.error || 'no sessions' })
    return out
  }
  summary() {
    const agents = this.list()
    const providers = this.providers()
    const rex = providers[0]
    // available: some enabled provider can report (older readers only knew Rex)
    return { available: providers.some(p => p.enabled && (p.kind !== 'rex' || p.available)), error: rex.enabled ? rex.error : null, counts: countAgents(agents), agents, providers, dir: AGENTS_DIR, hook: path.resolve(HOOK_SCRIPT) }
  }

  pressText(a, own = this.owners()) {
    if (a.provider === 'rex') return 'jumps rex to this session'
    const p = agentPress(a, this.trust(a.provider, own), own.get(a.provider)?.doc?.app)
    const what = p.kind === 'url' ? `opens ${p.url.slice(0, 60)}` : p.kind === 'app' ? `opens app ${p.target}` : 'marks it seen'
    return p.blocked ? `${what} — blocked: ${p.blocked}` : what
  }
  /** A press: Rex jumps to the block; any other provider's session is marked seen and its `open` runs (when trusted). */
  async go(key) {
    const a = this.get(key)
    if (!a) throw new Error('agent is gone')
    if (a.provider === 'rex') return this.rex.go(a.id)
    this.markSeen(key)
    const own = this.owners()
    const p = agentPress(a, this.trust(a.provider, own), own.get(a.provider)?.doc?.app)
    if (p.blocked) throw new Error(`${p.blocked} (editor → agents page → providers)`)
    const run = args => new Promise((res, rej) => execFile('open', args, e => (e ? rej(e) : res())))
    if (p.kind === 'url') { await run([p.url]); return `opened ${p.url.slice(0, 40)}` }
    if (p.kind === 'app') { await run(['-b', p.target]); return `opened ${p.target}` }
    return 'marked seen'
  }
  markSeen(key) {
    const a = this.get(key)
    if (a?.provider === 'rex') return this.rex.markSeen(a.id)
    this.seen.set(key, Date.now())
    this.saveSeen()
    this.changed()
  }
}
export { REX_BUNDLE }
