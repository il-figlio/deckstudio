// Bring Your Own Bots: every bot provider in one list.
//   grokbot  — Grok Bot's local roster, read live (src/grokbots.mjs)
//   file     — any bot app: JSON files in ~/.deckstudio/bots/*.json (written directly, or via POST /api/bots)
//   command  — profile.botProviders[{ type: 'command', id, cmd, interval }]: a command that prints the JSON, polled
//   plugin   — a plugin's `bots` transport (src/plugins.mjs feeds setPlugin); trusted per the plugin's grants
// The schema and the trust rules (what a press may do) live in src/bot-schema.mjs.
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import dns from 'node:dns'
import https from 'node:https'
import { execFile, spawn } from 'node:child_process'
import { GrokBots } from './grokbots.mjs'
import { GROK, MAX_BOTS, MAX_DOC, PROVIDER_RE, botFace, botPress, botThumb, cleanStatus, findBot, listBots, normalizeBot, parseBotDocs, pressText, providerId, providerTrust, splitDocs } from './bot-schema.mjs'

const HOME_DIR = process.env.DECKSTUDIO_HOME || path.join(process.env.HOME, '.deckstudio')
export const BOTS_DIR = path.join(HOME_DIR, 'bots')
const REMOVED_DIR = path.join(BOTS_DIR, '.removed')
const STALE_MS = 24 * 3600e3 // a file not rewritten for a day: its bots stop calling you
const err = (msg, code = 400) => Object.assign(new Error(msg), { code })
const mb = `${MAX_DOC >> 20} MB`
const fallbackOf = f => f.replace(/\.json$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 32) || 'bots'
const writeAtomic = (file, json) => { fs.writeFileSync(file + '.tmp', json, { mode: 0o600 }); fs.renameSync(file + '.tmp', file) }
const quiet = b => ({ ...b, awaiting: false, unread: 0, stale: true })

export class BotHub {
  constructor() {
    this.grok = new GrokBots()
    this.files = new Map()    // file name → { mtime, docs, error }
    this.commands = new Map() // provider id → { cfg, doc, error, at, timer, child }
    this.plugins = new Map()  // provider id (= plugin id) → { name, doc (bots/v1, parsed), error, stale, trust: { allowShell, schemes } }
    this.images = new Map()   // https avatar url → { data, fails, retryAt, busy } (LRU order)
    this.cmdSig = ''
    this.cfg = () => []       // profile.botProviders (set by live.mjs): trust + command providers
    this.onChange = () => {}
  }
  start(onChange) {
    this.onChange = onChange || this.onChange
    try { fs.mkdirSync(BOTS_DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(BOTS_DIR, 0o700) } catch {}
    this.grok.refresh(); this.scanFiles()
    this.timer = setInterval(() => { const a = this.grok.refresh(), b = this.scanFiles(); if (a || b) this.onChange() }, 3000)
  }
  stop() { clearInterval(this.timer); for (const c of this.commands.values()) this.killCommand(c); this.commands.clear() }

  // ---------- json files (~/.deckstudio/bots) ----------
  scanFiles() {
    let names = []
    try { names = fs.readdirSync(BOTS_DIR).filter(f => /^[A-Za-z0-9._-]{1,80}\.json$/.test(f) && !f.startsWith('.')) } catch {}
    let changed = false
    for (const f of [...this.files.keys()]) if (!names.includes(f)) { this.files.delete(f); changed = true }
    for (const f of names) {
      const file = path.join(BOTS_DIR, f)
      try {
        const st = fs.statSync(file)
        if (!st.isFile()) continue
        const prev = this.files.get(f)
        if (prev && prev.mtime === st.mtimeMs) continue
        if (st.size > MAX_DOC) { this.files.set(f, { mtime: st.mtimeMs, docs: [], error: `file over ${mb}` }); changed = true; continue }
        let docs = [], error = null
        try { docs = parseBotDocs(fs.readFileSync(file, 'utf8'), fallbackOf(f)) }
        catch (e) {
          error = e.message.slice(0, 160)
          // half-written (or briefly broken): keep showing the last good version instead of flickering off
          if (prev?.docs.length) { docs = prev.docs; error = `${error} (showing the last good version)` }
        }
        // Grok Bot is read live; a file can't impersonate it
        docs = docs.filter(d => d.provider !== GROK.id)
        this.files.set(f, { mtime: st.mtimeMs, docs, error }); changed = true
      } catch {}
    }
    return changed
  }
  /** Write (or merge into) ~/.deckstudio/bots/<provider>.json. Used by POST /api/bots and the editor's paste import. */
  push(body) {
    const merge = body?.merge === true
    const text = body?.text != null ? String(body.text) : null
    if (Buffer.byteLength(text ?? JSON.stringify(body ?? {})) > MAX_DOC) throw err(`bots document over ${mb}`, 413)
    let input
    if (text != null) try { input = JSON.parse(text) } catch (e) { throw err(`not json: ${e.message}`) }
    else { const { merge: _m, ...rest } = body || {}; input = rest }
    const writes = []
    for (const { provider, doc, rows } of splitDocs(input, 'bots')) {
      if (provider === GROK.id) throw err('Grok Bot is read live from its app on this Mac — push other providers under their own id')
      if (!PROVIDER_RE.test(provider)) throw err('bad provider id')
      const file = path.join(BOTS_DIR, `${provider}.json`)
      const { bots: _b, ...meta } = doc
      let head = meta, list = rows
      if (merge) {
        // merge the raw rows over the stored raw rows, then normalize: fields a row leaves out keep their old value
        let old = null
        try { old = splitDocs(JSON.parse(fs.readFileSync(file, 'utf8')), provider).find(x => x.provider === provider) } catch {}
        if (old) {
          const { bots: _o, ...oldMeta } = old.doc
          head = { ...oldMeta, ...meta }
          const byId = new Map(old.rows.filter(r => r && typeof r === 'object').map(r => [String(r.id), r]))
          for (const r of rows) if (r && typeof r === 'object') byId.set(String(r.id), { ...(byId.get(String(r.id)) || {}), ...r })
          list = [...byId.values()].slice(0, MAX_BOTS)
        }
      }
      const [d] = parseBotDocs({ ...head, provider, bots: list }, provider)
      if (!d.bots.length) throw err(`no bots for "${provider}" (each needs an id and a name)`)
      const json = JSON.stringify({ deckstudio: 'bots/v1', provider, name: d.name, app: d.app, logo: d.logo, schemes: d.schemes, updatedAt: new Date().toISOString(), bots: d.bots.map(strip) }, null, 2)
      if (Buffer.byteLength(json) > MAX_DOC) throw err(`${provider}: over ${mb} once saved (shrink inline avatars, or use https ones)`, 413)
      writes.push({ file, json, provider, count: d.bots.length })
    }
    if (!writes.length) throw err('no bots found')
    fs.mkdirSync(BOTS_DIR, { recursive: true, mode: 0o700 })
    for (const w of writes) writeAtomic(w.file, w.json)
    if (this.scanFiles()) this.onChange()
    const out = writes.map(({ provider, count }) => ({ provider, count }))
    return { providers: out, count: out.reduce((n, p) => n + p.count, 0) }
  }
  /** Status only: { provider, id, unread?, awaiting?, hidden?, activityAt? } updates one bot in the file that owns that provider. */
  status(b) {
    const p = String(b?.provider ?? ''), id = String(b?.id ?? '')
    if (this.scanFiles()) this.onChange()
    const own = this.owners().get(p)
    if (!PROVIDER_RE.test(p) || own?.kind !== 'file') throw err(`no file provider "${p}"`)
    const file = path.join(BOTS_DIR, own.file)
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    const row = splitDocs(raw, fallbackOf(own.file)).find(x => x.provider === p)?.rows.find(x => x && String(x.id) === id)
    if (!row) throw err(`no bot "${id}" in ${p}`)
    const s = cleanStatus(b)
    Object.assign(row, s)
    if (!('activityAt' in s)) row.activityAt = new Date().toISOString()
    writeAtomic(file, JSON.stringify(raw, null, 2))
    if (this.scanFiles()) this.onChange()
    return { ok: true }
  }
  /** Moves the provider's file to bots/.removed (a file holding other providers too is rewritten without it). */
  remove(provider) {
    const moved = [], rewritten = []
    for (const [f, e] of this.files) {
      const mine = e.docs.filter(d => d.provider === provider).length
      if (!mine && f !== `${provider}.json`) continue
      const file = path.join(BOTS_DIR, f)
      try {
        if (mine && e.docs.length > mine) {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
          const list = Array.isArray(raw) ? raw : raw?.providers
          if (!Array.isArray(list)) continue
          const keep = list.filter(d => !(d && typeof d === 'object' && providerId(d.provider ?? d.id ?? d.name, fallbackOf(f)) === provider))
          writeAtomic(file, JSON.stringify(Array.isArray(raw) ? keep : { ...raw, providers: keep }, null, 2))
          rewritten.push(f)
        } else {
          fs.mkdirSync(REMOVED_DIR, { recursive: true, mode: 0o700 })
          fs.renameSync(file, path.join(REMOVED_DIR, `${f.replace(/\.json$/, '')}.${new Date().toISOString().replace(/[:.]/g, '-')}.json`))
          moved.push(f)
        }
      } catch {}
    }
    if (this.scanFiles()) this.onChange()
    return { removed: moved.length + rewritten.length, moved, rewritten, to: REMOVED_DIR }
  }

  // ---------- command providers (profile.botProviders) ----------
  setCommands(list) {
    const seen = new Set()
    const cfgs = (Array.isArray(list) ? list : []).filter(c => c && c.type === 'command' && PROVIDER_RE.test(String(c.id || '')) && c.id !== GROK.id && typeof c.cmd === 'string' && c.cmd.trim() && !seen.has(c.id) && seen.add(c.id))
      .map(({ type, id, name, cmd, interval }) => ({ type, id, name: typeof name === 'string' ? name : undefined, cmd, interval }))
    const sig = JSON.stringify(cfgs)
    if (sig === this.cmdSig) return
    this.cmdSig = sig
    for (const c of this.commands.values()) this.killCommand(c)
    this.commands.clear()
    for (const cfg of cfgs) { const c = { cfg, doc: null, error: null, at: 0 }; this.commands.set(cfg.id, c); this.runCommand(c) }
    this.onChange()
  }
  killCommand(c) {
    clearTimeout(c.timer)
    if (c.child?.pid) try { process.kill(-c.child.pid, 'SIGKILL') } catch {} // the whole process group, not just zsh
    c.child = null
  }
  runCommand(c) {
    if (this.commands.get(c.cfg.id) !== c) return
    const every = Math.max(5, Math.min(3600, Number(c.cfg.interval) || 15)) * 1000
    let child
    try { child = spawn('/bin/zsh', ['-lc', c.cfg.cmd], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DECK_BOTS_PROVIDER: c.cfg.id } }) }
    catch (e) { c.error = e.message; c.timer = setTimeout(() => this.runCommand(c), every); return }
    c.child = child
    const out = [], errs = []
    let size = 0, why = '', done = false
    const kill = w => { why ||= w; try { process.kill(-child.pid, 'SIGKILL') } catch {} }
    const t = setTimeout(() => kill('timed out after 20 s'), 20000)
    child.stdout.on('data', d => { size += d.length; if (size > MAX_DOC) kill(`output over ${mb}`); else out.push(d) })
    child.stderr.on('data', d => { if (errs.length < 20) errs.push(d) })
    const finish = (code, e) => {
      if (done) return
      done = true; clearTimeout(t)
      if (c.child === child) c.child = null
      if (this.commands.get(c.cfg.id) !== c) return
      const before = JSON.stringify([c.doc, c.error])
      if (e || why || code !== 0) c.error = (why || String(Buffer.concat(errs)).trim().split('\n')[0] || e?.message || `exit ${code}`).slice(0, 160)
      else {
        try { const d = parseBotDocs(String(Buffer.concat(out)), c.cfg.id)[0]; c.doc = { ...d, provider: c.cfg.id, name: c.cfg.name || d.name, bots: d.bots.map(b => ({ ...b, provider: c.cfg.id, key: `${c.cfg.id}:${b.id}` })) }; c.error = null }
        catch (x) { c.error = `output: ${x.message}`.slice(0, 160) }
      }
      c.at = Date.now()
      if (JSON.stringify([c.doc, c.error]) !== before) this.onChange()
      c.timer = setTimeout(() => this.runCommand(c), every)
    }
    child.on('error', e => finish(null, e))
    child.on('close', code => finish(code))
  }

  // ---------- plugin providers (a plugin's `bots` transport, polled by PluginHost) ----------
  /** entry: { name, doc (raw json), error, stale, trust } or null to drop the provider. */
  setPlugin(id, entry) {
    if (!PROVIDER_RE.test(id) || id === GROK.id) return
    const before = JSON.stringify(this.plugins.get(id) ?? null)
    if (!entry) this.plugins.delete(id)
    else {
      let doc = null, error = entry.error || null
      if (entry.doc) try { const d = parseBotDocs(entry.doc, id)[0]; doc = { ...d, provider: id, name: entry.name || d.name, bots: d.bots.map(b => ({ ...b, provider: id, key: `${id}:${b.id}` })) } } catch (e) { error = `bots: ${e.message}`.slice(0, 160) }
      this.plugins.set(id, { name: entry.name, doc, error, stale: !!entry.stale || (!!error && !!doc), trust: entry.trust || {} })
    }
    if (JSON.stringify(this.plugins.get(id) ?? null) !== before) this.onChange()
  }

  // ---------- the combined list ----------
  grokBots() {
    return this.grok.bots.map((r, i) => normalizeBot({ id: r.id, name: r.fullName || r.name, avatar: { shape: r.shape, color: r.color }, unread: r.unread, awaiting: r.awaiting, hidden: r.hidden, activityAt: r.activityAt }, GROK.id, i)).filter(Boolean)
  }
  /** provider id → its one owner: commands (profile order) first, then files by name. Later claims are duplicates. */
  owners() {
    const own = new Map(), dups = []
    for (const c of this.commands.values()) own.set(c.cfg.id, { kind: 'command', c, doc: c.doc, stale: !!(c.error && c.doc) })
    for (const [id, p] of this.plugins) if (!own.has(id)) own.set(id, { kind: 'plugin', p, doc: p.doc, stale: p.stale })
    for (const f of [...this.files.keys()].sort()) {
      const e = this.files.get(f)
      for (const d of e.docs) {
        if (own.has(d.provider)) dups.push({ file: f, doc: d, owner: own.get(d.provider) })
        else own.set(d.provider, { kind: 'file', file: f, doc: d, stale: Date.now() - e.mtime > STALE_MS })
      }
    }
    own.dups = dups
    return own
  }
  trust(id, own = this.owners()) {
    const o = own.get(id)
    // a plugin's bots: on while the plugin is (the host only feeds enabled plugins), shell / schemes per its grants
    if (o?.kind === 'plugin') return providerTrust([{ id, enabled: true, allowShell: o.p.trust.allowShell === true, schemes: o.p.trust.schemes || [] }], id, o.doc?.schemes)
    return providerTrust(this.cfg(), id, o?.doc?.schemes)
  }
  all() {
    const own = this.owners()
    const out = this.trust(GROK.id, own).enabled ? this.grokBots() : []
    for (const [id, o] of own) if (o.doc && this.trust(id, own).enabled) out.push(...(o.stale ? o.doc.bots.map(quiet) : o.doc.bots))
    return out
  }
  providers() {
    const own = this.owners()
    const grok = this.grokBots()
    const t0 = this.trust(GROK.id, own)
    const out = [{ id: GROK.id, name: GROK.name, kind: 'grokbot', app: GROK.app, logo: GROK.logo, available: this.grok.available, count: grok.filter(b => !b.hidden).length, enabled: t0.enabled }]
    const needs = (id, d, t) => {
      const ps = (d?.bots || []).map(b => botPress(b, t))
      const blocked = [...new Set(ps.filter(p => p.blocked && p.kind === 'url').map(p => p.url.slice(0, p.url.indexOf(':')).toLowerCase()))]
      return { schemes: d?.schemes || [], allowed: t.schemes, allowShell: t.allowShell, blockedSchemes: blocked, shell: ps.filter(p => p.kind === 'shell').length }
    }
    for (const [id, o] of own) {
      const t = this.trust(id, own), d = o.doc
      const base = { id, enabled: t.enabled, stale: o.stale, app: d?.app, logo: d?.logo, count: d?.bots.length || 0, ...needs(id, d, t) }
      if (o.kind === 'file') out.push({ ...base, name: d.name, kind: 'file', file: o.file, error: this.files.get(o.file)?.error || (o.stale ? 'not updated for over a day: its bots no longer call you' : null) })
      else if (o.kind === 'plugin') out.push({ ...base, name: o.p.name || d?.name || id, kind: 'plugin', plugin: id, error: o.p.error && d ? `${o.p.error} (showing the last good run)` : o.p.error })
      else out.push({ ...base, name: o.c.cfg.name || d?.name || id, kind: 'command', cmd: o.c.cfg.cmd, interval: o.c.cfg.interval || 15, error: o.c.error && d ? `${o.c.error} (showing the last good run)` : o.c.error, at: o.c.at })
    }
    for (const x of own.dups) out.push({ id: x.doc.provider, name: x.doc.name, kind: 'file', file: x.file, count: 0, enabled: false, duplicate: true, error: `duplicate: "${x.doc.provider}" already comes from ${x.owner.file || `the ${x.owner.kind} provider`}` })
    for (const [f, e] of this.files) if (!e.docs.length) out.push({ id: f.replace(/\.json$/, ''), name: f, kind: 'file', file: f, count: 0, enabled: false, error: e.error || 'no bots' })
    return out
  }
  provider(id) { return this.providers().find(p => p.id === id && !p.duplicate) || null }
  list(opts) { return listBots(this.all(), opts) }
  find(ref) { return findBot(this.all(), ref) }
  press(b, own = this.owners()) { return botPress(b, this.trust(b.provider, own), b.provider === GROK.id ? GROK.app : own.get(b.provider)?.doc?.app) }

  /** For the editor: no hidden bots, one thumbnail per bot (the avatar image isn't sent twice), what a press does. */
  summary({ provider, logoUrl } = {}) {
    const own = this.owners()
    const bots = this.all().filter(b => !b.hidden && (!provider || b.provider === provider))
    return {
      providers: this.providers(), dir: BOTS_DIR,
      bots: bots.map(b => {
        const p = this.press(b, own)
        const img = b.avatar?.image
        const thumb = img && !img.startsWith('data:') ? this.image(img) || botThumb(b, logoUrl) : botThumb(b, logoUrl)
        return { ...b, avatar: img ? { ...b.avatar, image: undefined } : b.avatar, thumb, press: pressText(p), blocked: !!p.blocked }
      }),
    }
  }

  /** https avatars: fetched safely (see fetchAvatar), shrunk, kept in a small LRU; failures retry with backoff. */
  image(url) {
    let e = this.images.get(url)
    if (e) this.images.delete(url)
    else e = { data: null, fails: 0, retryAt: 0, busy: false }
    this.images.set(url, e)
    while (this.images.size > 64) this.images.delete(this.images.keys().next().value)
    if (!e.data && !e.busy && Date.now() >= e.retryAt) {
      e.busy = true
      fetchAvatar(url).then(d => { e.data = d; e.fails = 0; this.onChange() },
        () => { e.fails++; e.retryAt = Date.now() + Math.min(3600e3, 30e3 * 2 ** (e.fails - 1)) }).finally(() => { e.busy = false })
    }
    return e.data || undefined
  }
  face(b) { return botFace(b, { image: b.avatar?.image?.startsWith('https:') ? this.image(b.avatar.image) : undefined }) }

  /** The press action for a bot (see botPress): url / app run directly (no templating), shell only when trusted. */
  openAction(b) {
    const p = this.press(b)
    const label = `open ${b.provider === GROK.id ? 'grok bot' : b.provider} ${b.name}`
    const run = (cmd, args) => new Promise((res, rej) => execFile(cmd, args, e => (e ? rej(e) : res())))
    if (p.blocked) return { type: 'internal', desc: `${label} (blocked)`, run: () => { throw new Error(`${p.blocked} (editor → bots)`) } }
    if (p.kind === 'url') return { type: 'internal', desc: label, run: () => run('open', [p.url]) }
    if (p.kind === 'app') return { type: 'internal', desc: label, run: () => run('open', ['-b', p.target]) }
    if (p.kind === 'shell') return { type: 'shell', cmd: p.cmd }
    return { type: 'internal', desc: `${label} (no open action)`, run: () => {} }
  }
}

// what a file keeps per bot (the normalized fields, minus derived ones)
function strip(b) {
  const { key, shape, color, fullName, name, provider, ...rest } = b
  const subtitle = fullName.startsWith(name + ' · ') ? fullName.slice(name.length + 3) : undefined
  return { ...rest, name, ...(subtitle ? { subtitle } : {}), activityAt: b.activityAt || undefined, avatar: b.avatar || undefined, open: b.open || undefined }
}

// ---------- https avatar fetch: no SSRF, no bombs ----------
// Only https, no userinfo; every address (each DNS answer, each redirect hop, max 3) must be public;
// the connection goes to the address we checked (custom lookup), body ≤ 1 MB streamed with a hard
// cap and no compression; png/jpeg/gif/webp by magic bytes, ≤ 4096 px; shrunk to 144 px PNG.
const MAX_AVATAR = 1 << 20
// Two lists: Node's BlockList matches an IPv4 address against IPv6 rules too (as ::ffff:a.b.c.d), so one list with
// ::ffff:0:0/96 in it would block every IPv4 host. IPv4-mapped IPv6 is unmapped and checked as IPv4 instead.
const BLOCK4 = new net.BlockList(), BLOCK6 = new net.BlockList()
for (const [a, n] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) BLOCK4.addSubnet(a, n, 'ipv4')
// ::/96 covers ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d (which connects to a.b.c.d); ::ffff:0:0:0/96 is IPv4-translated
for (const [a, n] of [['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['100::', 64], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) BLOCK6.addSubnet(a, n, 'ipv6')
export const blockedAddress = a => {
  const v = net.isIP(a)
  if (v === 4) return BLOCK4.check(a, 'ipv4')
  if (v !== 6) return true
  let h // the URL parser normalizes any spelling (dotted tail, zeros, case) to compressed hex; a zone id etc. throws → blocked
  try { h = new URL(`http://[${a}]/`).hostname.slice(1, -1) } catch { return true }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h) // IPv4-mapped (::ffff:0:x is ::ffff:0.0.0.x)
  if (m) { const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16); return BLOCK4.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, 'ipv4') }
  return BLOCK6.check(h, 'ipv6')
}

function sniff(b) {
  if (b.length > 24 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG') return { type: 'png', w: b.readUInt32BE(16), h: b.readUInt32BE(20) }
  if (b.length > 10 && b.toString('latin1', 0, 4) === 'GIF8') return { type: 'gif', w: b.readUInt16LE(6), h: b.readUInt16LE(8) }
  if (b.length > 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const k = b.toString('latin1', 12, 16)
    if (k === 'VP8X') return { type: 'webp', w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) }
    if (k === 'VP8L') { const v = b.readUInt32LE(21); return { type: 'webp', w: 1 + (v & 0x3fff), h: 1 + ((v >> 14) & 0x3fff) } }
    if (k === 'VP8 ') return { type: 'webp', w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff }
    return null
  }
  if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8) {
    for (let i = 2; i + 9 < b.length;) { // walk the markers to the frame header (SOF0–15, not DHT/JPG/DAC)
      if (b[i] !== 0xff) return null
      const m = b[i + 1]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { type: 'jpeg', h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) }
      i += 2 + b.readUInt16BE(i + 2)
    }
  }
  return null
}

/** Fetches an https avatar → a ≤144 px PNG data URL. `opts.allowLookup(address)` / `opts.ca` exist for tests only. */
export async function fetchAvatar(url, opts = {}) {
  const lookup = (host, o, cb) => dns.lookup(host, { all: true }, (e, list) => {
    if (e) return cb(e)
    const bad = list.find(a => blockedAddress(a.address) && !opts.allowLookup?.(a.address))
    if (bad || !list.length) return cb(err(`blocked address ${bad?.address || 'none'}`))
    return o?.all ? cb(null, list) : cb(null, list[0].address, list[0].family)
  })
  for (let hop = 0; hop <= 3; hop++) {
    const u = new URL(url)
    if (u.protocol !== 'https:') throw err('https only')
    if (u.username || u.password) throw err('no user info in avatar urls')
    const host = u.hostname.replace(/^\[|\]$/g, '')
    if (net.isIP(host) && blockedAddress(host)) throw err(`blocked address ${host}`) // literals skip lookup: check them here
    const r = await new Promise((res, rej) => {
      const req = https.get(u, { agent: false, lookup, ca: opts.ca, headers: { accept: 'image/png,image/jpeg,image/gif,image/webp', 'accept-encoding': 'identity', 'user-agent': 'DeckStudio' } }, res)
      req.on('error', rej)
      req.setTimeout(8000, () => req.destroy(err('timed out')))
    })
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.destroy(); url = new URL(r.headers.location, u).href; continue }
    try {
      if (r.statusCode !== 200) throw err(`http ${r.statusCode}`)
      const enc = String(r.headers['content-encoding'] || 'identity').toLowerCase()
      if (enc !== 'identity') throw err(`compressed (${enc})`)
      if (Number(r.headers['content-length']) > MAX_AVATAR) throw err('over 1 MB')
      const chunks = []
      let n = 0
      const stop = setTimeout(() => r.destroy(err('timed out')), 8000)
      try { for await (const c of r) { n += c.length; if (n > MAX_AVATAR) throw err('over 1 MB'); chunks.push(c) } } finally { clearTimeout(stop) }
      const buf = Buffer.concat(chunks)
      const s = sniff(buf)
      if (!s) throw err('not a png / jpeg / gif / webp')
      if (!(s.w > 0 && s.h > 0 && s.w <= 4096 && s.h <= 4096)) throw err(`bad size ${s.w}×${s.h}`)
      const { createCanvas, loadImage } = await import('@napi-rs/canvas')
      const img = await loadImage(buf)
      const k = Math.min(1, 144 / Math.max(img.width, img.height))
      const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k))
      const c = createCanvas(w, h)
      c.getContext('2d').drawImage(img, 0, 0, w, h)
      return `data:image/png;base64,${c.toBuffer('image/png').toString('base64')}`
    } finally { r.destroy() }
  }
  throw err('too many redirects')
}
