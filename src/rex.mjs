// Rex agent sessions: discovers every agent (Claude Code, Codex, Ante, …) running in a Rex
// terminal block, tracks its reported status live via `rex events`, and jumps Rex to it.
//
// Rex's program_status records: state is idle | working | done | blocked (waiting for the user;
// kind = permission | question | auth) | error. The root record (no id) is the agent itself;
// records with an id (a/b) are its subagents.
import { EventEmitter } from 'node:events'
import { spawn, spawnSync, execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// Finding the Rex CLI without running whatever happens to match: an explicit override (DECKSTUDIO_REX_CLI /
// REX_BIN, the user's own choice) is used as is; otherwise only known install locations are considered, and a
// candidate is executed only after its code signature verifies and carries Superlogical's team id
// (DECKSTUDIO_REX_TEAM overrides it for a fork of Rex). Spotlight (mdfind) is consulted only on opt-in
// (DECKSTUDIO_REX_SPOTLIGHT=1), and its hits pass the same signature check. Absent → the rex provider
// reads "not installed" (no errors, no retries spam).
export const REX_BUNDLE = 'com.superlogical.rex'
export const REX_SERVER_BUNDLE = 'com.superlogical.rex.server'
export const REX_TEAM = 'AG92C3PT77' // Developer ID Application: Superlogical, Inc.
const HOME = process.env.HOME || ''
const exe = p => { try { fs.accessSync(p, fs.constants.X_OK); return fs.statSync(p).isFile() } catch { return false } }
/** Known install locations of the Rex CLI (not env overrides): each must still pass verifyRex before it runs. */
export function rexCandidates(env = process.env, home = env.HOME || HOME) {
  const apps = ['/Applications', home && path.join(home, 'Applications')].filter(Boolean)
  return [
    home && path.join(home, 'Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex'),
    ...apps.flatMap(a => [path.join(a, 'Rex.app/Contents/MacOS/rex'), path.join(a, 'Rex.app/Contents/Resources/rex'), path.join(a, 'Rex Server.app/Contents/MacOS/rex')]),
    '/opt/homebrew/bin/rex', '/usr/local/bin/rex',
  ].filter(Boolean)
}
const verdicts = new Map() // realpath → { mtime, ok }
/**
 * Is this the genuine Rex CLI? `codesign --verify --strict` passes with a requirement (an Apple-anchored certificate
 * whose leaf OU is the team) and `codesign -dv` reports the expected TeamIdentifier (env DECKSTUDIO_REX_TEAM, default Superlogical's). Cached per real path + mtime. Returns the real path or null.
 */
export function verifyRex(p, { team = process.env.DECKSTUDIO_REX_TEAM || REX_TEAM, codesign = '/usr/bin/codesign' } = {}) {
  let real, st
  try { real = fs.realpathSync(p); st = fs.statSync(real) } catch { return null }
  if (!st.isFile() || !exe(real)) return null
  const key = `${real}\0${team}`
  const hit = verdicts.get(key)
  if (hit && hit.mtime === st.mtimeMs && hit.size === st.size) return hit.ok ? real : null
  let ok = false
  try {
    const tid = team.replace(/[^A-Z0-9]/gi, '')
    // the TeamIdentifier `codesign -dv` prints comes from the CodeDirectory, which any signer (even ad-hoc) can set:
    // the requirement makes codesign check that an Apple-issued certificate of that team really signed it
    execFileSync(codesign, ['--verify', '--strict', `-R=anchor apple generic and certificate leaf[subject.OU] = "${tid}"`, real], { timeout: 5000, stdio: 'ignore' })
    const r = spawnSync(codesign, ['-dv', real], { timeout: 5000, encoding: 'utf8' })
    ok = r.status === 0 && new RegExp(`^TeamIdentifier=${tid}$`, 'm').test(String(r.stderr || ''))
  } catch { ok = false }
  verdicts.set(key, { mtime: st.mtimeMs, size: st.size, ok })
  return ok ? real : null
}
/** Spotlight: every "Rex Server.app" (bundle id com.superlogical.rex.server) → its CLI path; the Current version first. Unverified. */
function viaSpotlight() {
  try {
    const out = execFileSync('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${REX_SERVER_BUNDLE}"`], { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    const apps = out.split('\n').filter(Boolean).sort((a, b) => b.includes('/Current/') - a.includes('/Current/'))
    return apps.map(a => path.join(a, 'Contents/MacOS/rex'))
  } catch { return [] }
}
/**
 * The Rex CLI path, or null. `DECKSTUDIO_REX_CLI` / `REX_BIN` (explicit user choice) are used as is: set but not
 * executable → null (never second-guessed). Otherwise the first known location (or, with DECKSTUDIO_REX_SPOTLIGHT=1,
 * Spotlight hit) whose signature verifies. opts (tests): candidates, verify, spotlight (false skips it), mdfind.
 */
export function locateRex(env = process.env, { spotlight = true, candidates, verify = verifyRex, mdfind = viaSpotlight } = {}) {
  if (env.DECKSTUDIO_REX_CLI) return exe(env.DECKSTUDIO_REX_CLI) ? env.DECKSTUDIO_REX_CLI : null
  if (env.REX_BIN) return exe(env.REX_BIN) ? env.REX_BIN : null
  for (const c of candidates ?? rexCandidates(env)) { if (exe(c)) { const v = verify(c); if (v) return v } }
  if (spotlight && env.DECKSTUDIO_REX_SPOTLIGHT === '1' && process.platform === 'darwin') for (const c of mdfind()) { if (exe(c)) { const v = verify(c); if (v) return v } }
  return null
}
export let REX = locateRex(process.env, { spotlight: false }) // known paths now; Spotlight (opt-in only) once, on start()
const SEEN_FILE = path.join(process.env.DECKSTUDIO_HOME || path.join(HOME, '.deckstudio'), 'rex-seen.json')

const NEEDS = new Set(['blocked', 'error'])
const URGENCY = { blocked: 0, error: 1, done: 2, working: 3, idle: 4 }
const SPINNER = /^[⠀-⣿✳✶✻✽✢·*◐◓◑◒|/\\-]\s+/u
// terminal titles often end in "| <host>" or "· <app>": drop this Mac's name and a trailing app tag
const HOST = os.hostname().replace(/\.local$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const cleanTitle = t => String(t || '').replace(SPINNER, '').replace(new RegExp(`\\s*\\|\\s*${HOST}$`, 'i'), '').replace(/\s*·\s*[A-Z][\w-]{1,20}$/, '').trim()
const ts = s => Date.parse(s || '') || 0

// One flat cap on concurrent `rex` processes, whatever is asking.
let active = 0
const waiting = []
async function slot(fn) {
  if (active >= 6) await new Promise(r => waiting.push(r))
  active++
  try { return await fn() } finally { active--; waiting.shift()?.() }
}
function rex(args, { timeout = 8000 } = {}) {
  return slot(() => new Promise((resolve, reject) => {
    if (!REX) return reject(new Error('rex CLI not found'))
    execFile(REX, ['--autostart=false', '--color', 'never', ...args], { timeout, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).toString().trim().split('\n')[0]))
      try { resolve(stdout.trim() ? JSON.parse(stdout) : {}) } catch { resolve({ raw: stdout }) }
    })
  }))
}
const call = (method, obj, session) => rex(['api', 'call', ...(session ? ['--session', session] : []), method, JSON.stringify(obj || {})])

/** The agent's own record (no id) wins; otherwise the most urgent subagent record. */
export function pickRecord(records) {
  const list = (records || []).filter(Boolean)
  return list.find(r => !r.id) || list.sort((a, b) => (URGENCY[a.state] ?? 4) - (URGENCY[b.state] ?? 4) || ts(b.updated_at) - ts(a.updated_at))[0] || null
}

export class RexAgents extends EventEmitter {
  constructor() {
    super()
    this.agents = new Map() // block_id -> agent
    this.available = !!REX
    this.installed = !!REX
    this.error = null // a missing Rex is "not installed", not an error
    this.startedAt = Date.now()
    this.seen = new Map(Object.entries(this.loadSeen())) // block_id -> ms the user last looked (via the deck)
    this.firstSeen = new Map() // block_id -> ms we first saw it: a stable order within each group
    this.dirty = false
  }
  loadSeen() { try { return JSON.parse(fs.readFileSync(SEEN_FILE, 'utf8')) } catch { return {} } }
  saveSeen() {
    clearTimeout(this.seenTimer)
    this.seenTimer = setTimeout(() => {
      const live = Object.fromEntries([...this.seen].filter(([id]) => this.agents.has(id)))
      try { fs.writeFileSync(SEEN_FILE, JSON.stringify(live), { mode: 0o600 }) } catch {}
    }, 500)
  }

  /** Agents by urgency: needs you > ready for review > working > idle; stable within a group. */
  list() {
    const rank = { needs: 0, review: 1, working: 2, idle: 3 }
    return [...this.agents.values()].map(a => ({ ...a, attention: this.attentionOf(a) }))
      .sort((a, b) => rank[a.attention] - rank[b.attention] || (this.firstSeen.get(a.blockId) || 0) - (this.firstSeen.get(b.blockId) || 0) || a.blockId.localeCompare(b.blockId))
  }
  attentionOf(a) {
    const seen = this.seen.get(a.blockId) || 0
    const baseline = Math.max(seen, this.startedAt) // anything before DeckStudio started counts as seen
    const changed = ts(a.updatedAt)
    if (a.state === 'blocked' && !(seen && seen >= changed)) return 'needs' // waiting on you until dismissed
    if (a.state === 'error' && changed > baseline) return 'needs'
    if (a.alertAt && a.alertAt > baseline) return 'needs'
    if (a.state === 'done' && changed > baseline) return 'review'
    if (a.state === 'working' || a.state === 'blocked') return 'working'
    return 'idle'
  }
  counts() {
    const c = { needs: 0, review: 0, working: 0, idle: 0 }
    for (const a of this.list()) c[a.attention]++
    return c
  }

  start() {
    if (!REX && !this.located) REX = locateRex() // Spotlight once per run, not on every retry
    this.located = true
    this.installed = !!REX
    if (!REX || this.started) return
    this.started = true
    this.refresh()
    this.timer = setInterval(() => this.refresh(), 20000)
    this.stream()
  }
  stop() {
    this.stopped = true
    clearInterval(this.timer)
    for (const t of [this.soon, this.chg, this.maxWait, this.restartTimer, this.seenTimer]) clearTimeout(t)
    this.proc?.kill()
  }

  stream() {
    if (this.stopped || this.proc) return
    const p = (this.proc = spawn(REX, ['--autostart=false', 'events', '--all', '--json'], { stdio: ['ignore', 'pipe', 'ignore'] }))
    p.stdout.setEncoding('utf8') // never split multi-byte characters across chunks
    let buf = ''
    let gotData = false
    p.stdout.on('data', d => {
      if (!gotData) { gotData = true; this.backoff = 0; this.refreshSoon(0) } // (re)connected: catch up on missed events
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        try { this.onEvent(JSON.parse(line)) } catch {}
      }
    })
    const restart = () => {
      if (this.proc !== p) return
      this.proc = null
      if (this.stopped) return
      this.backoff = Math.min(60000, (this.backoff || 1500) * 2)
      this.restartTimer = setTimeout(() => this.stream(), this.backoff)
    }
    p.on('exit', restart)
    p.on('error', restart) // spawn failures (e.g. during a Rex update) fire 'error', not 'exit'
  }
  onEvent(e) {
    if (e.type !== 'session_event') {
      if (/^session_(created|removed|destroyed)/.test(e.type)) this.refreshSoon()
      return
    }
    const ev = e.payload?.event
    if (!ev) return
    if (ev.type !== 'block_event') {
      if (/^(block|window)_(created|added|removed|closed|destroyed|moved|placed)/.test(ev.type)) this.refreshSoon()
      return
    }
    const { block_id: id, name, payload } = ev.payload || {}
    const a = this.agents.get(id)
    switch (name) {
      case 'title_changed':
        if (a) { const t = cleanTitle(payload?.title); if (t && t !== a.title) { a.title = t; this.changed() } }
        break
      case 'bell':
      case 'desktop_notification':
        if (!a) return this.refreshSoon()
        a.alertAt = Date.now()
        a.alert = name === 'bell' ? 'bell' : [payload?.title, payload?.body].filter(Boolean).join(': ')
        this.changed()
        this.emit('alert', { ...a, attention: 'needs' })
        break
      case 'program_status_changed': {
        if (!a) return this.refreshSoon() // a new agent appeared
        a.records.set(payload?.id ?? '', payload?.record || {})
        this.applyRecord(a)
        break
      }
      case 'program_status_removed': {
        if (!a) return
        for (const rid of payload?.ids || []) a.records.delete(rid)
        if (!a.records.size) { this.agents.delete(id); this.changed() } else this.applyRecord(a)
        break
      }
      case 'child_exited':
        if (a) { this.agents.delete(id); this.changed() }
        break
    }
  }
  applyRecord(a) {
    const rec = pickRecord([...a.records].map(([id, r]) => ({ ...r, id: id || undefined })))
    if (!rec) return
    const prev = a.state
    Object.assign(a, { app: rec.effective_app || rec.app || a.app, state: rec.state || 'idle', kind: rec.kind || '', msg: rec.msg || '', updatedAt: rec.updated_at || a.updatedAt, progress: rec.progress ?? null })
    if (a.state !== prev && NEEDS.has(a.state)) this.emit('alert', { ...a, attention: 'needs' })
    this.changed()
  }
  /** Debounced, but never postponed more than 2 s by a steady stream of events. */
  refreshSoon(ms = 400) {
    clearTimeout(this.soon)
    this.soon = setTimeout(() => this.refresh(), ms)
    this.maxWait ??= setTimeout(() => this.refresh(), 2000)
  }
  changed() { clearTimeout(this.chg); this.chg = setTimeout(() => this.emit('change'), 60) }

  async refresh() {
    clearTimeout(this.soon); clearTimeout(this.maxWait); this.maxWait = null
    if (this.refreshing) { this.dirty = true; return this.refreshing } // run again once this one finishes
    this.refreshing = this._refresh().finally(() => {
      this.refreshing = null
      if (this.dirty && !this.stopped) { this.dirty = false; this.refresh() }
    })
    return this.refreshing
  }
  async _refresh() {
    if (this.stopped) return
    try {
      const { sessions = [] } = await call('session.list')
      const found = new Map()
      await Promise.all(sessions.map(async s => {
        const { blocks } = await call('session.list_blocks', {}, s.session_id).catch(() => ({}))
        const terms = (blocks || []).filter(b => b.creator_name === 'com.superlogical.terminal')
        await Promise.all(terms.map(async b => {
          const m = method => call('block.method', { block_id: b.block_id, method }, s.session_id).catch(() => null)
          const [st, ti] = await Promise.all([m('program_status'), m('title')])
          const records = st?.records || []
          const rec = pickRecord(records)
          if (!rec) return // not an agent: plain shells, caffeinate, …
          const prev = this.agents.get(b.block_id)
          if (!this.firstSeen.has(b.block_id)) this.firstSeen.set(b.block_id, Date.now())
          const agent = {
            blockId: b.block_id, sessionId: s.session_id, session: s.label || s.session_id.slice(-6),
            windowId: b.window_id, app: rec.effective_app || rec.app || 'agent', state: rec.state || 'idle', kind: rec.kind || '',
            msg: rec.msg || '', title: cleanTitle(ti?.title) || prev?.title || '', updatedAt: rec.updated_at || '', progress: rec.progress ?? null,
            pid: rec.owner?.pid, alertAt: prev?.alertAt, alert: prev?.alert,
            records: new Map(records.map(r => [r.id || '', r])),
          }
          if (prev && agent.state !== prev.state && NEEDS.has(agent.state)) this.emit('alert', { ...agent, attention: 'needs' })
          found.set(b.block_id, agent)
        }))
      }))
      this.agents = found
      this.available = true
      this.error = null
    } catch (e) {
      this.available = false
      this.error = e.message
    }
    this.emit('change')
  }

  /** Bring Rex forward on this agent's session, window and block. */
  /** Bring Rex forward on this agent's session, window and block. Returns the steps; throws if Rex couldn't be switched. */
  async go(blockId) {
    const a = this.agents.get(blockId)
    if (!a) throw new Error('agent is gone')
    this.markSeen(blockId)
    const steps = []
    const { clients = [] } = await call('client.list')
    const app = clients.find(c => c.info?.kind === 'app' && c.connection_state !== 'disconnected')
    if (!app?.client_id) throw new Error('the Rex app is not running')
    try {
      await call('client.perform', { client_id: app.client_id, action: 'session.select', args: { session_id: a.sessionId, window_id: a.windowId } })
      steps.push(`session ${a.session}`)
    } catch (e) { throw new Error(`rex couldn't switch to session ${a.session}: ${e.message}`) }
    try { await call('session.focus_block', { block_id: a.blockId }, a.sessionId); steps.push('pane focused') }
    catch (e) { steps.push(`pane not focused (${e.message})`) }
    await new Promise(r => execFile('open', ['-b', REX_BUNDLE], () => r()))
    steps.push('rex in front')
    return steps.join(' → ')
  }
  markSeen(blockId) {
    this.seen.set(blockId, Date.now())
    const a = this.agents.get(blockId)
    if (a) a.alertAt = undefined
    this.saveSeen()
    this.emit('change')
  }
}
