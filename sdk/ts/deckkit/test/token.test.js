import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { controlToken, constantTimeEqual, tokenIn } from '../src/index.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'deckkit-'))

test('create / read / verify / rotate', () => {
  const t = controlToken({ file: path.join(tmp(), 'sub', 'control-token') })
  assert.equal(t.read(), null); assert.equal(t.verify('x'), false)
  const tok = t.ensure()
  assert.match(tok, /^[0-9a-f]{64}$/)
  assert.equal(t.ensure(), tok)
  assert.equal(fs.statSync(t.file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(t.file)).mode & 0o777, 0o700)
  assert.ok(t.verify(tok))
  assert.equal(t.verify(tok.slice(0, -1) + (tok.endsWith('0') ? '1' : '0')), false)
  assert.equal(t.verify(tok.toUpperCase()), false)
  assert.equal(t.verify(undefined), false)
  const r = t.rotate()
  assert.notEqual(r, tok); assert.equal(t.verify(tok), false)
})
test('a loose token file trusts nothing', () => {
  const t = controlToken({ file: path.join(tmp(), 'control-token') })
  const tok = t.ensure()
  fs.chmodSync(t.file, 0o644)
  assert.equal(t.read(), null); assert.equal(t.verify(tok), false)
})
test('a symlinked token file trusts nothing', () => {
  const d = tmp()
  const real = controlToken({ file: path.join(d, 'real') })
  const tok = real.ensure()
  fs.symlinkSync(real.file, path.join(d, 'link'))
  assert.equal(controlToken({ file: path.join(d, 'link') }).verify(tok), false)
})
test('url helpers', () => {
  const t = controlToken({ file: path.join(tmp(), 'control-token') })
  const url = t.appendToken('ticker://bump?by=2&token=forged')
  const u = new URL(url)
  assert.deepEqual(u.searchParams.getAll('token').length, 1)
  assert.equal(u.searchParams.get('by'), '2')
  assert.ok(t.verifyUrl(url))
  assert.equal(t.verifyUrl('ticker://bump'), false)
  assert.equal(t.verifyUrl(`ticker://bump?token=${'a'.repeat(64)}`), false)
  assert.equal(tokenIn('nope'), null)
  assert.ok(constantTimeEqual('abc', 'abc')); assert.equal(constantTimeEqual('abc', 'abd'), false); assert.equal(constantTimeEqual('ab', 'abc'), false)
})
