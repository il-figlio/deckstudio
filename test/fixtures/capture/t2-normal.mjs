import { fakeEngine, sleep } from './fake-engine.mjs'
const { runCapture } = await import(process.env.DS + '/src/capture.mjs')
const e = fakeEngine()
console.log(await runCapture({ type: 'capture', mode: 'record', maxSeconds: 60 }, { engine: e }))
await sleep(3000)
console.log(await runCapture({ type: 'capture', mode: 'record' }, { engine: e }), e.toasts(), e.log.filter(x=>x[0]==='trace').map(x=>x[1]))
