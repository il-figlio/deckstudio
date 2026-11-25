// Capture (screenshots / screen recording) against a fake screencapture (test/fixtures/capture/fakesc.sh).
// Each scenario script prints what happened; this file asserts on it. macOS only (capture.mjs shells out to macOS tools).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') { console.log('skipped: capture tests need macOS'); process.exit(0) }
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const FX = path.join(ROOT, 'test/fixtures/capture')
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-capture-')))
const env = { ...process.env, DS: ROOT, HOME: W, DECKSTUDIO_HOME: path.join(W, 'home'), DECKSTUDIO_CAPTURE_DIR: path.join(W, 'out'), DECKSTUDIO_SCREENCAPTURE: path.join(FX, 'fakesc.sh'), FAKE_LOG: path.join(W, 'sc.log') }
const reset = () => { fs.rmSync(path.join(W, 'home'), { recursive: true, force: true }); fs.rmSync(path.join(W, 'out'), { recursive: true, force: true }); fs.mkdirSync(path.join(W, 'home')); fs.mkdirSync(path.join(W, 'out')); fs.writeFileSync(path.join(W, 'home/profile.json'), '{}'); fs.writeFileSync(env.FAKE_LOG, '') }
const run = (script, fake, timeout = 90000) => new Promise(res => {
  const p = spawn('node', [path.join(FX, script)], { env: { ...env, FAKE_SC: fake }, cwd: W })
  let out = ''; p.stdout.on('data', d => out += d); p.stderr.on('data', d => out += d)
  const t = setTimeout(() => p.kill('SIGKILL'), timeout); p.on('close', code => { clearTimeout(t); res({ out, code }) })
})
let pass = 0, fail = 0
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${!c && extra ? '\n' + extra : ''}`) }
const has = (r, re, name) => ok(re.test(r.out), name, r.out)

try {
  reset(); let r = await run('t1-record-race.mjs', 'rec')
  has(r, /presses: \[ 'recording', 'still starting', 'still starting' \]/, 'triple press starts one recording')
  has(r, /spawned 1 /, 'exactly one screencapture spawned'); has(r, /state owner==me true/, 'state file names this process as owner')
  has(r, /second press while stopping: still stopping/, 'press while stopping is ignored')
  has(r, /state file gone true/, 'state file removed after stop'); has(r, /spawned total 1/, 'no second spawn on stop'); has(r, /no leaked interval/, 'process exits on its own')

  reset(); r = await run('t2-normal.mjs', 'rec')
  has(r, /ok: true,\s+file: .*\.mov/, 'record then stop saves a movie'); has(r, /saved Screen Recording/, 'saved toast')

  reset(); r = await run('t2-cap.mjs', 'rec')
  has(r, /cap: toasts \[ '● recording/, 'maxSeconds recording starts')

  reset(); r = await run('t6-errors.mjs', '')
  for (const [fake, msg] of [['err-window', /capture failed: could not create image from window/], ['err-rect0', /capture failed: could not create image from rect/], ['perm-save', /can't save to out/], ['err-save', /can't save to out/], ['nofile', /no file was written/]])
    ok(r.out.split('\n').some(l => l.startsWith(fake.padEnd(10)) && l.includes('ok=false') && msg.test(l)), `error mapping: ${fake}`, r.out)
  // clipboard verification needs bin/deckhelper (pb-count); without it the result is "unknown", never "copied"
  if (fs.existsSync(path.join(ROOT, 'bin/deckhelper'))) has(r, /nofile .*clipboard.*nothing was copied/, 'clipboard: nothing copied')
  else has(r, /nofile .*clipboard.*capture done/, 'clipboard without helper: reported as done, not "copied"')

  reset(); r = await run('t3-unwritable.mjs', 'err-save')
  has(r, /ok: false/, 'unwritable folder is a failure, not "cancelled"'); has(r, /can't write to/, 'unwritable folder explained')

  reset(); r = await run('t5-slot-race.mjs', 'slow')
  has(r, /A timed double press: cancelled \/ cancelled \| spawned 0/, 'timed double press cancels, spawns nothing')
  has(r, /B cancel during countdown: cancelled .*spawned 1/, 'press during countdown cancels')
  has(r, /C restart after cancel: spawned 2 \| saved 1/, 'restart after cancel works')
  has(r, /D interactive double press: \[ 'cancelled', 'cancelled' \] \| spawned 0/, 'interactive double press cancels')
  has(r, /D2 interactive w\/ delay: toasts \[\s+'drag to select/, 'interactive capture shows the hint, not a countdown')

  reset(); r = await run('t789-engine.mjs', '')
  has(r, /#8\/#9 readonly: slow=true pressval=false ro-default=true none-onchange=true/, 'read-only dial inference')
  has(r, /#8 ro dial value after press \(want 42\): 42/, 'press does not reset a read-only dial')
  has(r, /#8 notices for dial 3 after 3 turns: 1 /, 'one notice per read-only dial')
  has(r, /#7 after load .*item c \(3\/4\)/, 'browse applies queued turns once after the list loads')
  has(r, /#7 still shown 1 s later: c/, 'browse stays visible')

  // two servers: the second must not reap a recording owned by a live one
  reset()
  const A = spawn('node', [path.join(FX, 't2-owner.mjs')], { env: { ...env, FAKE_SC: 'rec' }, cwd: W })
  await new Promise(res => { A.stdout.on('data', d => /^A /.test(String(d)) && res()); setTimeout(res, 8000) })
  r = await run('t2-reaper.mjs', 'rec')
  A.kill('SIGKILL')
  has(r, /reaped":false,"note":"owned by live server/, 'recording owned by a live server is not reaped')
} finally {
  try { execFileSync('pkill', ['-f', W]) } catch {}
  fs.rmSync(W, { recursive: true, force: true })
}
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0)
