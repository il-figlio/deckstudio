// process A: a "server" that starts a real recording and stays alive
import { fakeEngine } from './fake-engine.mjs'
const { runCapture } = await import(process.env.DS + '/src/capture.mjs')
const r = await runCapture({ type: 'capture', mode: 'record', maxSeconds: 60 }, { engine: fakeEngine() })
console.log('A', JSON.stringify(r)); setInterval(() => {}, 1e6)
