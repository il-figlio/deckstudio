// #1: rapid double/triple press of record must start exactly one screencapture; stop finalizes; no leaked timers.
import fs from 'node:fs'
import { fakeEngine, sleep } from './fake-engine.mjs'
const { runCapture, captureVars } = await import(process.env.DS + '/src/capture.mjs')
const e = fakeEngine()
fs.writeFileSync(process.env.FAKE_LOG, '')
const rs = await Promise.all([runCapture({ type: 'capture', mode: 'record' }, { engine: e }), runCapture({ type: 'capture', mode: 'record' }, { engine: e }), runCapture({ type: 'capture', mode: 'record' }, { engine: e })])
console.log('presses:', rs.map(r => r.note))
await sleep(300)
const spawned = fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean)
console.log('spawned', spawned.length, spawned.map(l => l.replace(/\/.*\//, '…/')))
console.log('vars while recording', captureVars())
const state = JSON.parse(fs.readFileSync(process.env.DECKSTUDIO_HOME + '/recording.json', 'utf8'))
console.log('state owner==me', state.owner === process.pid)
// stop + a press while stopping
const [s1, s2] = await Promise.all([runCapture({ type: 'capture', mode: 'record' }, { engine: e }), runCapture({ type: 'capture', mode: 'record' }, { engine: e })])
console.log('stop:', s1.ok, 'second press while stopping:', s2.note)
await sleep(200)
console.log('vars after', captureVars(), 'state file gone', !fs.existsSync(process.env.DECKSTUDIO_HOME + '/recording.json'))
console.log('spawned total', fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').length)
console.log('toasts', e.toasts())
for (const f of fs.readdirSync(process.env.DECKSTUDIO_CAPTURE_DIR)) fs.unlinkSync(process.env.DECKSTUDIO_CAPTURE_DIR + '/' + f)
const t0 = Date.now(); process.on('exit', () => console.log('process exited on its own (no leaked interval) after', Date.now() - t0, 'ms'))
