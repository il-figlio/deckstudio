// #5: second press during the awaits before spawn cancels (nothing spawned); press during the countdown kills it and
// the countdown stops; interactive with a leftover delay shows the hint, not a countdown.
import fs from 'node:fs'
import { fakeEngine, sleep } from './fake-engine.mjs'
const { runCapture } = await import(process.env.DS + '/src/capture.mjs')
const log = () => fs.readFileSync(process.env.FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean)
fs.writeFileSync(process.env.FAKE_LOG, '')
const run = (a, e, vars = {}) => runCapture({ type: 'capture', ...a }, { engine: e, vars })

// A: timed, two presses in the same tick (the 2nd lands while the 1st is still awaiting access/defaults)
let e = fakeEngine()
const [a1, a2] = await Promise.all([run({ mode: 'screen', delay: 3 }, e), run({ mode: 'screen', delay: 3 }, e)])
await sleep(1500)
console.log('A timed double press:', a1.note, '/', a2.note, '| spawned', log().length, '| countdown toasts', e.toasts().filter(t => t.includes('📸')).length, '| toasts', e.toasts())

// B: timed, press again during the countdown: process killed, countdown stops, reported as cancelled
e = fakeEngine(); fs.writeFileSync(process.env.FAKE_LOG, '')
await run({ mode: 'screen', delay: 3 }, e)
await sleep(1200)
const before = e.toasts().filter(t => t.includes('📸')).length
const b2 = await run({ mode: 'screen', delay: 3 }, e)
await sleep(2500)
console.log('B cancel during countdown:', b2.note, '| countdown toasts before/after cancel', before, e.toasts().filter(t => t.includes('📸')).length, '| spawned', log().length, '| traces', e.log.filter(x => x[0] === 'trace').map(x => x[1].note || x[1].error))

// C: a fresh timed press right after a cancel gets its own countdown (old token's loop doesn't eat it)
e = fakeEngine(); fs.writeFileSync(process.env.FAKE_LOG, '')
await run({ mode: 'screen', delay: 2 }, e); await sleep(300); await run({ mode: 'screen', delay: 2 }, e); await sleep(100)
await run({ mode: 'screen', delay: 2 }, e)
await sleep(4000)
console.log('C restart after cancel: spawned', log().length, '| saved', e.toasts().filter(t => t.startsWith('saved')).length, '| countdown toasts', e.toasts().filter(t => t.includes('📸')))

// D: interactive with a leftover delay: hint, no countdown; same-tick double press: nothing spawned
e = fakeEngine(); fs.writeFileSync(process.env.FAKE_LOG, '')
const d = await Promise.all([run({ mode: 'selection', delay: 5 }, e), run({ mode: 'selection', delay: 5 }, e)])
await sleep(600)
console.log('D interactive double press:', d.map(r => r.note), '| spawned', log().length, '| toasts', e.toasts())
e = fakeEngine()
await run({ mode: 'selection', delay: 5 }, e); await sleep(2600)
console.log('D2 interactive w/ delay: toasts', e.toasts(), '| args', log().slice(-1)[0]?.replace(/\/\S*\//g, '…/'))
for (const f of fs.readdirSync(process.env.DECKSTUDIO_CAPTURE_DIR)) fs.unlinkSync(process.env.DECKSTUDIO_CAPTURE_DIR + '/' + f)
