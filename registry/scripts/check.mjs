#!/usr/bin/env node
// Registry checks (run by CI and before every PR):
//   1. every manifest passes DeckStudio's validateManifest with no warnings, plus the registry rules (lib.mjs);
//   2. fixtures dry-run: each fixtures/<name>.json is parsed like real status output and its values are compared
//      with fixtures/<name>.expect.json ({ "values": { name: "shown text", … } }, a subset is fine);
//   3. templates: every {<id>.value} / {<id>.settings.x} they show is declared, every plugin action they press exists
//      and only passes declared params; every action's {placeholders} resolve (params, control vars, values, settings);
//   4. host dry-run (DeckStudio's src/plugins.mjs from this repo; skip with --no-host): the plugin
//      runs inside a real PluginHost in a scratch DECKSTUDIO_HOME, with its program replaced by a fake that prints
//      the fixture. Values must match, cmd actions must run with the expected argv, app actions must resolve.
//      Nothing real is executed: a plugin whose program isn't the fake is skipped, url actions are only resolved;
//   5. index.json is up to date.
//
//   node registry/scripts/check.mjs [--no-host] [plugin-id…]   (npm run registry:check)
import fs from 'node:fs'
import crypto from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSchema, deckstudioSrc, pluginFolders, checkFolder, fixtureFiles, indexEntry, buildIndex, INDEX } from './lib.mjs'

const args = process.argv.slice(2)
const noHost = args.includes('--no-host')
const only = new Set(args.filter(a => !a.startsWith('--')))
const S = await loadSchema()
const CONTROL_VARS = new Set(['value', 'delta', 'index', 'page', 'x', 'y'])
let failures = 0
const fail = (id, msg) => { failures++; console.error(`  ✗ ${id}: ${msg}`) }
const pass = (id, msg) => console.log(`  ✓ ${id}: ${msg}`)

const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)
function walk(v, f) { if (Array.isArray(v)) v.forEach(x => walk(x, f)); else if (isObj(v)) { f(v); Object.values(v).forEach(x => walk(x, f)) } }
const varsIn = s => [...String(s).matchAll(S.VAR_RE)].map(m => m[1])
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'))
const expectFile = fx => fx.replace(/\.json$/, '.expect.json')

// ---------- 1–3: static checks ----------
const checked = []
console.log('static checks')
for (const f of pluginFolders()) {
  if (only.size && !only.has(f.name)) continue
  const r = checkFolder(S, f)
  if (r.errors.length || r.warnings.length) { for (const e of [...r.errors, ...r.warnings.map(w => `warning: ${w}`)]) fail(f.name, e); continue }
  const m = r.manifest
  pass(m.id, 'manifest valid')
  checked.push({ f, m })

  // fixtures dry-run
  for (const fx of fixtureFiles(f.dir)) {
    const name = path.basename(fx)
    if (!fs.existsSync(expectFile(fx))) { fail(m.id, `${name}: missing ${path.basename(expectFile(fx))}`); continue }
    let doc
    try { doc = S.parseStatus(fs.readFileSync(fx, 'utf8'), m.status?.parse ?? 'auto') } catch (e) { fail(m.id, `${name}: ${e.message}`); continue }
    const got = S.extractValues(m, doc)
    const want = readJson(expectFile(fx)).values || {}
    const bad = Object.entries(want).filter(([k, v]) => got[k] !== String(v))
    const unknown = Object.keys(want).filter(k => !(k in got))
    if (unknown.length) fail(m.id, `${name}: expect names undeclared values: ${unknown.join(', ')}`)
    if (bad.length) fail(m.id, `${name}: ${bad.map(([k, v]) => `${k} = ${JSON.stringify(got[k])}, expected ${JSON.stringify(String(v))}`).join('; ')}`)
    else pass(m.id, `${name}: ${Object.keys(want).length} values as expected`)
  }

  // templates: shown vars and pressed actions
  const recipes = S.pluginRecipes(m)
  let tplErrors = 0
  for (const rc of recipes) {
    const s = JSON.stringify(rc.template)
    if (s.includes('{self.')) { fail(m.id, `${rc.id}: unbound {self.…}`); tplErrors++ }
    for (const v of varsIn(s)) {
      if (!v.includes('.')) continue
      const [pid, name, sub] = v.split('.')
      if (pid === m.id && name === 'settings' && !(sub in m.settings)) { fail(m.id, `${rc.id}: shows {${v}}, which isn't a declared setting`); tplErrors++ }
      else if (pid === m.id && name !== 'settings' && name !== '_state' && !(name in m.values)) { fail(m.id, `${rc.id}: shows {${v}}, which isn't a declared value`); tplErrors++ }
    }
    walk(rc.template, o => {
      if (o.type !== 'plugin' || o.plugin !== m.id) return
      const a = m.actions[o.action]
      if (!a) { fail(m.id, `${rc.id}: presses unknown action "${o.action}"`); tplErrors++; return }
      const extra = Object.keys(o.args || {}).filter(k => !a.params.includes(k))
      if (extra.length) { fail(m.id, `${rc.id}: action ${o.action} doesn't take ${extra.join(', ')}`); tplErrors++ }
    })
  }
  if (!tplErrors) pass(m.id, `${recipes.length} templates bind (values and actions declared)`)

  // action placeholders
  let actErrors = 0
  for (const [name, a] of Object.entries(m.actions)) {
    const parts = a.kind === 'cmd' ? (Array.isArray(a.cmd) ? a.cmd.slice(1) : []) : a.kind === 'url' ? [a.url] : a.kind === 'http' ? [a.http, a.body ?? ''] : []
    for (const v of parts.flatMap(varsIn)) {
      const [pid, name] = v.split('.')
      const ok = !v.includes('.') ? a.params.includes(v) || CONTROL_VARS.has(v) : pid === 'settings' ? name in m.settings : pid === m.id && name in m.values
      if (!ok) { fail(m.id, `action ${name}: {${v}} is neither a param, a control var nor a declared value`); actErrors++ }
    }
  }
  if (!actErrors) pass(m.id, `${Object.keys(m.actions).length} actions: placeholders resolve`)
}

// ---------- 4: host dry-run ----------
const { srcDir } = deckstudioSrc()
const hostFile = path.join(srcDir, 'plugins.mjs')
if (!noHost && fs.existsSync(hostFile) && checked.length) {
  console.log('\nhost dry-run (PluginHost, scratch DECKSTUDIO_HOME, fake programs)')
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'deckstudio-registry-check-'))
  const fakeBin = path.join(scratch, 'bin'), userDir = path.join(scratch, 'home/plugins'), argvDir = path.join(scratch, 'argv')
  for (const d of [fakeBin, userDir, argvDir]) fs.mkdirSync(d, { recursive: true })
  // one file per run (runs of different fakes overlap): [{ mtime, argv }] for program `bare`, oldest first
  const runsOf = bare => fs.readdirSync(argvDir).filter(n => n.startsWith(bare + '.')).map(n => ({ n, t: fs.statSync(path.join(argvDir, n)).mtimeMs, argv: fs.readFileSync(path.join(argvDir, n), 'utf8').split('\0').filter(Boolean) })).sort((a, b) => a.t - b.t)
  // fakes: each bare program name a plugin detects prints that plugin's first fixture and logs its argv
  const fakes = {}
  for (const { f, m } of checked) {
    if (!m.status || m.status.kind !== 'cmd' || !Array.isArray(m.status.cmd) || m.status.cmd[0] !== '$bin') continue
    const bare = m.detect.bin.find(b => !b.includes('/'))
    const fx = fixtureFiles(f.dir)[0]
    if (!bare || !fx) continue
    const script = path.join(fakeBin, bare)
    fs.writeFileSync(script, `#!/bin/sh\nprintf '%s\\0' "$@" > '${argvDir}/${bare}.'$$\ncat '${fx.replace(/'/g, `'\\''`)}'\n`, { mode: 0o755 })
    fakes[m.id] = { script, fx }
  }
  // PATH and DECKSTUDIO_HOME: plugins.mjs reads both when used (set here before the host starts)
  process.env.PATH = `${fakeBin}:${process.env.PATH}`
  process.env.DECKSTUDIO_HOME = path.join(scratch, 'home')
  const { PluginHost } = await import(pathToFileURL(hostFile).href)
  for (const { f } of checked) fs.cpSync(f.dir, path.join(userDir, path.basename(f.dir)), { recursive: true })
  // switched on and approved, as the editor records it: approved = the sha256 of the manifest the user reviewed
  const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
  const cfg = Object.fromEntries(checked.map(({ f, m }) => [m.id, { enabled: true, approved: sha(path.join(userDir, path.basename(f.dir), 'deckstudio.json')) }]))
  const ran = []
  const host = new PluginHost({
    dirs: { builtin: path.join(scratch, 'none'), local: path.join(scratch, 'none/local'), user: userDir },
    cfg: () => cfg, onChange: () => {},
    runAction: async (a) => { ran.push(a); return { ok: true } },
    bundles: async ids => Object.fromEntries(ids.map(i => [i, true])),
  })
  host.focus(checked.map(({ m }) => m.id))
  host.start()
  const info = id => host.summary().plugins.find(p => p.id === id)
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  const toasts = []
  const engine = { toast: t => toasts.push(t), notify: () => {} }
  for (const { m } of checked) {
    const id = m.id
    const t0 = Date.now()
    while (Date.now() - t0 < 8000 && !['ok', 'error', 'missing', 'invalid', 'stale'].includes(info(id)?.state)) await sleep(50)
    const p = info(id)
    const usesBin = m.status?.cmd?.[0] === '$bin'
    if (usesBin && !fakes[id]) { fail(id, 'host: no fake for its program; skipped so the real tool never runs'); continue }
    if (usesBin && p?.bin !== fakes[id].script) { fail(id, `host: resolved ${p?.bin}, not the fake; skipped`); continue }
    if (p?.state !== 'ok') { fail(id, `host: state ${p?.state} ${p?.error || ''}`); continue }
    if (usesBin) {
      const want = readJson(expectFile(fakes[id].fx)).values || {}
      const bad = Object.entries(want).filter(([k, v]) => p.values[k] !== String(v))
      if (bad.length) fail(id, `host values: ${bad.map(([k, v]) => `${k} = ${JSON.stringify(p.values[k])} (want ${JSON.stringify(String(v))})`).join('; ')}`)
      else pass(id, `host: state ok, ${Object.keys(want).length} values match ${path.basename(fakes[id].fx)}`)
      const statusArgv = runsOf(path.basename(fakes[id].script))[0]?.argv
      const sv = S.settingsVars(S.pluginSettings(null, m)) // the manifest's default settings
      const wantArgv = m.status.cmd.slice(1).map(a => S.fillArg(a, sv).replace(/^~\//, os.homedir() + '/'))
      if (statusArgv?.join('\0') === wantArgv.join('\0')) pass(id, `host: status argv ${JSON.stringify(statusArgv)}`)
      else fail(id, `host: status argv ${JSON.stringify(statusArgv)}, want ${JSON.stringify(wantArgv)}`)
    } else pass(id, `host: state ok (bundled status), values ${JSON.stringify(p.values)}`)
    // actions
    for (const [name, a] of Object.entries(m.actions)) {
      const args = Object.fromEntries(a.params.map(k => [k, `t-${k}`]))
      const sv = S.settingsVars(S.pluginSettings(null, m))
      if (a.kind === 'url' || a.kind === 'http') {
        let u
        try { u = S.fillArg(a.kind === 'url' ? a.url : a.http, { ...host.vars(), ...sv, ...args }, encodeURIComponent) } catch (e) { fail(id, `action ${name}: ${e.message}`); continue }
        const why = a.kind === 'url' ? S.urlAllowed(u, { schemes: [] }) : S.httpAllowed(u, { network: [] })
        if (/\{[\w.|-]+\}/.test(u) || why) fail(id, `action ${name}: resolves to ${u} ${why || '(unresolved placeholder)'}`)
        else pass(id, `action ${name} → ${u} (resolved only, not opened)`)
        continue
      }
      if (a.kind === 'cmd' && Array.isArray(a.cmd) && a.cmd[0] === '$bin' && !fakes[id]) { fail(id, `action ${name}: no fake program, skipped`); continue }
      if (a.kind === 'cmd' && Array.isArray(a.cmd) && !['$bin'].includes(a.cmd[0]) && !a.cmd[0].startsWith('$dir/')) { pass(id, `action ${name}: runs ${a.cmd[0]}, skipped in the dry-run`); continue }
      const bare = fakes[id] && path.basename(fakes[id].script), before = bare ? runsOf(bare).map(r => r.n) : []
      try {
        const res = await host.run({ type: 'plugin', plugin: id, action: name, args }, { engine, vars: { value: '1', index: 0, page: 'check' } })
        if (res && res.ok === false) { fail(id, `action ${name}: ${res.stderr || 'failed'}`); continue }
        if (a.kind === 'app') { pass(id, `action ${name} → app ${ran.at(-1)?.target}`); continue }
        if (res?.started) { // detached: wait for the fake to finish (it only prints the fixture)
          const t1 = Date.now()
          while (Date.now() - t1 < 5000 && host.plugins.get(id)?.jobs?.size) await sleep(50)
          if (!fs.existsSync(res.log)) fail(id, `action ${name}: detached, but no log at ${res.log}`)
        }
        if (a.cmd[0] === '$bin') {
          const lines = runsOf(bare).filter(r => !before.includes(r.n)).map(r => r.argv)
          const want = a.cmd.slice(1).map(x => S.fillArg(x, { ...host.vars(), ...sv, ...args }).replace(/^~\//, os.homedir() + '/'))
          const hit = lines.find(l => l.join('\0') === want.join('\0')) // a status poll may land in between
          if (hit) pass(id, `action ${name} → argv ${JSON.stringify(hit)}${a.toast ? ' (toast on)' : ''}${res?.started ? ` (detached, log ${path.basename(res.log)})` : ''}`)
          else fail(id, `action ${name}: argv ${JSON.stringify(lines)}, want ${JSON.stringify(want)}`)
        } else pass(id, `action ${name} ran${a.toast ? `, toast "${toasts.at(-1) ?? ''}"` : ''}`)
      } catch (e) { fail(id, `action ${name}: ${e.message}`) }
    }
    // template presses whose args come from the plugin's values / settings ({ repo: "{repobar.r1_owner}/{repobar.r1_repo}" }): resolve them
    // the way PluginHost.run does (args filled from the current vars, then the url), with the fixture's values
    const vars = { ...host.vars(), ...S.settingsVars(S.pluginSettings(null, m)) }
    const seen = new Set()
    for (const rc of S.pluginRecipes(m)) walk(rc.template, o => {
      if (o.type !== 'plugin' || o.plugin !== id || !o.args || !/\{/.test(JSON.stringify(o.args))) return
      const a = m.actions[o.action]
      if (!a || a.kind !== 'url') return
      const args = Object.fromEntries(Object.entries(o.args).map(([k, v]) => [k, typeof v === 'string' ? S.fillArg(v, vars) : v]))
      let u
      try { u = S.fillArg(a.url, { ...vars, ...args }, encodeURIComponent) } catch (e) { u = `refused (${e.message})` }
      const k = `${o.action} ${u}`
      if (seen.has(k)) return
      seen.add(k)
      pass(id, `template press ${o.action} ${JSON.stringify(o.args)} → ${u}`)
    })
  }
  host.stop()
  fs.rmSync(scratch, { recursive: true, force: true })
} else if (!noHost) console.log(`\nhost dry-run skipped (${fs.existsSync(hostFile) ? 'nothing to run' : `no ${hostFile}`})`)

// ---------- 5: index.json ----------
if (!only.size) {
  console.log('\nindex')
  const all = pluginFolders().map(f => ({ f, r: checkFolder(S, f) }))
  if (all.every(({ r }) => !r.errors.length && !r.warnings.length)) {
    const want = buildIndex(all.map(({ f, r }) => indexEntry(f, r.manifest)))
    const cur = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : ''
    if (cur === want) pass('index.json', `up to date (${all.length} plugins, manifest + per-file sha256 match)`)
    else fail('index.json', 'out of date: run node registry/scripts/build-index.mjs')
  }
}

console.log(failures ? `\n${failures} problem(s).` : '\nall checks passed.')
process.exit(failures ? 1 : 0)
