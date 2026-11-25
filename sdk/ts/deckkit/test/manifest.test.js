import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { manifest, validate, jsonPath } from '../src/index.js'

const sample = () => manifest('ticker', { name: 'Ticker', version: '1.0.0' })
  .description('A counter')
  .icon({ glyph: 'add' })
  .detect({ bin: ['$dir/ticker'] })
  .statusCmd(['$bin', 'status', '--json'], { interval: 2 })
  .value('state', { path: '$.state', stale: 'off' })
  .value('count', '$.values.count')
  .cmd('bump', ['$bin', 'bump', '{by}'], { title: 'Bump', params: ['by'] })
  .key('count', { label: '{self.count}', onPress: { type: 'plugin', action: 'bump', args: { by: '1' } } }, { title: 'Ticker count' })

test('builder builds a valid manifest and writes it', () => {
  const b = sample()
  const m = b.build()
  assert.equal(m.deckstudio, 'plugin/v1')
  assert.deepEqual(m.templates.keys.count.title, 'Ticker count')
  assert.deepEqual(b.validate(), { ok: true, errors: [], warnings: [] })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deckkit-'))
  const file = b.write(dir)
  assert.equal(path.basename(file), 'deckstudio.json')
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), m)
  assert.equal(JSON.stringify(b), JSON.stringify(m))
})
test('statusFile defaults stale to 95 s', () => {
  assert.equal(manifest('x').statusFile('~/x.json').build().status.stale, 95)
})
test('write refuses an invalid manifest', () => {
  assert.throws(() => manifest('Bad Id').write(os.tmpdir()), /id:/)
})
test('validate catches common mistakes', () => {
  const r = validate({ deckstudio: 'plugin/v1', id: 'x', name: 'X', version: '1', values: { Up: '$', ok: '$' }, actions: { sh: { cmd: ['/bin/zsh', '-c', 'x'] }, go: { cmd: ['$bin'] }, link: { url: 'myapp://x' } } })
  const all = r.errors.join('\n')
  for (const re of [/values\.Up/, /shell in disguise/, /\$bin" needs detect\.bin/, /myapp: links need/, /values need a status source/]) assert.match(all, re)
  assert.equal(validate('{nope').ok, false)
  assert.match(validate({ deckstudio: 'plugin/v1', id: 'x', name: 'X', bogus: 1 }).warnings.join(), /bogus/)
})
test('jsonPath', () => {
  const d = { values: { n: [1, 2, 3] }, 'odd key': 'y' }
  assert.equal(jsonPath(d, '$.values.n[-1]'), 3)
  assert.equal(jsonPath(d, '$.values.n.length'), 3)
  assert.equal(jsonPath(d, "$['odd key']"), 'y')
  assert.throws(() => jsonPath(d, '$..n'))
})

test('builder: settings, value tests, detached actions validate', () => {
  const b = manifest('polt', { name: 'Polt', version: '1.0.0' })
    .detect({ bin: ['polt'] })
    .setting('config', { title: 'Config file', default: '~/app/polt.json' })
    .setting('target', { default: 'app' })
    .statusCmd(['$bin', 'status', '--config', '{settings.config}'])
    .value('hot', { path: '$.pct', atLeast: 80 })
    .value('build', { path: "$['{settings.target}'].status", equals: 'failed', then: 'bad' })
    .cmd('build', ['$bin', 'build', '{settings.target}'], { detach: true, timeout: 1200, toast: true })
    .key('t', { label: '{self.settings.target}', led: '{self.build}' })
  assert.deepEqual(b.validate(), { ok: true, errors: [], warnings: [] })
  assert.equal(b.build().settings.config.default, '~/app/polt.json')
  const bad = validate({ ...b.build(), values: { x: { path: '$.a', then: 'on' } }, actions: { u: { url: 'https://x.com', detach: true } }, templates: { keys: { k: { label: '{self.settings.nope}' } } } })
  assert.ok(bad.errors.some(e => /then \/ else need a test/.test(e)) && bad.errors.some(e => /detach/.test(e)) && bad.errors.some(e => /"nope" isn't declared/.test(e)), bad.errors.join(' | '))
})
