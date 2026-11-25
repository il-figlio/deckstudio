// Icons made on this Mac (app icons pulled at runtime, Icon Studio saves) live in ~/.deckstudio/logos, never in
// the git-tracked assets/logos; rendering finds both, this Mac's winning a name clash.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-logos-')))
process.env.DECKSTUDIO_HOME = HOME
const R = await import(path.join(ROOT, 'src/render-spec.mjs'))

test('logoFile: ~/.deckstudio/logos first, then the shipped assets/logos', () => {
  assert.equal(R.userLogoDir, path.join(HOME, 'logos'))
  assert.equal(R.logoFile('app-claude'), path.join(ROOT, 'assets/logos/app-claude.png'))
  assert.equal(R.logoFile('app-com-example-x'), null)
  fs.mkdirSync(path.join(HOME, 'logos'))
  fs.writeFileSync(path.join(HOME, 'logos/app-com-example-x.png'), 'x')
  fs.writeFileSync(path.join(HOME, 'logos/app-claude.png'), 'x')
  assert.equal(R.logoFile('app-com-example-x'), path.join(HOME, 'logos/app-com-example-x.png'))
  assert.equal(R.logoFile('app-claude'), path.join(HOME, 'logos/app-claude.png'))
  assert.equal(R.logoFile('../token'), null)
})

test('the server writes icons only to ~/.deckstudio/logos', () => {
  const src = fs.readFileSync(path.join(ROOT, 'server.mjs'), 'utf8')
  assert.doesNotMatch(src, /path\.join\(LOGO_DIR,\s*name/)
  assert.doesNotMatch(src, /mkdirSync\(LOGO_DIR/)
  assert.equal((src.match(/userLogo\(name \+ '\.png'\)/g) || []).length, 3) // recipe apply, from-app, Icon Studio save
})

test('.gitignore: a runtime app icon in assets/logos is ignored, every shipped one stays tracked', () => {
  let tracked
  try { tracked = execFileSync('git', ['ls-files', 'assets/logos'], { cwd: ROOT }).toString().split('\n').filter(Boolean) } catch { return } // not a git checkout
  for (const f of tracked) assert.throws(() => execFileSync('git', ['check-ignore', '-q', '--no-index', f], { cwd: ROOT }), undefined, `${f} would be ignored`)
  execFileSync('git', ['check-ignore', '-q', '--no-index', 'assets/logos/app-com-example-new.png'], { cwd: ROOT }) // throws if not ignored
})

const HELPER = path.join(ROOT, 'bin/deckhelper')
test('deckhelper icon: size must be 16–1024', { skip: (process.platform !== 'darwin' || !fs.existsSync(HELPER)) && 'needs macOS and bin/deckhelper (npm run build:helper)' }, () => {
  const out = path.join(HOME, 'icon.png')
  for (const bad of ['5000', '0', '15', 'abc', '1e9']) assert.throws(() => execFileSync(HELPER, ['icon', 'com.apple.finder', out, bad], { stdio: 'pipe' }), /16 to 1024/, bad)
  execFileSync(HELPER, ['icon', 'com.apple.finder', out, '32'])
  assert.equal(fs.readFileSync(out).readUInt32BE(16), 32) // PNG IHDR width
})
