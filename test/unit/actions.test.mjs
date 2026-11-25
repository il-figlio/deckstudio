// Action templating: shell and AppleScript never get a value spliced into their code (SECURITY findings 1, 3, 8).
// Runs real zsh / osascript (macOS) with hostile values and checks that the value comes back as text and nothing ran.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const A = await import(path.join(ROOT, 'src/actions.mjs'))
const W = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'deck-actions-')))
const PWN = path.join(W, 'pwned')
const pwned = () => { const hit = fs.existsSync(PWN); fs.rmSync(PWN, { force: true }); return hit }

// each tries to create PWN when spliced into a command
const PAYLOADS = [
  `$(touch ${PWN})`,
  `\`touch ${PWN}\``,
  `'; touch ${PWN}; '`,
  `"; touch ${PWN}; "`,
  `x\ntouch ${PWN}\n`,
  `'"$(touch ${PWN})"'`,
  `\\'; touch ${PWN} #`,
  `\${HOME} $HOME * ~ !!`,
]

const NO_ZSH = !fs.existsSync('/bin/zsh') && 'needs /bin/zsh (shell actions run zsh -lc)'
const NO_OSA = process.platform !== 'darwin' && 'needs macOS (osascript)'

const fakeEngine = () => { const notes = []; return { notes, notify: (m, k) => notes.push([k, m]), toast: m => notes.push(['toast', m]) } }
const shell = async (cmd, value) => A.runAction({ type: 'shell', cmd }, { engine: fakeEngine(), vars: { value } })

test('shell: {value} is an env reference in bare, "double", \'single\', $\'ansi\' and $( ) contexts', { skip: NO_ZSH }, async () => {
  const contexts = [
    ['bare', v => `printf %s {value}`, v => v],
    ['double', v => `printf %s "<{value}>"`, v => `<${v}>`],
    ['single', v => `printf %s '<{value}>'`, v => `<${v}>`],
    ['ansi', v => `printf %s $'<{value}>'`, v => `<${v}>`],
    ['subst', v => `printf %s "$(printf %s {value})"`, v => v],
    ['subst-dq', v => `printf %s "$(printf %s "[{value}]")"`, v => `[${v}]`],
  ]
  for (const p of PAYLOADS) for (const [name, mk, want] of contexts) {
    const r = await shell(mk(p), p)
    assert.equal(pwned(), false, `${name} context ran ${JSON.stringify(p)}`)
    assert.equal(r.ok, true, `${name}: ${r.stderr}`)
    // command substitution strips trailing newlines; everything else must round-trip exactly
    const expect = name === 'subst' ? want(p.replace(/\n+$/, '')) : want(p)
    assert.equal(r.stdout, expect.trim(), `${name} context mangled ${JSON.stringify(p)}`)
  }
})

test('shell: the command text never contains the value', () => {
  const t = A.shellTemplate(`echo {value} "{value}" '{value}' {other} {plugin.state} {repo|path}`, { value: 'SECRET$(x)', 'plugin.state': 'on', repo: 'a/b' })
  assert.equal(t.cmd.includes('SECRET'), false)
  assert.equal(t.cmd, `echo "\${DECK_V_0}" "\${DECK_V_1}" ''"\${DECK_V_2}"'' {other} "\${DECK_V_3}" "\${DECK_V_4}"`)
  assert.deepEqual(t.env, { DECK_V_0: 'SECRET$(x)', DECK_V_1: 'SECRET$(x)', DECK_V_2: 'SECRET$(x)', DECK_V_3: 'on', DECK_V_4: 'a/b' })
})

test('shell: comments and escaped quotes don\'t confuse the quoting state', { skip: NO_ZSH }, async () => {
  const p = `$(touch ${PWN})'`
  let r = await shell(`echo hi # it's a comment\nprintf %s {value}`, p)
  assert.equal(pwned(), false); assert.equal(r.stdout, `hi\n${p}`)
  r = await shell(`printf %s "a\\"b{value}"`, p)
  assert.equal(pwned(), false); assert.equal(r.stdout, `a"b${p}`)
  r = await shell(`printf %s it\\'s{value}`, p)
  assert.equal(pwned(), false); assert.equal(r.stdout, `it's${p}`)
})

test('shell: templates in backticks or ${…} are refused, not run', { skip: NO_ZSH }, async () => {
  assert.throws(() => A.shellTemplate('echo `echo {value}`', { value: 'x' }), /backticks/)
  assert.throws(() => A.shellTemplate('echo "`echo {value}`"', { value: 'x' }), /backticks/)
  assert.throws(() => A.shellTemplate('echo ${value}', { value: 'x' }), /shell parameter/)
  const e = fakeEngine()
  const r = await A.runAction({ type: 'shell', cmd: `echo \`echo {value}\`` }, { engine: e, vars: { value: `$(touch ${PWN})` } })
  assert.equal(r.ok, false); assert.equal(pwned(), false)
  assert.match(e.notes[0][1], /backticks/)
})

test('shell: $DECK_VALUE env and unknown {names} still work', { skip: NO_ZSH }, async () => {
  const r = await A.runAction({ type: 'shell', cmd: 'printf "%s|%s|{nope}" "$DECK_VALUE" "$DECK_DELTA"' }, { engine: fakeEngine(), vars: { value: 'a b', delta: -1 } })
  assert.equal(r.stdout, 'a b|-1|{nope}')
})

test('applescript: values arrive as argv, in code and inside "strings"', { skip: NO_OSA }, async () => {
  for (const p of [`" & (do shell script "touch ${PWN}") & "`, `x\\" & (do shell script "touch ${PWN}") & \\"`, `do shell script "touch ${PWN}"`, `a\nb`]) {
    let t = A.appleScriptTemplate('return "<{value}>"', { value: p })
    assert.equal(t.script.includes(p), false)
    let r = await A.osaArgs(t.script, t.args)
    assert.equal(pwned(), false); assert.equal(r.ok, true, r.stderr); assert.equal(r.stdout, `<${p}>`)
    t = A.appleScriptTemplate('return {value}', { value: p }) // bare: a string value, never code
    r = await A.osaArgs(t.script, t.args)
    assert.equal(pwned(), false); assert.equal(r.stdout, p)
  }
  const e = fakeEngine()
  const r = await A.runAction({ type: 'applescript', script: 'return "v=" & {value} -- {value} in a comment' }, { engine: e, vars: { value: `" & (do shell script "touch ${PWN}") & "` } })
  assert.equal(pwned(), false); assert.equal(r.stdout, `v=" & (do shell script "touch ${PWN}") & "`)
})

test('applescript: scripts without templates run unchanged; templated handler scripts are refused', { skip: NO_OSA }, async () => {
  assert.deepEqual(A.appleScriptTemplate('on foo()\nreturn 1\nend foo\nreturn foo()', {}), { script: 'on foo()\nreturn 1\nend foo\nreturn foo()', args: [] })
  assert.equal((await A.osaArgs('on foo()\nreturn 1\nend foo\nreturn foo()')).stdout, '1')
  assert.throws(() => A.appleScriptTemplate('on foo(x)\nreturn x\nend foo\nreturn foo({value})', { value: '1' }), /handlers/)
  // a template in a (* block comment *) or after -- stays as written
  assert.equal(A.appleScriptTemplate('(* {value} *) return {value} -- {value}', { value: 'x' }).script, 'on run argv\n(* {value} *) return (item 1 of argv) -- {value}\nend run')
})

test('type: templated values lose control characters (no synthesized Return / Tab / Esc)', () => {
  assert.equal(A.stripControl('a\nb\r\tc\x1b[0m\x7fd\x00'), 'abc[0md')
  assert.equal(A.stripControl('héllo 👋'), 'héllo 👋')
})
