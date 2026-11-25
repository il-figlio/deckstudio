// Action executors. Every control (key press, long press, dial turn/press, strip tap/swipe)
// maps to one of these action objects: { type, ...params }.
import { execFile, spawn } from 'node:child_process'
import { runCapture } from './capture.mjs'
import { VAR_RE } from './plugin-schema.mjs'

export const ACTION_TYPES = {
  none: [],
  page: ['page'],            // go to page id
  back: [],                  // previous page
  shell: ['cmd'],            // zsh -lc cmd ; {value} {delta} → "${DECK_V_n}" env refs (shellTemplate), never spliced
  open: ['target'],          // URL, file, or app name
  keys: ['combo'],           // e.g. "cmd+shift+4"  (needs Accessibility permission)
  type: ['text'],            // types text        (needs Accessibility permission)
  applescript: ['script'],
  shortcut: ['name', 'input'], // macOS Shortcuts app
  http: ['url', 'method', 'body'],
  media: ['command'],        // playpause | next | previous | mute
  volume: ['step'],          // relative system volume change (dial-friendly)
  brightness: ['step'],      // deck brightness change
  multi: ['actions'],        // run a list of actions in order
  app: ['target'],           // launch / bring forward an app (bundle id like com.superlogical.rex, or a name)
  'hold-keys': ['combo'],    // hold a combo while the key is held: push-to-talk (e.g. Hex dictation)
  'agents-next': [],         // jump Rex to the agent that most needs you
  'mic-mute': ['mode'],      // toggle | on | off
  'audio-input': ['device'], // switch the default microphone (name or uid)
  'audio-output': ['device'],// switch the default output (name or uid)
  plugin: ['plugin', 'action', 'args'], // a plugin's declared action (src/plugins.mjs), e.g. { plugin: 'capture', action: 'screen' }
  capture: ['mode', 'to', 'delay', 'delayDial', 'cursor', 'sound', 'audio', 'clicks', 'maxSeconds'], // screenshots / screen recording via screencapture (src/capture.mjs)
}

const asq = s => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')

export function run(cmd, args, { timeout = 15000, input } = {}) {
  return new Promise(resolve => {
    const p = execFile(cmd, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) =>
      resolve({ ok: !err, stdout: String(stdout).trim(), stderr: String(stderr).trim(), err }))
    if (input != null) { p.stdin.end(input) }
  })
}
export const osa = script => run('osascript', ['-e', script])
export const sh = (cmd, env = {}) => new Promise(resolve => {
  const p = spawn('/bin/zsh', ['-lc', cmd], { env: { ...process.env, ...env }, timeout: 30000 })
  let out = '', errOut = ''
  p.stdout.on('data', d => { if (out.length < 65536) out += d })
  p.stderr.on('data', d => { if (errOut.length < 65536) errOut += d })
  p.on('close', code => resolve({ ok: code === 0, stdout: out.trim(), stderr: errOut.trim() }))
  p.on('error', e => resolve({ ok: false, stdout: '', stderr: e.message }))
})

const KEYCODES = { return: 36, enter: 76, tab: 48, space: 49, delete: 51, escape: 53, esc: 53, left: 123, right: 124, down: 125, up: 126,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100, f9: 101, f10: 109, f11: 103, f12: 111, home: 115, end: 119, pageup: 116, pagedown: 121 }
const MODS = { cmd: 'command down', command: 'command down', shift: 'shift down', alt: 'option down', opt: 'option down', option: 'option down', ctrl: 'control down', control: 'control down' }

export function comboToAppleScript(combo) {
  const parts = String(combo).toLowerCase().split('+').map(s => s.trim()).filter(Boolean)
  const key = parts.pop()
  const mods = parts.map(m => MODS[m]).filter(Boolean)
  const using = mods.length ? ` using {${mods.join(', ')}}` : ''
  const stroke = KEYCODES[key] != null ? `key code ${KEYCODES[key]}` : `keystroke "${asq(key)}"`
  return `tell application "System Events" to ${stroke}${using}`
}

export async function getVolume() {
  const r = await osa('output volume of (get volume settings)')
  const v = parseInt(r.stdout, 10)
  return isNaN(v) ? null : v
}
export async function setVolume(v) {
  v = Math.max(0, Math.min(100, Math.round(v)))
  await osa(`set volume output volume ${v}`)
  return v
}

// Plain template substitution: only for slots that are data, never code (a page id, a Shortcuts name,
// a device name). Shell and AppleScript never get values spliced into their text: see shellTemplate /
// appleScriptTemplate below.
const tpl = (s, vars, esc = v => v) => String(s ?? '').replace(VAR_RE, (m, k) => (vars[k] != null ? esc(String(vars[k])) : m))
const isSafeUrl = u => /^(https?|mailto):/i.test(u)
// C0 controls + DEL: a templated value typed as keystrokes can't press Return / Tab / Esc
export const stripControl = v => String(v).replace(/[\x00-\x1f\x7f]/g, '')
const tplErr = msg => Object.assign(new Error(msg), { code: 'TEMPLATE' })

/**
 * Shell templating without splicing: every {name} (also {plugin.value}, {name|path}) that has a value
 * becomes a reference to an env var, DECK_V_<n>, and the value travels only in the env. zsh expands a
 * parameter once and never re-parses the result, so a value like `$(rm -rf ~)`, a backtick, a quote or a
 * newline stays text. The reference is written for where the template sits:
 *   bare        echo {value}      → echo "${DECK_V_0}"
 *   "double"    echo "v={value}"  → echo "v=${DECK_V_0}"
 *   'single'    echo 'v={value}'  → echo 'v='"${DECK_V_0}"''   (closes and reopens the quote)
 *   $'ansi'     echo $'{value}'   → echo $''"${DECK_V_0}"$''
 * Templates inside `backticks` and `${…}` (e.g. "${value}") are refused (use $(…) / {value} or $DECK_VALUE).
 * A misjudged context can only make the output wrong (a literal "${DECK_V_0}"), never run the value.
 * @returns {{ cmd: string, env: Record<string, string> }}
 */
export function shellTemplate(cmd, vars) {
  const s = String(cmd ?? ''), env = {}, re = new RegExp(VAR_RE.source, 'y')
  const stack = [{ t: 'u', depth: 0 }]
  let out = '', i = 0, n = 0
  const top = () => stack[stack.length - 1]
  const wordStart = () => i === 0 || /[\s;&|()]/.test(s[i - 1])
  while (i < s.length) {
    const c = s[i], cx = top()
    if (c === '{') {
      re.lastIndex = i
      const m = re.exec(s)
      if (m && vars[m[1]] != null) {
        if (s[i - 1] === '$' && cx.t !== 's' && cx.t !== 'a') throw tplErr(`shell: "\${${m[1]}}" is a shell parameter, not a template: write {${m[1]}} or "$DECK_${m[1].toUpperCase().replace(/[^A-Z0-9]+/g, '_')}"`)
        if (stack.some(x => x.t === 'b')) throw tplErr(`shell: {${m[1]}} inside \`backticks\` isn't supported: use $(…)`)
        const name = `DECK_V_${n++}`
        env[name] = String(vars[m[1]])
        out += cx.t === 'd' ? `\${${name}}` : cx.t === 's' ? `'"\${${name}}"'` : cx.t === 'a' ? `'"\${${name}}"$'` : `"\${${name}}"`
        i += m[0].length
        continue
      }
    }
    if (cx.t === 's') { if (c === "'") stack.pop(); out += c; i++; continue }
    if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue }
    if (cx.t === 'a') { if (c === "'") stack.pop(); out += c; i++; continue }
    if (cx.t === 'b') { if (c === '`') stack.pop(); out += c; i++; continue }
    if (c === '$' && s[i + 1] === '(') { stack.push({ t: 'p', depth: 0 }); out += '$('; i += 2; continue }
    if (c === '`') { stack.push({ t: 'b' }); out += c; i++; continue }
    if (cx.t === 'd') { if (c === '"') stack.pop(); out += c; i++; continue }
    // unquoted (top level, or inside $( … ))
    if (c === '"') stack.push({ t: 'd' })
    else if (c === "'") stack.push({ t: s[i - 1] === '$' ? 'a' : 's' })
    else if (c === '(' && cx.t === 'p') cx.depth++
    else if (c === ')' && cx.t === 'p') { if (cx.depth) cx.depth--; else stack.pop() }
    else if (c === '#' && wordStart()) { const e = s.indexOf('\n', i); const end = e < 0 ? s.length : e; out += s.slice(i, end); i = end; continue }
    out += c; i++
  }
  return { cmd: out, env }
}

/**
 * AppleScript templating without splicing: values go to osascript as arguments and the script reads them as
 * (item N of argv) inside an `on run argv` wrapper. Inside a "string" a template becomes
 * `" & (item N of argv) & "`; in a comment it stays as written. A templated script can't declare handlers,
 * script objects or properties (they can't live inside the run handler): that's refused, not guessed.
 * @returns {{ script: string, args: string[] }}
 */
export function appleScriptTemplate(script, vars) {
  const s = String(script ?? ''), args = [], re = new RegExp(VAR_RE.source, 'y')
  let out = '', i = 0, mode = 'code', depth = 0
  while (i < s.length) {
    const c = s[i]
    if (mode === 'code' || mode === 'str') {
      if (c === '{') {
        re.lastIndex = i
        const m = re.exec(s)
        if (m && vars[m[1]] != null) {
          args.push(String(vars[m[1]]))
          const ref = `(item ${args.length} of argv)`
          out += mode === 'str' ? `" & ${ref} & "` : ref
          i += m[0].length
          continue
        }
      }
    }
    if (mode === 'str') { if (c === '\\') { out += s.slice(i, i + 2); i += 2; continue } if (c === '"') mode = 'code'; out += c; i++; continue }
    if (mode === 'line') { if (c === '\n' || c === '\r') mode = 'code'; out += c; i++; continue }
    if (mode === 'block') {
      if (c === '(' && s[i + 1] === '*') { depth++; out += '(*'; i += 2; continue }
      if (c === '*' && s[i + 1] === ')') { if (--depth === 0) mode = 'code'; out += '*)'; i += 2; continue }
      out += c; i++; continue
    }
    if (mode === 'pipe' || mode === 'chev') { if ((mode === 'pipe' && c === '|') || (mode === 'chev' && c === '»')) mode = 'code'; out += c; i++; continue }
    // code
    if (c === '"') mode = 'str'
    else if (c === '-' && s[i + 1] === '-') mode = 'line'
    else if (c === '#') mode = 'line'
    else if (c === '(' && s[i + 1] === '*') { mode = 'block'; depth = 1; out += '(*'; i += 2; continue }
    else if (c === '|') mode = 'pipe'
    else if (c === '«') mode = 'chev'
    out += c; i++
  }
  if (!args.length) return { script: s, args }
  if (/^\s*(on|to|script|property)\b/im.test(s)) throw tplErr('applescript: a templated script can\'t define handlers, script objects or properties (it runs inside "on run argv"): read the value with $DECK_VALUE from a shell action, or drop the template')
  return { script: `on run argv\n${out}\nend run`, args }
}
export const osaArgs = (script, args = []) => run('osascript', ['-e', script, ...(args.length ? ['--', ...args] : [])])

/**
 * @param action  action object
 * @param ctx     { engine, vars: {value, delta, page, ...} }
 */
export async function runAction(action, ctx) {
  if (!action || !action.type || action.type === 'none') return
  const vars = ctx.vars || {}
  const { engine } = ctx
  switch (action.type) {
    case 'page': return engine.goto(tpl(action.page, vars))
    case 'back': return engine.back()
    case 'shell': {
      // vars arrive only through the env: $DECK_VALUE etc., and each {template} becomes a "${DECK_V_<n>}"
      // reference (shellTemplate), so no value is ever part of the command text
      const env = Object.fromEntries(Object.entries(vars).map(([k, v]) => [`DECK_${k.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, String(v ?? '')]))
      let t
      try { t = shellTemplate(action.cmd, vars) } catch (e) { engine.notify(e.message, 'error'); return { ok: false, stdout: '', stderr: e.message } }
      const r = await sh(t.cmd, { ...env, ...t.env })
      if (!r.ok) engine.notify(`shell failed: ${r.stderr.split('\n')[0] || 'exit≠0'}`, 'error')
      else if (action.toast && r.stdout) engine.toast(r.stdout.split('\n')[0])
      return r
    }
    case 'open': {
      // any var the template filler knows ({value}, {tool.link}, {id.settings.x}, {x|path}): VAR_RE, not just \{\w+\}
      const templated = new RegExp(VAR_RE.source).test(action.target || '')
      const t = tpl(action.target, vars, templated ? encodeURIComponent : undefined)
      if (templated && !(/^https?:\/\//i.test(String(action.target)) && /^https?:\/\//i.test(t))) { engine.notify('open: templated targets must be http(s) URLs', 'error'); return }
      const isPathOrUrl = /^([a-z][a-z0-9+.-]*:|\/|~(?=\/|$))/i.test(t)
      return run('open', isPathOrUrl ? [t.replace(/^~(?=\/|$)/, process.env.HOME)] : ['-a', t])
    }
    case 'keys': { const r = await osa(comboToAppleScript(action.combo)); if (!r.ok) engine.notify(accessHint(r), 'error'); return r }
    case 'type': {
      // the text goes to osascript as an argument (never into the script); templated values lose control chars
      const text = tpl(action.text, vars, stripControl)
      const r = await osaArgs('on run argv\ntell application "System Events" to keystroke (item 1 of argv)\nend run', [text])
      if (!r.ok) engine.notify(accessHint(r), 'error'); return r
    }
    case 'applescript': {
      let t
      try { t = appleScriptTemplate(action.script, vars) } catch (e) { engine.notify(e.message, 'error'); return { ok: false, stdout: '', stderr: e.message } }
      return osaArgs(t.script, t.args)
    }
    case 'shortcut': return run('shortcuts', ['run', tpl(action.name, vars), ...(action.input ? ['-i', '-'] : [])], { input: action.input ? tpl(action.input, vars) : undefined, timeout: 60000 })
    case 'http': {
      try {
        const method = (action.method || 'GET').toUpperCase()
        const url = tpl(action.url, vars, encodeURIComponent)
        if (!isSafeUrl(url)) throw new Error('only http(s) URLs')
        const res = await fetch(url, {
          method, signal: AbortSignal.timeout(10000),
          headers: action.body ? { 'content-type': action.contentType || 'application/json' } : undefined,
          body: action.body && method !== 'GET' ? tpl(action.body, vars, v => JSON.stringify(v).slice(1, -1)) : undefined,
        })
        if (!res.ok) engine.notify(`HTTP ${res.status}`, 'error')
        return { ok: res.ok }
      } catch (e) { engine.notify(`HTTP failed: ${e.message}`, 'error'); return { ok: false } }
    }
    case 'media': {
      // NX keytype codes: 16 play, 17 next, 18 previous, 7 mute — posted via a tiny JXA helper (no Accessibility needed)
      const code = { playpause: 16, play: 16, next: 17, previous: 18, prev: 18, mute: 7 }[action.command] ?? 16
      return run('osascript', ['-l', 'JavaScript', '-e', MEDIA_JXA(code)])
    }
    case 'volume': {
      const cur = await getVolume() ?? 50
      const step = Number(action.step ?? 2) * (vars.delta ?? 1)
      const v = await setVolume(cur + step)
      engine.toast(`🔊 ${v}%`)
      return v
    }
    case 'brightness': return engine.setBrightness(engine.brightness + Number(action.step ?? 10) * (vars.delta ?? 1))
    case 'multi': for (const a of action.actions || []) await runAction(a, ctx); return
    case 'app': {
      // one target, or several to try in order ("com.example.app, com.example.app-beta")
      const targets = String(action.target || '').split(',').map(t => t.trim()).filter(Boolean)
      for (const t of targets) {
        const r = await run('open', /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t) ? ['-b', t] : ['-a', t])
        if (r.ok) return r
      }
      engine.notify(`can't open ${targets.join(' / ')} — is it installed?`, 'error')
      return { ok: false }
    }
    case 'hold-keys': return // handled on key down / key up by the engine
    case 'agents-next': return engine.live.goMostUrgent()
    case 'mic-mute': return engine.live.toggleMic(action.mode || 'toggle')
    case 'audio-input': return engine.live.setInput(tpl(action.device, vars))
    case 'audio-output': return engine.live.setOutput(tpl(action.device, vars))
    case 'capture': return runCapture(action, ctx)
    case 'plugin': return engine.live.plugins.run(action, ctx)
    default: engine.notify(`unknown action type ${action.type}`, 'error')
  }
}

function accessHint(r) {
  return /not allowed|1002|assistive/i.test(r.stderr)
    ? 'Grant Accessibility to the terminal/node running DeckStudio (System Settings → Privacy & Security → Accessibility)'
    : `keystroke failed: ${r.stderr.split('\n')[0]}`
}

const MEDIA_JXA = code => `
ObjC.import('AppKit'); ObjC.import('CoreGraphics');
function post(down){
  var flags = down ? 0xa00 : 0xb00;
  var data1 = (${code} << 16) | ((down ? 0xa : 0xb) << 8);
  var ev = $.NSEvent.otherEventWithTypeLocationModifierFlagsTimestampWindowNumberContextSubtypeData1Data2(14, $.NSMakePoint(0,0), flags, 0, 0, $(), 8, data1, -1);
  $.CGEventPost(0, ev.CGEvent);
}
post(true); post(false);`
