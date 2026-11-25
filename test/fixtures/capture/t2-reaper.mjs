// process B: what a second server does once listening
import { fakeEngine } from './fake-engine.mjs'
const { reapOrphan, captureVars } = await import(process.env.DS + '/src/capture.mjs')
const e = fakeEngine()
const r = await reapOrphan(e)
console.log('B', JSON.stringify(r), JSON.stringify(captureVars()), e.toasts())
