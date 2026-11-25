import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createStatus, readStatus, heartbeatAt, statusCli, appDir, cleanState } from '../src/index.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deckkit-'))
const mode = p => fs.statSync(p).mode & 0o777
const sleep = ms => new Promise(r => setTimeout(r, ms))

test('writes the contract fields atomically, 0600 in a 0700 folder', () => {
  const dir = path.join(tmp(), 'Tool')
  const s = createStatus({ file: path.join(dir, 'deckstudio-status.json') })
  assert.ok(s.set('focus', { left: 1500, phase: 'focus' }))
  const doc = JSON.parse(fs.readFileSync(s.file, 'utf8'))
  assert.equal(doc.schema, 'status/v1')
  assert.equal(doc.state, 'focus')
  assert.equal(doc.running, true)
  assert.equal(doc.pid, process.pid)
  assert.deepEqual(doc.values, { left: 1500, phase: 'focus' })
  assert.match(doc.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
  assert.ok(Math.abs(heartbeatAt(doc) - Date.now()) < 5000)
  assert.equal(mode(s.file), 0o600)
  assert.equal(mode(dir), 0o700)
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [])
  s.stop()
})

test('update merges, null removes; since changes only with the state', () => {
  let t = 1_800_000_000_000
  const s = createStatus({ file: path.join(tmp(), 's.json'), now: () => new Date(t) })
  s.update({ a: 1, b: 'x' })
  assert.equal(s.snapshot().state, 'idle')
  const since = s.snapshot().since
  t += 5000
  s.update({ a: 2, b: null })
  assert.deepEqual(s.snapshot().values, { a: 2 })
  s.set('idle')
  assert.equal(s.snapshot().since, since)
  s.set('busy')
  assert.notEqual(s.snapshot().since, since)
  s.stop()
})

test('heartbeat rewrites; stop() writes running:false and stops it', async () => {
  const s = createStatus({ file: path.join(tmp(), 's.json'), heartbeatMs: 100, keepAlive: true })
  s.set('working')
  const a = JSON.parse(fs.readFileSync(s.file, 'utf8')).updated_at
  await sleep(350)
  const b = JSON.parse(fs.readFileSync(s.file, 'utf8')).updated_at
  assert.notEqual(a, b)
  s.stop()
  const stopped = JSON.parse(fs.readFileSync(s.file, 'utf8'))
  assert.equal(stopped.state, 'off'); assert.equal(stopped.running, false)
  await sleep(250)
  assert.equal(JSON.parse(fs.readFileSync(s.file, 'utf8')).updated_at, stopped.updated_at)
})

test('cleanState makes one word', () => {
  assert.equal(cleanState('two words\n'), 'two-words-')
  assert.equal(cleanState(''), 'idle')
  assert.equal(cleanState('x'.repeat(99)).length, 40)
})

test('appDir', () => {
  assert.match(appDir('Tool', { platform: 'darwin' }), /Library\/Application Support\/Tool$/)
  assert.equal(appDir('tool', { platform: 'linux', env: { XDG_STATE_HOME: '/x' } }), '/x/tool')
  assert.throws(() => appDir('../x'))
})

const now = 1_800_000_000_000
const write = doc => { const f = path.join(tmp(), 's.json'); fs.writeFileSync(f, JSON.stringify(doc)); return f }
const iso = ago => new Date(now - ago).toISOString()

test('reader: missing is off, not stale', () => {
  const r = readStatus({ file: '/nonexistent/x.json', now })
  assert.equal(r.state, 'off'); assert.equal(r.stale, false)
})
test('reader: fresh + alive', () => {
  const r = readStatus({ file: write({ state: 'focus', running: true, pid: 4242, updated_at: iso(10), values: { left: 3 } }), now, isAlive: () => true })
  assert.equal(r.state, 'focus'); assert.equal(r.stale, false); assert.equal(r.values.left, 3)
})
test('reader: dead pid → stale off', () => {
  const r = readStatus({ file: write({ state: 'focus', running: true, pid: 4242, updated_at: iso(1) }), now, isAlive: () => false })
  assert.equal(r.state, 'off'); assert.equal(r.staleReason, 'pid'); assert.equal(r.reportedState, 'focus')
  assert.equal(r.document.stale, true); assert.equal(r.document.state, 'off')
})
test('reader: heartbeat window is 95 s', () => {
  assert.equal(readStatus({ file: write({ state: 'x', pid: 4242, updated_at: iso(96_000) }), now, isAlive: () => true }).staleReason, 'heartbeat')
  assert.equal(readStatus({ file: write({ state: 'x', pid: 4242, updated_at: iso(94_000) }), now, isAlive: () => true }).stale, false)
})
test('reader: heartbeat formats (ISO, epoch s/ms, digit string; three field names)', () => {
  const t = now - 5000
  for (const hb of [t / 1000, t, String(Math.floor(t / 1000)), new Date(t).toISOString(), new Date(t).toISOString().replace(/\.\d+/, '')])
    for (const key of ['updated_at', 'updatedAt', 'heartbeat'])
      assert.equal(readStatus({ file: write({ state: 'busy', [key]: hb }), now }).stale, false, `${key}=${hb}`)
})
test('reader: stale flag; a cleanly stopped tool reads off (not stale)', () => {
  assert.equal(readStatus({ file: write({ state: 'busy', stale: true, updated_at: iso(0) }), now }).staleReason, 'flag')
  const r = readStatus({ file: write({ state: 'off', running: false, pid: 4242, updated_at: iso(500_000) }), now, isAlive: () => false })
  assert.equal(r.state, 'off'); assert.equal(r.stale, false)
})
test('reader: stop("done") (running: false) is never stale by age, like DeckStudio\'s _state stopped', () => {
  const r = readStatus({ file: write({ state: 'done', running: false, pid: 4242, updated_at: iso(500_000) }), now, isAlive: () => false })
  assert.equal(r.state, 'done'); assert.equal(r.stale, false); assert.equal(r.staleReason, null)
})
test('reader + writer round trip, fake dead pid', () => {
  const f = path.join(tmp(), 's.json')
  const s = createStatus({ file: f })
  s.set('focus')
  assert.equal(readStatus({ file: f }).state, 'focus')
  s.stop()
  assert.equal(readStatus({ file: f }).state, 'off')
  const dead = createStatus({ file: f, pid: 999_999 })
  dead.set('focus')
  assert.equal(readStatus({ file: f }).staleReason, 'pid')
  dead.stop()
})

test('statusCli: --line one word, --json one line, exit codes', () => {
  const f = path.join(tmp(), 's.json')
  const s = createStatus({ file: f })
  s.set('focus', { left: 7 })
  const run = (argv, file = f) => { let out = '', err = ''; const code = statusCli(argv, { file, stdout: x => { out += x }, stderr: x => { err += x } }); return { out, err, code } }
  assert.deepEqual(run(['status', '--line']), { out: 'focus\n', err: '', code: 0 })
  const j = run(['--json'])
  assert.equal(j.code, 0); assert.equal(j.out.trim().split('\n').length, 1); assert.equal(JSON.parse(j.out).values.left, 7)
  assert.ok(run([]).out.trim().split('\n').length > 1)
  assert.equal(run(['--nope']).code, 2)
  assert.deepEqual(run(['--line'], '/nonexistent'), { out: 'off\n', err: '', code: 0 })
  s.stop()
})
