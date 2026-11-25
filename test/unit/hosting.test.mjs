// The public demo's hosting configs (editor/hosting: _headers, vercel.json, netlify.toml) send the same
// security headers, and the e2e static host (test/e2e/static.mjs) applies _headers the way the hosts do.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const H = path.join(ROOT, 'editor/hosting')
const { parseHeaders, headersFor } = await import(path.join(ROOT, 'test/e2e/static.mjs'))
const WANT = ['Content-Security-Policy', 'X-Frame-Options', 'Permissions-Policy', 'X-Content-Type-Options', 'Referrer-Policy']

test('_headers, vercel.json and netlify.toml agree on the security headers', () => {
  const fromHeaders = headersFor(parseHeaders(fs.readFileSync(path.join(H, '_headers'), 'utf8')), '/index.html')
  const v = JSON.parse(fs.readFileSync(path.join(H, 'vercel.json'), 'utf8'))
  const fromVercel = Object.fromEntries(v.headers.find(h => h.source === '/(.*)').headers.map(h => [h.key, h.value]))
  const toml = fs.readFileSync(path.join(H, 'netlify.toml'), 'utf8')
  const fromNetlify = Object.fromEntries([...toml.matchAll(/^\s+([A-Za-z-]+) = "(.*)"$/gm)].map(m => [m[1], m[2]]))
  for (const k of WANT) {
    assert.ok(fromHeaders[k], `_headers lacks ${k}`)
    assert.equal(fromVercel[k], fromHeaders[k], `vercel.json ${k}`)
    assert.equal(fromNetlify[k], fromHeaders[k], `netlify.toml ${k}`)
  }
  const csp = fromHeaders['Content-Security-Policy']
  for (const d of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "frame-ancestors 'none'", "connect-src 'self'"]) assert.ok(csp.includes(d), d)
  assert.doesNotMatch(csp, /'unsafe-eval'|script-src[^;]*'unsafe-inline'/)
  assert.equal(fromHeaders['X-Frame-Options'], 'DENY')
})

test('the e2e host merges every matching _headers block', () => {
  const rules = parseHeaders('/assets/*\n  Cache-Control: immutable\n/*.wasm\n  Content-Type: application/wasm\n/*\n  X-Frame-Options: DENY\n')
  assert.deepEqual(headersFor(rules, '/assets/a.js'), { 'Cache-Control': 'immutable', 'X-Frame-Options': 'DENY' })
  assert.deepEqual(headersFor(rules, '/x.wasm'), { 'Content-Type': 'application/wasm', 'X-Frame-Options': 'DENY' })
  assert.deepEqual(headersFor(rules, '/'), { 'X-Frame-Options': 'DENY' })
})
