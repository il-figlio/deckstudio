// #7 browse timing, #8 read-only inference, #9 shared predicate — on a real Engine (never started: no device)
import fs from 'node:fs'
import { sleep } from './fake-engine.mjs'
const DS = process.env.DS
const { Engine } = await import(DS + '/src/engine.mjs')
const rules = await import(DS + '/src/dial-rules.mjs')
const prof = process.env.DECKSTUDIO_HOME + '/profile.json'
const poll = { cmd: 'echo 5', interval: 60 }
fs.writeFileSync(prof, JSON.stringify({ startPage: 'p', pages: { p: { name: 'p', dials: [
  { mode: 'value', label: 'slow', poll, browse: { cmd: `sleep 6; printf 'a\\t1\\nb\\t2\\nc\\t3\\nd\\t4\\n'` } },
  { mode: 'value', label: 'pressval', poll, default: 3, onPress: { type: 'shell', cmd: 'echo $DECK_VALUE' } },
  { mode: 'value', label: 'ro-default', poll, default: 3 },
  { mode: 'value', label: 'none-onchange', poll, onChange: { type: 'none' } },
] } } }))
const e = new Engine({ profilePath: prof })
const notes = []; e.notify = (m, l) => notes.push(m); e.scheduleRender = () => {}; e.trace = () => {}
e.act = async () => {}

// #9 / #8 predicate
const d = e.pageView().dials
console.log('#8/#9 readonly:', d.map(x => `${x.label}=${rules.dialReadonly(x)}`).join(' '),
  '| {value} in onTouch:', rules.dialReadonly({ poll, onTouch: { type: 'open', target: 'x://{value}' } }),
  '| _rotate dial info:', (() => { const v = { ...d[0], _rotate: () => {} }; return typeof v._rotate !== 'function' && rules.dialReadonly(v) })())

// #8 press on a read-only dial with `default` doesn't reset it; one notice per dial on turns
e.setDialValue(2, 42); e.dialDown(2); console.log('#8 ro dial value after press (want 42):', e.dialValue(2))
await e.dialRotate(2, 1); await e.dialRotate(2, 1); await e.dialRotate(2, -1)
console.log('#8 notices for dial 3 after 3 turns:', notes.filter(n => n.startsWith('dial 3')).length, '|', notes.find(n => n.startsWith('dial 3')))

// #7: 3 turns while the (6 s, slower than the 5 s hold) list loads -> applied once, and shown
const t0 = Date.now()
const p1 = e.dialRotate(0, 1); await sleep(100); e.dialRotate(0, 1); await sleep(100); e.dialRotate(0, 1)
await p1
const v = e.browseView()
console.log(`#7 after load (${Date.now() - t0} ms): item`, v[0]?.name, `(${v[0]?.pos}/${v[0]?.n}) want c (3/4); visible until +${e.browse.p[0].until - Date.now()} ms`)
await sleep(1000); console.log('#7 still shown 1 s later:', e.browseView()[0]?.name)
clearTimeout(e.browse.p[0].timer); process.exit(0)
