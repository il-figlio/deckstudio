import { fakeEngine, sleep } from './fake-engine.mjs'
const { runCapture } = await import(process.env.DS + '/src/capture.mjs')
const e = fakeEngine()
console.log(await runCapture({ type: 'capture', mode: 'record', maxSeconds: 2 }, { engine: e }))
await sleep(4500)
console.log('cap: toasts', e.toasts())
