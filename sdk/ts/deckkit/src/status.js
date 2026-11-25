// Status file + heartbeat, and the reader with DeckStudio's staleness rules.
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { randomBytes } from 'node:crypto'

export const STATUS_SCHEMA = 'status/v1'
/** Rewrite at least this often while running (ms). */
export const HEARTBEAT_MS = 30_000
/** A status older than this is stale (ms). Put the same number (in seconds: 95) in the manifest's `status.stale`. */
export const STALE_MS = 95_000

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)

/**
 * The folder a tool keeps its DeckStudio files in: `~/Library/Application Support/<app>` on macOS,
 * `$XDG_STATE_HOME/<app>` (or `~/.local/state/<app>`) elsewhere. `~` is `os.homedir()` (honours `HOME`).
 * @param {string} app
 */
export function appDir(app, { platform = process.platform, env = process.env } = {}) {
  if (!app || /[/\\]|^\.\.?$/.test(app)) throw new Error(`appDir: bad app name ${JSON.stringify(app)}`)
  if (platform === 'darwin') return join(homedir(), 'Library', 'Application Support', app)
  return join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), app)
}
/** `<appDir>/deckstudio-status.json` */
export const statusPath = app => join(appDir(app), 'deckstudio-status.json')
/** `<appDir>/control-token` */
export const tokenPath = app => join(appDir(app), 'control-token')

/** Creates the folder 0700 if missing (an existing folder keeps its mode). */
export function ensureDir(dir) {
  try { if (statSync(dir).isDirectory()) return } catch {}
  mkdirSync(dir, { recursive: true, mode: 0o700 })
}

/** Atomic write: a 0600 temp file next to the target (O_EXCL), then rename(2). A reader never sees half a file. */
export function writeAtomic(file, text) {
  ensureDir(dirname(file))
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  const fd = openSync(temp, 'wx', 0o600)
  try { writeSync(fd, text) } catch (e) { closeSync(fd); try { unlinkSync(temp) } catch {} throw e }
  closeSync(fd)
  try { renameSync(temp, file) } catch (e) { try { unlinkSync(temp) } catch {} throw e }
}

/** One word: whitespace/control characters become `-`, at most 40 characters. */
export function cleanState(s) {
  const w = String(s ?? '').replace(/[\s\u0000-\u001f\u007f]/g, '-').slice(0, 40)
  return w || 'idle'
}

/**
 * The heartbeat a status document reports, in epoch ms (`updated_at` / `updatedAt` / `heartbeat`; ISO, or epoch
 * seconds / ms as a number or digit string), or null. Same rule as DeckStudio's `heartbeatAt`.
 * @param {unknown} doc
 * @returns {number | null}
 */
export function heartbeatAt(doc) {
  if (!isObj(doc)) return null
  const v = doc.updated_at ?? doc.updatedAt ?? doc.heartbeat
  const n = typeof v === 'number' ? v : typeof v === 'string' ? (/^\d+$/.test(v) ? Number(v) : Date.parse(v)) : NaN
  return Number.isFinite(n) && n > 0 ? (n < 1e11 ? n * 1000 : n) : null
}

/** Our tool runs as this user, so EPERM (another user's process that reused the pid) is not it. */
export function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * A status writer. See index.d.ts for the full contract.
 * @param {{ app?: string, file?: string, heartbeatMs?: number, pid?: number, now?: () => Date, keepAlive?: boolean }} opts
 */
export function createStatus(opts = {}) {
  const file = opts.file || (opts.app ? statusPath(opts.app) : null)
  if (!file) throw new Error('createStatus: give { app } or { file }')
  const heartbeatMs = Math.max(50, Math.min(Number(opts.heartbeatMs) || HEARTBEAT_MS, HEARTBEAT_MS))
  const pid = opts.pid ?? process.pid
  const now = opts.now || (() => new Date())
  let state = null, since = null, values = {}, running = false, timer = null

  const self = {
    file,
    pid,
    /** @type {Error | null} */
    lastError: null,
    snapshot() {
      const doc = { schema: STATUS_SCHEMA, state: state ?? 'idle', running, pid, updated_at: now().toISOString(), values: { ...values } }
      if (since) doc.since = since
      return doc
    },
    write() {
      try { writeAtomic(file, `${JSON.stringify(self.snapshot())}\n`); self.lastError = null; return true }
      catch (e) { self.lastError = e; return false }
    },
    set(next, vals) {
      const w = cleanState(next)
      if (w !== state) since = now().toISOString()
      state = w
      if (vals !== undefined) values = { ...vals }
      running = w !== 'off'
      const ok = self.write()
      if (running && !timer) { timer = setInterval(() => self.write(), heartbeatMs); if (!opts.keepAlive) timer.unref?.() }
      if (!running) stopTimer()
      return ok
    },
    update(vals) {
      for (const [k, v] of Object.entries(vals || {})) { if (v === null || v === undefined) delete values[k]; else values[k] = v }
      return state == null ? self.set('idle') : self.write()
    },
    stop(finalState = 'off', vals) {
      stopTimer()
      const w = cleanState(finalState)
      if (w !== state) since = now().toISOString()
      state = w
      if (vals !== undefined) values = { ...vals }
      running = false
      return self.write()
    },
  }
  function stopTimer() { clearInterval(timer); timer = null }
  return self
}

/**
 * Reads a status file the way DeckStudio does (for `mytool status --line|--json`).
 * @param {{ app?: string, file?: string, staleAfterMs?: number, offState?: string, now?: number, isAlive?: (pid: number) => boolean }} opts
 */
export function readStatus(opts = {}) {
  const file = opts.file || (opts.app ? statusPath(opts.app) : null)
  if (!file) throw new Error('readStatus: give { app } or { file }')
  const off = opts.offState ?? 'off', staleAfter = opts.staleAfterMs ?? STALE_MS, now = opts.now ?? Date.now(), alive = opts.isAlive || isAlive
  const missing = { state: off, reportedState: null, running: false, pid: null, updatedAt: null, since: null, values: {}, stale: false, staleReason: null, document: { schema: STATUS_SCHEMA, state: off, running: false } }
  let doc
  try {
    const text = readFileSync(file, 'utf8')
    if (text.length > 1 << 20) return missing
    doc = JSON.parse(text)
  } catch { return missing }
  if (!isObj(doc)) return missing
  const state = typeof doc.state === 'string' ? doc.state : typeof doc.status === 'string' ? doc.status : off
  const pid = Number.isInteger(doc.pid) ? doc.pid : null
  const hb = heartbeatAt(doc)
  const running = typeof doc.running === 'boolean' ? doc.running : state !== off
  let staleReason = null
  if (doc.stale === true) staleReason = 'flag'
  else if (running && pid != null && pid > 1 && !alive(pid)) staleReason = 'pid'
  // a clean stop (`running: false`, any final state) is never stale by age: DeckStudio reads it as `_state: stopped`
  else if (running && state !== off && (hb == null || now - hb > staleAfter)) staleReason = 'heartbeat'
  const out = { state, reportedState: state, running, pid, updatedAt: hb, since: typeof doc.since === 'string' ? doc.since : null, values: isObj(doc.values) ? doc.values : {}, stale: !!staleReason, staleReason, document: doc }
  if (staleReason) Object.assign(out, { state: off, running: false, document: { ...doc, state: off, running: false, stale: true } })
  return out
}
