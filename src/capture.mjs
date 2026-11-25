// Screenshots and screen recording via /usr/sbin/screencapture, spawned directly.
// Why not synthetic ⌘⇧3/⌘⇧4: macOS ignores synthesized screenshot hotkeys (System Events or
// CGEvent): the press "succeeds" and nothing happens. screencapture works and reports results.
//
//   { type: 'capture', mode, to, delay, delayDial, cursor, clicks, audio, sound, maxSeconds }
//   mode: screen | selection | window | record | toolbar | folder | copy-last | reveal-last | open-last | check
//   to:   file (default) | clipboard
//
// Files go where macOS puts screenshots (`defaults read com.apple.screencapture location`, else ~/Desktop),
// named like macOS does. DECKSTUDIO_CAPTURE_DIR overrides the folder (tests).
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../bin/deckhelper')
const helper = args => new Promise((resolve, reject) => execFile(HELPER, args, { timeout: 5000 }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim())) : resolve(String(out).trim()))))
// NSPasteboard changeCount (+ whether it holds an image): tells "copied" from "Esc" for clipboard captures
// (both exit 0). null when the helper can't say: the result is then reported as unknown, never as "copied".
const pbCount = () => helper(['pb-count']).then(s => { const j = JSON.parse(s); return Number.isFinite(j.count) ? j : null }).catch(() => null)

const SC = process.env.DECKSTUDIO_SCREENCAPTURE || '/usr/sbin/screencapture' // override: tests only
const HOME = os.homedir()
const STATE = path.join(process.env.DECKSTUDIO_HOME || path.join(HOME, '.deckstudio'), 'recording.json')
const SETTINGS_PANE = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
export const CAPTURE_MODES = ['screen', 'selection', 'window', 'record', 'toolbar', 'folder', 'copy-last', 'reveal-last', 'open-last', 'check']

const MAX_RECORD_S = 3 * 3600 // default cap on a recording (`maxSeconds`): bounds one nobody stops, even after a crash
const st = {
  rec: null,          // { starting | stopping, proc, pid, file, started, tick, done }: set before the first await
  interactive: null,  // { mode, proc, cancelled }: the selection/window capture waiting for you (one at a time)
  timed: null,        // { mode, proc, cancelled }: the countdown capture
  last: null,         // path of the last saved capture
  access: null, settingsOpened: false,
  reserved: new Set(), // file names handed out but not written yet (two quick presses never share a name)
}

const defaults = key => new Promise(r => execFile('defaults', ['read', 'com.apple.screencapture', key], { timeout: 3000 }, (e, out) => r(e ? null : String(out).trim())))
const exists = p => { try { return fs.statSync(p).size > 0 } catch { return false } }
const pad = n => String(n).padStart(2, '0')
const fmtDur = ms => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${pad(s % 60)}` }

/** Live values for templates: {recording} ('on'/''), {rec_time} ('off' or m:ss), {last_capture} (short name of the last file) */
export function captureVars() {
  return {
    recording: st.rec?.started ? 'on' : '',
    rec_time: st.rec?.started ? fmtDur(Date.now() - st.rec.started) : 'off',
    last_capture: st.last ? path.basename(st.last).replace(/^(Screenshot|Screen Recording) \d{4}-\d\d-\d\d at /, (m, k) => (k === 'Screenshot' ? '' : '🎬 ')) : '—',
  }
}

/** A record key turns red and shows the elapsed time while recording. */
export function captureDecorate(k) {
  const p = k?.onPress
  const rec = (p?.type === 'capture' && p.mode === 'record') || (p?.type === 'plugin' && p.plugin === 'capture' && p.action === 'record')
  if (!st.rec?.started || !rec) return k
  return { ...k, tone: 'key', accent: '#e5484d', led: true, ledColor: '#e5484d', motion: 'pulse', label: 'Stop', title: `● ${fmtDur(Date.now() - st.rec.started)}` }
}

async function saveDir() {
  if (process.env.DECKSTUDIO_CAPTURE_DIR) { fs.mkdirSync(process.env.DECKSTUDIO_CAPTURE_DIR, { recursive: true }); return process.env.DECKSTUDIO_CAPTURE_DIR }
  const loc = (await defaults('location'))?.replace(/^~(?=\/|$)/, HOME)
  try { if (loc && fs.statSync(loc).isDirectory()) return loc } catch {}
  return path.join(HOME, 'Desktop')
}
const gdefault = key => new Promise(r => execFile('defaults', ['read', '-g', key], { timeout: 3000 }, (e, o) => r(e ? null : String(o).trim())))
// 24-hour clock like the menu bar: the explicit override if set, else the region's default (AppleLocale → Intl hourCycle).
// Re-read at most once a minute, so a change in System Settings shows up without a restart.
let clock = { h24: false, at: 0 }
async function uses24h() {
  if (Date.now() - clock.at < 60e3) return clock.h24
  const [f24, f12, loc] = await Promise.all([gdefault('AppleICUForce24HourTime'), gdefault('AppleICUForce12HourTime'), gdefault('AppleLocale')])
  let h24 = false
  if (f24 === '1') h24 = true
  else if (f12 === '1') h24 = false
  else { try { h24 = /h2[34]/.test(new Intl.DateTimeFormat((loc || 'en_US').split('@')[0].replace(/_/g, '-'), { hour: 'numeric' }).resolvedOptions().hourCycle || '') } catch {} }
  clock = { h24, at: Date.now() }
  return h24
}
async function stamp(d = new Date()) {
  const force24 = await uses24h()
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const h = d.getHours()
  const time = force24 ? `${pad(h)}.${pad(d.getMinutes())}.${pad(d.getSeconds())}` : `${h % 12 || 12}.${pad(d.getMinutes())}.${pad(d.getSeconds())}\u202f${h < 12 ? 'AM' : 'PM'}`
  return `${date} at ${time}`
}
/** macOS-style names: "Screenshot 2026-11-24 at 9.41.18 AM.png" (U+202F before AM/PM, as macOS writes it), "(2)" for further displays / collisions. */
// `when`: the moment the picture is taken (a timed capture is stamped when it fires, like macOS does).
// Names are reserved until release(): a second capture in the same second gets " (2)".
async function names(kind, ext, count = 1, when = new Date()) {
  const dir = await saveDir()
  const prefix = kind === 'video' ? 'Screen Recording' : ((await defaults('name')) || 'Screenshot')
  const base = `${prefix} ${await stamp(when)}`
  const out = []
  for (let n = 1; out.length < count; n++) {
    const f = path.join(dir, `${base}${n > 1 ? ` (${n})` : ''}.${ext}`)
    if (!fs.existsSync(f) && !st.reserved.has(f)) { out.push(f); st.reserved.add(f) }
  }
  return out
}
const release = files => { for (const f of files) st.reserved.delete(f) }

/** Screen Recording check (CGPreflightScreenCaptureAccess in deckhelper: never prompts). Read fresh for every
 *  capture (~50 ms): the display count and the permission can change at any time. */
async function access(engine, { quiet = false } = {}) {
  try { st.access = JSON.parse(await helper(['capture-access'])) }
  catch (e) { return { screen: true, displays: 1, unknown: e.message } } // helper missing: let screencapture try and report
  if (!st.access.screen && !quiet) denied(engine)
  return st.access
}
function denied(engine, detail = '') {
  const app = st.access?.responsible?.name || 'the app that started DeckStudio'
  engine.toast(`Screen Recording off: allow "${app}" in Settings`, 6000)
  engine.notify(`capture: Screen Recording permission missing${detail ? ` (${detail})` : ''}. Allow "${app}"${st.access?.responsible?.path ? ` (${st.access.responsible.path})` : ''} in System Settings › Privacy & Security › Screen & System Audio Recording, then restart DeckStudio.`, 'error')
  if (!st.settingsOpened) { st.settingsOpened = true; spawn('open', [SETTINGS_PANE], { stdio: 'ignore', detached: true }).unref() } // once per run, never a prompt loop
  st.access = { ...(st.access || {}), screen: false }
}
// screencapture's "can't write there" errors ("cannot write file to intended destination", "don't have permission
// to save files…"): a folder problem, not Screen Recording
const SAVE_RE = /cannot write file|intended destination|permission to save|read-only file system|no such file or directory/i

/** A failed capture: Screen Recording is blamed only when a fresh (uncached) check says it's off. */
async function failed(engine, what, msg, dir) {
  if (SAVE_RE.test(msg)) { engine.toast(`can't save to ${dir ? path.basename(dir) : 'the screenshots folder'}`, 3500); engine.notify(`${what}: can't write to ${dir || 'the screenshots folder'} (${msg}). Check the folder exists and is writable, or pick another in ⌘⇧5 › Options.`, 'error'); return }
  const acc = await access(engine, { quiet: true })
  if (acc.screen === false) denied(engine, msg)
  else engine.toast(`${what} failed: ${msg}`, 3000)
}

/** Run screencapture; resolves { code, stderr } — never rejects. */
function sc(args, { track } = {}) {
  return new Promise(resolve => {
    const p = spawn(SC, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    let err = ''
    p.stderr.on('data', d => { if (err.length < 4096) err += d })
    p.on('error', e => resolve({ code: -1, stderr: e.message }))
    p.on('close', (code, signal) => resolve({ code, signal, stderr: err.trim() }))
    if (track) track(p)
  })
}

function trace(engine, what, ok, extra = {}) { engine.trace({ ev: 'action', src: 'capture', action: what, ok, ...extra }) }

async function finish(engine, mode, to, files, r, pb, dir) {
  const label = `capture ${mode}${to === 'clipboard' ? ' → clipboard' : ''}`
  release(files)
  const interactive = mode === 'selection' || mode === 'window'
  const cancel = note => { engine.toast('capture cancelled', 1200); trace(engine, label, true, { note }); return { ok: true, cancelled: true } }
  const fail = async msg => { await failed(engine, 'capture', msg, to === 'file' ? dir : null); trace(engine, label, false, { error: msg }); return { ok: false, stderr: msg } }
  if (r.cancelled || r.signal) return cancel('cancelled') // pressed again / killed: nothing was taken
  const err = r.stderr.split('\n')[0]
  if (r.code !== 0 && r.code !== null) return fail(err || `exit ${r.code}`)
  if (to === 'clipboard') {
    // interactive + Esc exits 0 too: the pasteboard's change count tells whether anything was copied
    const known = pb?.before && pb?.after
    const changed = known && pb.before.count !== pb.after.count
    if (err && !changed) return fail(err) // exit 0 with an error message and nothing copied: a failure
    if (known && !changed) return interactive ? cancel('cancelled') : fail('nothing was copied')
    const copied = changed && pb.after.image !== false
    engine.toast(copied ? '📋 copied to clipboard' : 'capture done', 1800) // unknown: never claim "copied"
    trace(engine, label, true, { note: copied ? 'copied to clipboard' : 'done (clipboard not verified)' })
    return { ok: true, copied }
  }
  const saved = files.filter(exists)
  if (!saved.length) {
    // screencapture exits 0 even when it couldn't write ("cannot write file to intended destination"):
    // an error message, or a non-interactive capture without a file, is a failure. Esc in selection /
    // window mode (exit 0, no file, no message) is a quiet cancel.
    if (err || !interactive) return fail(err || 'no file was written')
    return cancel('cancelled (no file)')
  }
  st.last = saved[0]
  engine.toast(`saved ${path.basename(saved[0])}${saved.length > 1 ? ` +${saved.length - 1}` : ''}`, 2500)
  trace(engine, label, true, { note: saved.map(f => path.basename(f)).join(', ') })
  engine.scheduleRender()
  return { ok: true, files: saved }
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

// `slot`: the st.interactive / st.timed reservation runCapture made before any await (null for an instant shot).
// Pressing again sets slot.cancelled (and kills slot.proc once it exists), so nothing starts after a cancel.
async function shot(engine, a, delay, slot = null) {
  const mode = a.mode || 'screen', to = a.to === 'clipboard' ? 'clipboard' : 'file'
  const slotName = mode === 'screen' ? 'timed' : 'interactive'
  const clear = () => { if (slot && st[slotName] === slot) st[slotName] = null }
  const acc = await access(engine)
  if (!acc.screen) { clear(); return { ok: false, stderr: 'Screen Recording permission missing' } }
  const interactive = mode === 'selection' || mode === 'window'
  const type = ((await defaults('type')) || 'png').replace(/^jpeg$/, 'jpg')
  const args = []
  if (a.sound !== true) args.push('-x')
  if (interactive) args.push('-i', ...(mode === 'window' ? ['-W'] : ['-J', 'selection']))
  if ((await defaults('disable-shadow')) === '1') args.push('-o')
  if (a.cursor && !interactive) args.push('-C')
  if (delay > 0 && !interactive) args.push(`-T${delay}`)
  let files = [], dir = null
  if (to === 'clipboard') args.push('-c')
  else {
    args.push(`-t${type}`)
    dir = await saveDir()
    files = await names('image', type, interactive ? 1 : acc.displays || 1, new Date(Date.now() + (interactive ? 0 : delay * 1000)))
    args.push(...files)
  }
  const before = to === 'clipboard' ? await pbCount() : null // right before the spawn
  // cancelled while we were getting ready (no await between this check and the spawn)
  if (slot?.cancelled || (slot && st[slotName] !== slot)) { release(files); clear(); return { ok: true, cancelled: true, note: 'cancelled' } }
  const done = async r => finish(engine, mode, to, files, { ...r, cancelled: !!slot?.cancelled }, to === 'clipboard' ? { before, after: await pbCount() } : null, dir)
  if (!slot) return done(await sc(args)) // instant: wait for it (~0.3 s)
  // interactive / timed: never block the press; report when it finishes
  sc(args, { track: p => { slot.proc = p } }).then(r => { clear(); return done(r) })
  if (!interactive && delay > 0) countdown(engine, delay, slot)
  else engine.toast(mode === 'window' ? 'click a window · Esc cancels' : 'drag to select · space: window · Esc cancels', 2200)
  return { ok: true, note: 'started' }
}
function countdown(engine, secs, slot) {
  let n = secs
  const step = () => {
    if (st.timed !== slot || slot.cancelled) return // cancelled or finished: this countdown stops
    if (n > 0) { engine.toast(`📸 in ${n}…`, 1100); n--; setTimeout(step, 1000) }
  }
  step()
}

async function toggleRecord(engine, a) {
  if (st.rec) {
    if (st.rec.starting || st.rec.stopping) return { ok: true, note: st.rec.starting ? 'still starting' : 'still stopping' } // a quick double press
    return stopRecord(engine)
  }
  const rec = (st.rec = { starting: true }) // synchronous guard: a second press during the awaits below can't start another
  let file
  try {
    const acc = await access(engine)
    if (!acc.screen) { if (st.rec === rec) st.rec = null; return { ok: false, stderr: 'Screen Recording permission missing' } }
    ;[file] = await names('video', 'mov')
  } catch (e) { if (st.rec === rec) st.rec = null; throw e }
  if (st.rec !== rec) { release([file]); return { ok: true, note: 'cancelled' } }
  const max = Math.round(Math.max(1, Math.min(86400, Number(a.maxSeconds) || MAX_RECORD_S)))
  const args = ['-v', '-x'] // (not -V <secs>: with it screencapture dies on SIGINT without writing the movie)
  if (a.audio) args.push('-g')
  if (a.clicks) args.push('-k')
  if (a.cursor !== false) args.push('-C')
  args.push(file)
  const p = spawn(SC, args, { stdio: ['ignore', 'ignore', 'pipe'] })
  let err = ''
  p.stderr.on('data', d => { if (err.length < 4096) err += d })
  Object.assign(rec, { starting: false, proc: p, pid: p.pid, file, started: Date.now() })
  // cap: a detached watchdog stops (SIGINT = finalized) a recording nobody stopped after `max` s, even if
  // DeckStudio crashed meanwhile. It only signals the pid while that pid is still screencapture.
  try {
    rec.dog = spawn('/bin/sh', ['-c', `sleep ${max}; ps -p ${p.pid} -o comm= | grep -q screencapture && kill -INT ${p.pid}`], { stdio: 'ignore', detached: true })
    rec.dog.on('error', () => {}); rec.dog.unref()
  } catch {}
  try { fs.writeFileSync(STATE, JSON.stringify({ pid: p.pid, file, started: rec.started, owner: process.pid }), { mode: 0o600 }) } catch {}
  rec.tick = setInterval(() => engine.scheduleRender(), 1000) // per recording: cleared with it, never leaked
  p.on('error', e => { err = e.message })
  rec.done = new Promise(resolve => p.on('close', async (code, signal) => {
    clearInterval(rec.tick)
    killDog(rec)
    if (st.rec === rec) st.rec = null
    release([file])
    try { if (JSON.parse(fs.readFileSync(STATE, 'utf8')).pid === rec.pid) fs.unlinkSync(STATE) } catch {}
    engine.scheduleRender()
    if (exists(file)) {
      st.last = file
      engine.toast(`saved ${path.basename(file)}`, 2500)
      trace(engine, 'capture record (stopped)', true, { note: `${path.basename(file)} · ${fmtDur(Date.now() - rec.started)}` })
    } else {
      const msg = err.trim().split('\n')[0] || `screencapture exited ${code ?? signal}`
      await failed(engine, 'recording', msg, path.dirname(file))
      trace(engine, 'capture record (stopped)', false, { error: msg })
    }
    resolve()
  }))
  engine.toast('● recording · press again to stop', 2000)
  engine.scheduleRender()
  return { ok: true, note: 'recording' }
}
async function stopRecord(engine) {
  const rec = st.rec
  if (!rec?.proc) return { ok: true }
  rec.stopping = true
  engine.toast('stopping…', 1500)
  try { rec.proc.kill('SIGINT') } catch {} // SIGINT = screencapture's own "stop": the movie is finalized
  const t = setTimeout(() => { try { rec.proc.kill('SIGTERM') } catch {} }, 15000)
  await rec.done
  clearTimeout(t)
  return { ok: exists(rec.file), file: rec.file }
}

function killDog(rec) { if (rec.dog?.pid) { try { process.kill(-rec.dog.pid, 'SIGTERM') } catch {} ; rec.dog = null } } // its whole group: no stray `sleep`
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const comm = pid => new Promise(r => execFile('ps', ['-o', 'comm=', '-p', String(pid)], (e, out) => r(e ? '' : String(out).trim())))
/** A recording left behind by a crashed server: stop it so the movie is finalized. Called by the server once
 *  it is listening (never at import: a second server that is about to fail on the port must not touch the
 *  first one's recording), and only when the server that started it is gone. */
export async function reapOrphan(engine) {
  let s
  try { s = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { return { reaped: false } }
  if (st.rec?.pid === s.pid) return { reaped: false } // our own
  if (s.owner && s.owner !== process.pid && alive(s.owner) && /node/i.test(await comm(s.owner))) return { reaped: false, note: `owned by live server ${s.owner}` }
  let reaped = false
  if (s.pid && /screencapture$/.test(await comm(s.pid))) {
    try { process.kill(s.pid, 'SIGINT') } catch {}
    for (let t = 0; t < 150 && alive(s.pid); t++) await sleep(100) // up to 15 s for screencapture to finalize the movie
    if (alive(s.pid)) { try { process.kill(s.pid, 'SIGTERM') } catch {} }
    reaped = true
  }
  try { fs.unlinkSync(STATE) } catch {}
  if (s.file && exists(s.file)) {
    // wait until the file stops growing (the moov atom is written last)
    let size = -1
    for (let t = 0; t < 20; t++) { const n = fs.statSync(s.file).size; if (n === size) break; size = n; await sleep(250) }
    st.last = s.file
    engine?.toast?.(`recovered ${path.basename(s.file)}`, 2500)
    engine?.scheduleRender?.()
  }
  return { reaped, file: s.file }
}
process.on('exit', () => { // never leave a recording running after DeckStudio quits
  if (st.rec?.proc) { try { st.rec.proc.kill('SIGINT') } catch {} ; killDog(st.rec) }
  for (const s of [st.interactive, st.timed]) if (s?.proc) { try { s.proc.kill() } catch {} }
})

/** Entry point for { type: 'capture' } actions. */
export async function runCapture(a, { engine, vars = {} }) {
  const mode = a.mode || 'screen'
  switch (mode) {
    case 'screen': case 'selection': case 'window': {
      const interactive = mode !== 'screen'
      // an explicit `delay` wins; `delayDial` (1-4) reads that dial on the page the key was pressed on
      const explicit = a.delay != null && String(a.delay).trim() !== ''
      const viaDial = mode === 'screen' && !explicit && a.delayDial != null
      const timed = mode === 'screen' && (viaDial || /\{value\}/.test(String(a.delay ?? '')) || Number(a.delay) > 0)
      // pressing again while one is waiting (crosshair up, or the countdown running) cancels it
      const slotName = interactive ? 'interactive' : 'timed'
      const pend = interactive || timed ? st[slotName] : null
      if (pend) {
        pend.cancelled = true; st[slotName] = null
        if (pend.proc) { try { pend.proc.kill('SIGINT') } catch {} } // its finish() reports "capture cancelled"
        else engine.toast('capture cancelled', 1200) // still preparing: it will never start
        return { ok: true, note: 'cancelled' }
      }
      let delay = 0
      if (viaDial) {
        const n = Number(a.delayDial)
        if (!Number.isInteger(n) || n < 1 || n > 4) {
          engine.notify(`capture: delayDial must be 1-4 (got ${JSON.stringify(a.delayDial)})`, 'error'); engine.toast('capture: delayDial must be 1-4', 2500)
          return { ok: false, stderr: 'delayDial must be 1-4' }
        }
        const pg = typeof vars.page === 'string' && engine.hasPage?.(vars.page) ? vars.page : engine.page
        delay = Number(engine.dialValue(n - 1, pg))
      } else if (!interactive) delay = Number(String(a.delay ?? 0).replace(/\{value\}/g, vars.value ?? 0))
      delay = Math.max(0, Math.min(60, Math.round(Number.isFinite(delay) ? delay : 0)))
      // interactive / timed captures hold a slot from this moment (before any await): a second press cancels it
      const slot = interactive || delay > 0 ? (st[slotName] = { mode, proc: null, cancelled: false }) : null
      return shot(engine, a, delay, slot).catch(e => { if (slot && st[slotName] === slot) st[slotName] = null; throw e })
    }
    case 'record': return toggleRecord(engine, a)
    case 'toolbar': { // the system screenshot / recording toolbar (⌘⇧5)
      return new Promise(r => execFile('open', ['-b', 'com.apple.screenshot.launcher'], e => r(e ? { ok: false, stderr: e.message } : { ok: true })))
    }
    case 'folder': { const d = await saveDir(); return new Promise(r => execFile('open', [d], e => r({ ok: !e, stderr: e?.message }))) }
    case 'copy-last': case 'reveal-last': case 'open-last': {
      if (!st.last || !fs.existsSync(st.last)) { engine.toast('no capture yet', 1200); return { ok: true, note: 'nothing captured yet' } }
      if (mode === 'copy-last') {
        await new Promise(r => { const p = spawn('pbcopy', { env: { ...process.env, LC_CTYPE: 'UTF-8' } }); p.on('close', r); p.on('error', r); p.stdin.end(st.last) }) // UTF-8: names have U+202F
        engine.toast(`📋 path of ${path.basename(st.last)}`, 1800)
        return { ok: true }
      }
      return new Promise(r => execFile('open', mode === 'reveal-last' ? ['-R', st.last] : [st.last], e => r({ ok: !e, stderr: e?.message })))
    }
    case 'check': { // explicit: shows the state and (only here) lets macOS ask once
      st.access = null
      try {
        const acc = JSON.parse(await helper(['capture-access', 'request']))
        st.access = acc
        if (acc.screen) engine.toast(`Screen Recording ✓ (${acc.responsible?.name})`, 2500)
        else denied(engine)
        return { ok: true, note: `screen=${acc.screen} app=${acc.responsible?.name}` }
      } catch (e) { engine.toast(`check failed: ${e.message}`, 3000); return { ok: false, stderr: e.message } }
    }
    default: engine.notify(`capture: unknown mode ${mode}`, 'error'); return { ok: false, stderr: `unknown mode ${mode}` }
  }
}
