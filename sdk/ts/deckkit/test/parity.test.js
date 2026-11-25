// validate() must agree with DeckStudio's validateManifest. Runs when DeckStudio is checked out next to the SDK
// (or DECKSTUDIO_ROOT points at it); skipped otherwise.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validate } from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = process.env.DECKSTUDIO_ROOT || path.resolve(here, '../../../..')
const schemaFile = path.join(root, 'src/plugin-schema.mjs')
const have = fs.existsSync(schemaFile)

const base = { deckstudio: 'plugin/v1', name: 'X', version: '1.0.0' }
const corpus = [
  { id: 'demo', detect: { bin: ['$dir/tool'] }, status: { cmd: ['$bin', 'status'], interval: 5 }, values: { pct: '$.a.b[0]' }, actions: { go: { cmd: ['$bin', 'go', '{value}'] } } },
  { id: 'x', deckstudio: 'plugin/v2' }, { id: 'Bad Id' }, { id: 'self' }, { id: '' }, { id: 'a'.repeat(33) },
  { id: 'x', status: { cmd: 'echo hi' } }, { id: 'x', status: { cmd: 'echo hi' }, permissions: { shell: true } },
  { id: 'x', status: { cmd: ['arch', '-arm64', '/bin/sh'] } }, { id: 'x', status: { cmd: ['/usr/bin/true'] } }, { id: 'x', detect: { bin: ['awk'] }, status: { cmd: ['$bin'] } }, { id: 'x', detect: { bin: ['tool'] }, status: { cmd: ['tool', 'go'] } },
  { id: 'x', templates: { keys: { k: { onPress: { type: 'shell', cmd: 'x' } }, j: { poll: { cmd: 'x' } }, m: { onPress: { type: 'multi', actions: [{ type: 'page', page: 'a' }, { type: 'keys', combo: 'a' }] } }, o: { onPress: { type: 'plugin', plugin: 'other', action: 'a' } }, ok: { onPress: { type: 'plugin', action: 'a' } } } } },
  { id: 'x', settings: { tok: { secret: true } } }, { id: 'x', settings: { tok: { secret: true, default: 'x' } } }, { id: 'x', settings: { n: { type: 'number', secret: true } } },
  { id: 'x', status: { cmd: ['/bin/sh', '-c', 'x'] } }, { id: 'x', status: { cmd: ['env', 'x'] } }, { id: 'x', status: { cmd: [] } }, { id: 'x', status: { cmd: ['bad arg0!'] } },
  { id: 'x', status: { http: 'http://example.com/s' } }, { id: 'x', status: { http: 'http://api.example.com/s' }, permissions: { network: ['api.example.com'] } },
  { id: 'x', status: { http: 'http://u:p@127.0.0.1/s' } }, { id: 'x', status: { http: 'ftp://127.0.0.1/' } }, { id: 'x', status: { http: 'http://127.0.0.1:4242/status' } },
  { id: 'x', status: { file: 'relative.json' } }, { id: 'x', status: { file: '~/../etc/passwd' } }, { id: 'x', status: { file: '~/x.json', bogus: 1 } },
  { id: 'x', status: { cmd: ['a'], http: 'http://127.0.0.1' } }, { id: 'x', status: {} }, { id: 'x', status: 'nope' },
  { id: 'x', builtin: 'capture' }, { id: 'x', status: { builtin: 'capture' } },
  { id: 'x', actions: { go: { cmd: ['$bin'] } } }, { id: 'x', detect: { bin: 'tool' }, actions: { go: { cmd: ['$bin'] } } },
  { id: 'x', status: { cmd: ['a'] }, values: { v: 'a.b' } }, { id: 'x', status: { cmd: ['a'] }, values: { v: '$..a' } }, { id: 'x', status: { cmd: ['a'] }, values: { _x: '$' } },
  { id: 'x', status: { cmd: ['a'] }, values: { v: 3 } }, { id: 'x', values: { v: '$' } }, { id: 'x', values: 'nope' },
  { id: 'x', status: { cmd: ['a'] }, values: { v: { path: '$.a', default: 'x', stale: 'off', round: 2, map: { true: 'on' } } } },
  { id: 'x', actions: { go: { url: 'myapp://x' } } }, { id: 'x', actions: { go: { url: 'myapp://x' } }, permissions: { schemes: ['myapp'] } },
  { id: 'x', actions: { go: { url: 'javascript:alert(1)' } } }, { id: 'x', actions: { go: { type: 'url', url: 'https://x.com/{value}' } } },
  { id: 'x', actions: { go: { type: 'app', target: '/Applications/X.app' } } }, { id: 'x', actions: { go: { type: 'app', target: 'bundle' } } },
  { id: 'x', detect: { bundle: 'com.x.y' }, actions: { go: { type: 'app', target: 'bundle' } } }, { id: 'x', actions: { go: { type: 'app', target: 'com.x.y' } } },
  { id: 'x', actions: { go: { http: 'http://127.0.0.1:1/x', method: 'POST', body: { v: '{value}' } } } }, { id: 'x', actions: { go: {} } }, { id: 'x', actions: { Go: { cmd: ['a'] } } },
  { id: 'x', actions: { go: { builtin: { type: 'capture' } } } }, { id: 'x', actions: 'nope' },
  { id: 'x', templates: { pages: { p: { name: 'P' } } } }, { id: 'x', templates: { pages: { p: { keys: [] } } } }, { id: 'x', templates: { keys: { Bad: {} } } },
  { id: 'x', templates: { keys: { k: { title: 'K', template: { label: '{self.v}' } } } } }, { id: 'x', templates: 'nope' }, { id: 'x', templates: { keys: 'nope' } },
  { id: 'x', icon: 'icon.png' }, { id: 'x', icon: 'icon.gif' }, { id: 'x', icon: { glyph: 'timer' } }, { id: 'x', icon: { logo: 'Bad Logo' } },
  { id: 'x', homepage: 'http://x' }, { id: 'x', version: '' }, { id: 'x', bogus: 1 }, { id: 'x', permissions: 'nope' },
  { id: 'x', detect: { bin: ['ok', '../bad', 'has space'] } },
  { id: 'x', bots: { cmd: ['$bin', 'bots'] }, detect: { bin: 'x' } }, { id: 'x', bots: { file: '~/b.json', interval: 3 } },
  // $bin: only a whole argv element counts
  { id: 'x', status: { cmd: 'echo $bin' }, permissions: { shell: true } }, { id: 'x', status: { cmd: 'echo $binary' }, permissions: { shell: true } },
  { id: 'x', detect: { bin: 'x' }, actions: { go: { cmd: ['$bin', '--self=$bin'] } } }, { id: 'x', bots: { cmd: ['$bin', 'bots'] } },
  { id: 'x', status: { cmd: ['$bin'], http: 'http://127.0.0.1' } },
  // value tests
  { id: 'x', status: { cmd: ['a'] }, values: { hot: { path: '$.p', atLeast: 80 }, band: { path: '$.p', above: 1, below: 9, then: 'y', else: 'n' }, eq: { path: '$.s', equals: 'busy' }, b: { path: '$.t', equals: true } } },
  { id: 'x', status: { cmd: ['a'] }, values: { v: { path: '$.a', above: '80' } } }, { id: 'x', status: { cmd: ['a'] }, values: { v: { path: '$.a', then: 'x' } } },
  { id: 'x', status: { cmd: ['a'] }, values: { v: { path: '$.a', equals: {} } } }, { id: 'x', status: { cmd: ['a'] }, values: { v: { path: '$..a', atLeast: 1 } } },
  // settings
  { id: 'x', settings: { cfg: { type: 'string', default: '~/c.json', title: 'Config' }, n: { type: 'number', default: 2 }, on: { type: 'boolean' } }, status: { cmd: ['a', '{settings.cfg}'] }, values: { t: "$['{settings.cfg}'].x" } },
  { id: 'x', status: { cmd: ['a', '{settings.cfg}'] } }, { id: 'x', templates: { keys: { k: { label: '{self.settings.zz}' } } } },
  { id: 'x', settings: { n: { type: 'number', default: 'x' } } }, { id: 'x', settings: { n: { type: 'date' } } }, { id: 'x', settings: { N: {} } },
  { id: 'x', settings: [] }, { id: 'x', settings: { a: 'x' } }, { id: 'settings' },
  { id: 'x', settings: { f: {} }, status: { file: '{settings.f}' } }, { id: 'x', status: { file: '{nope}/x.json' } }, { id: 'x', settings: { f: {} }, status: { file: '{settings.f}/../x' } },
  // action timeout / detach / |path
  { id: 'x', actions: { b: { cmd: ['/bin/echo'], timeout: 1200, detach: true }, c: { cmd: ['/bin/echo'], timeout: 99999 } } },
  { id: 'x', actions: { u: { url: 'https://x.com', detach: true } } }, { id: 'x', actions: { b: { cmd: ['/bin/echo'], detach: 'yes' } } },
  { id: 'x', actions: { r: { url: 'https://github.com/{repo|path}/pulls', params: ['repo'] } } },
]

test('validate() agrees with DeckStudio validateManifest', { skip: !have && 'DeckStudio not found' }, async () => {
  const { validateManifest } = await import(schemaFile)
  for (const raw of [...corpus.map(c => ({ ...base, ...c })), '{nope', [], 42]) {
    const want = validateManifest(raw, { source: 'user' })
    const got = validate(raw)
    assert.deepEqual({ ok: got.ok, errors: [...got.errors].sort(), warnings: [...got.warnings].sort() },
      { ok: want.ok, errors: [...want.errors].sort(), warnings: [...want.warnings].sort() }, JSON.stringify(raw))
  }
})

test('bundled schema copy matches docs/plugin.schema.json', { skip: !have && 'DeckStudio not found' }, () => {
  const a = fs.readFileSync(path.join(root, 'docs/plugin.schema.json'), 'utf8')
  const b = fs.readFileSync(path.join(here, '../schema/plugin.schema.json'), 'utf8')
  assert.equal(b, a, 'run npm run sync-schema')
})
