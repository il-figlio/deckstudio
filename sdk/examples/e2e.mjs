// End-to-end: the SDK examples through DeckStudio's real PluginHost, in a scratch HOME + DECKSTUDIO_HOME.
// Run from anywhere: node sdk/examples/e2e.mjs   (builds the pomodoro example with swift first)
// Touches nothing real: HOME points at a temp folder, so the tools' status files and tokens land there too.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = process.env.DECKSTUDIO_ROOT || path.resolve(HERE, '../..')
const SCRATCH = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'deckkit-e2e-'))
const HOME = path.join(SCRATCH, 'home')
process.env.HOME = HOME                                  // before importing PluginHost: it reads os.homedir() at load
process.env.DECKSTUDIO_HOME = path.join(SCRATCH, 'deckstudio')
const PLUGINS = path.join(process.env.DECKSTUDIO_HOME, 'plugins')
for (const d of [path.join(HOME, '.local/bin'), PLUGINS, path.join(SCRATCH, 'no-builtins')]) fs.mkdirSync(d, { recursive: true })

const { PluginHost, runProcess } = await import(path.join(ROOT, 'src/plugins.mjs'))
const { validateManifest } = await import(path.join(ROOT, 'src/plugin-schema.mjs'))

let pass = 0, fail = 0
const ok = (c, name, extra = '') => { c ? pass++ : fail++; console.log(`${c ? 'PASS' : 'FAIL'}  ${name}${extra ? `  ${extra}` : ''}`) }
const sleep = ms => new Promise(r => setTimeout(r, ms))
const until = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(100) } return false }
const kids = []

// 1. manifests pass DeckStudio's validator
for (const id of ['pomodoro', 'ticker']) {
  const r = validateManifest(fs.readFileSync(path.join(HERE, id, 'deckstudio.json'), 'utf8'), { source: 'linked' })
  ok(r.ok && !r.warnings.length, `1 ${id}/deckstudio.json passes validateManifest`, [...r.errors, ...r.warnings].join(' | '))
}

// 2. install: build pomodoro onto the scratch PATH, link both example folders (what `deckctl plugin link` does)
execFileSync('swift', ['build', '-c', 'release'], { cwd: path.join(HERE, 'pomodoro'), stdio: 'ignore' })
fs.copyFileSync(path.join(HERE, 'pomodoro/.build/release/pomodoro'), path.join(HOME, '.local/bin/pomodoro'))
fs.chmodSync(path.join(HOME, '.local/bin/pomodoro'), 0o755)
for (const id of ['pomodoro', 'ticker']) fs.symlinkSync(path.join(HERE, id), path.join(PLUGINS, id))

const host = new PluginHost({
  dirs: { builtin: path.join(SCRATCH, 'no-builtins'), local: null, user: PLUGINS },
  cfg: () => ({ pomodoro: { enabled: true }, ticker: { enabled: true } }),   // the user switched both on
  bundles: async () => ({}),
})
host.start()
host.focus(['pomodoro', 'ticker'])                       // as if the current page shows both: full polling rate
const v = () => host.vars()
const info = id => host.summary().plugins.find(p => p.id === id)

ok(await until(() => info('pomodoro')?.installed && info('ticker')?.installed), '2 both plugins detected (linked, $bin found on PATH / $dir)',
  JSON.stringify(host.summary().plugins.map(p => [p.id, p.source, p.state, p.bin])))
ok(info('pomodoro')?.source === 'linked' && info('pomodoro')?.bin === path.join(HOME, '.local/bin/pomodoro'), '2 pomodoro is linked, $bin resolved')

// 3. pomodoro (file transport): before it ever ran there is no status file
ok(await until(() => v()['pomodoro._state'] === 'stopped' && !info('pomodoro')?.error), '3a never run: _state stopped (no status file is not an error), values at defaults',
  JSON.stringify({ st: v()['pomodoro._state'], err: info('pomodoro')?.error, state: v()['pomodoro.state'], time: v()['pomodoro.time'] }))
ok(v()['pomodoro.state'] === 'off' && v()['pomodoro.time'] === '--:--', '3a defaults: state off, time --:--')

// 3b. the deck key's action: start 0.2 min through PluginHost.run (argv, $bin, {minutes} param)
await host.run({ plugin: 'pomodoro', action: 'start', args: { minutes: '0.2' } })
ok(await until(() => v()['pomodoro.state'] === 'focus' && v()['pomodoro._state'] === 'ok'), '3b start → state focus, _state ok',
  JSON.stringify([v()['pomodoro._state'], v()['pomodoro.state'], v()['pomodoro.time']]))
ok(/^00:(1[0-2]|0\d)$/.test(v()['pomodoro.time']) && Number(v()['pomodoro.left']) > 0, '3b values from $.values: time mm:ss, left seconds', `${v()['pomodoro.time']} / ${v()['pomodoro.left']}`)
const statusFile = path.join(HOME, 'Library/Application Support/Pomodoro/deckstudio-status.json')
const doc = JSON.parse(fs.readFileSync(statusFile, 'utf8'))
ok(doc.schema === 'status/v1' && doc.running === true && Number.isInteger(doc.pid) && /Z$/.test(doc.updated_at), '3b status file: schema, running, pid, ISO updated_at', JSON.stringify(doc))
ok((fs.statSync(statusFile).mode & 0o777) === 0o600 && (fs.statSync(path.dirname(statusFile)).mode & 0o777) === 0o700, '3b status file 0600 in a 0700 folder')
const line = await runProcess(path.join(HOME, '.local/bin/pomodoro'), ['status', '--line'], { env: process.env })
ok(line.ok && line.stdout === 'focus\n', '3b `pomodoro status --line` → focus, exit 0', JSON.stringify(line))

// 3c. crash: kill -9 the timer → the pid is gone → stale at once (no 95 s wait), values show their stale text
const t0 = Date.now()
process.kill(doc.pid, 'SIGKILL')
ok(await until(() => v()['pomodoro._state'] === 'stale'), '3c kill -9 → _state stale (pid liveness)', `${Date.now() - t0} ms`)
ok(v()['pomodoro.state'] === 'off' && v()['pomodoro.time'] === '--:--' && v()['pomodoro.left'] === '0', '3c stale values: state off, time --:--, left 0',
  JSON.stringify([v()['pomodoro.state'], v()['pomodoro.time'], v()['pomodoro.left']]))
const line2 = await runProcess(path.join(HOME, '.local/bin/pomodoro'), ['status', '--line'], { env: process.env })
ok(line2.ok && line2.stdout === 'off\n', '3c `pomodoro status --line` → off after the crash, exit 0', JSON.stringify(line2))

// 3d. a run that finishes cleanly: stop(finalState: done) → running false, shown as done with _state stopped (never stale by age)
await host.run({ plugin: 'pomodoro', action: 'start', args: { minutes: '0.05' } })
ok(await until(() => v()['pomodoro.state'] === 'focus'), '3d second run starts')
ok(await until(() => v()['pomodoro.state'] === 'done' && v()['pomodoro._state'] === 'stopped', 10000), '3d finished: state done, running false, _state stopped (pid not checked)',
  JSON.stringify([v()['pomodoro._state'], v()['pomodoro.state']]))
ok(JSON.parse(fs.readFileSync(statusFile, 'utf8')).running === false, '3d final write has running:false')

// 3e. a clean stop stays stopped however old its heartbeat (a clean exit never reads as a crash)
const done = JSON.parse(fs.readFileSync(statusFile, 'utf8'))
fs.writeFileSync(statusFile + '.tmp', JSON.stringify({ ...done, updated_at: new Date(Date.now() - 3600e3).toISOString() })); fs.renameSync(statusFile + '.tmp', statusFile)
await sleep(1500)
ok(v()['pomodoro._state'] === 'stopped' && v()['pomodoro.state'] === 'done', '3e clean stop with a 1 h old heartbeat → still stopped / done', JSON.stringify([v()['pomodoro._state'], v()['pomodoro.state']]))
// 3e. heartbeat: a running status whose updated_at is older than status.stale (95 s) is stale even if the file is new and the pid lives
const old = { ...done, state: 'focus', running: true, pid: process.pid, updated_at: new Date(Date.now() - 120e3).toISOString() }
fs.writeFileSync(statusFile + '.tmp', JSON.stringify(old)); fs.renameSync(statusFile + '.tmp', statusFile)
ok(await until(() => v()['pomodoro._state'] === 'stale'), '3e running, updated_at 120 s old → stale (heartbeat)')
const fresh = { ...old, state: 'focus', running: true, pid: process.pid, updated_at: Date.now() / 1000 }   // epoch seconds also accepted
fs.writeFileSync(statusFile + '.tmp', JSON.stringify(fresh)); fs.renameSync(statusFile + '.tmp', statusFile)
ok(await until(() => v()['pomodoro._state'] === 'ok' && v()['pomodoro.state'] === 'focus'), '3e fresh heartbeat (epoch seconds) + live pid → ok again')

// 4. ticker (cmd transport: `ticker.mjs status --json` run by DeckStudio, the CLI applies the reader's staleness)
ok(await until(() => v()['ticker._state'] === 'stopped' && v()['ticker.state'] === 'off'), '4a not running: status --json says off / running false, exit 0 → _state stopped, state off',
  JSON.stringify([v()['ticker._state'], v()['ticker.state'], info('ticker')?.error]))
const serve = spawn(path.join(HERE, 'ticker/ticker.mjs'), ['serve'], { stdio: 'ignore', env: process.env })
kids.push(serve)
ok(await until(() => v()['ticker.state'] === 'ready' && v()['ticker.count'] === '0'), '4b serve → state ready, count 0', JSON.stringify([v()['ticker.state'], v()['ticker.count']]))
await host.run({ plugin: 'ticker', action: 'bump', args: { by: '2' } })
ok(await until(() => v()['ticker.count'] === '2'), '4c bump action (CLI carries the control token) → count 2', v()['ticker.count'])
const tdoc = JSON.parse(fs.readFileSync(path.join(HOME, 'Library/Application Support/Ticker/deckstudio-status.json'), 'utf8'))
const port = tdoc.values.port
const bare = await fetch(`http://127.0.0.1:${port}/bump`, { method: 'POST' })
const forged = await fetch(`http://127.0.0.1:${port}/bump`, { method: 'POST', headers: { 'x-ticker-token': 'a'.repeat(64) } })
ok(bare.status === 403 && forged.status === 403, '4d a request without / with a wrong token is refused (403)', `${bare.status} ${forged.status}`)
const tokFile = path.join(HOME, 'Library/Application Support/Ticker/control-token')
ok((fs.statSync(tokFile).mode & 0o777) === 0o600, '4d control token file is 0600')
serve.kill('SIGKILL')
ok(await until(() => v()['ticker._state'] === 'stale' && v()['ticker.state'] === 'off' && v()['ticker.count'] === '–'), '4e kill -9 → CLI reports stale:true → _state stale, stale values',
  JSON.stringify([v()['ticker._state'], v()['ticker.state'], v()['ticker.count']]))

host.stop()
for (const k of kids) try { k.kill('SIGKILL') } catch {}
try { const p = JSON.parse(fs.readFileSync(statusFile, 'utf8')).pid; if (p !== process.pid) process.kill(p, 'SIGKILL') } catch {}
if (!process.env.KEEP) fs.rmSync(SCRATCH, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed${process.env.KEEP ? `  (scratch kept: ${SCRATCH})` : ''}`)
process.exit(fail ? 1 : 0)
