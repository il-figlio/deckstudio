// #6 / #3 / #10 with a fake screencapture: which message each failure gets
import { fakeEngine } from './fake-engine.mjs'
const { runCapture } = await import(process.env.DS + '/src/capture.mjs')
for (const [fake, a] of [['err-window', { mode: 'screen' }], ['err-rect0', { mode: 'screen' }], ['perm-save', { mode: 'screen' }], ['err-save', { mode: 'screen' }], ['nofile', { mode: 'screen' }],
  ['nofile', { mode: 'screen', to: 'clipboard' }], ['err-rect0', { mode: 'screen', to: 'clipboard' }]]) {
  process.env.FAKE_SC = fake
  const e = fakeEngine()
  const r = await runCapture({ type: 'capture', ...a }, { engine: e })
  console.log(fake.padEnd(10), JSON.stringify(a).padEnd(38), 'ok=' + r.ok, '| toasts:', e.toasts().join(' / '), '| denied:', e.log.some(x => x[0] === 'notify' && /Screen Recording permission/.test(x[2])))
}
