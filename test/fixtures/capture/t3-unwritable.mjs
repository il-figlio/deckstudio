// #3 (real /usr/sbin/screencapture): an unwritable folder must be a failure, not "cancelled"
import { fakeEngine } from './fake-engine.mjs'
const { runCapture } = await import(process.env.DS + '/src/capture.mjs')
const e = fakeEngine()
const r = await runCapture({ type: 'capture', mode: 'screen' }, { engine: e })
console.log('result', r)
console.log('log', e.log.map(x => x[0] === 'trace' ? ['trace', x[1].ok, x[1].note || x[1].error] : x))
