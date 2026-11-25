// Bring Your Own Bots: the one bot model every provider maps into (Grok Bot's live roster,
// JSON files / pushes from any bot app, a command that prints JSON). Pure functions only, so the
// browser demo uses the exact same parsing and key faces as the server.
//
// A provider document (what a bot app writes to ~/.deckstudio/bots/<provider>.json, POSTs to
// /api/bots, or prints from a command):
//   { "deckstudio": "bots/v1", "provider": "my-app", "name": "My App", "app": "com.example.myapp",
//     "bots": [ { "id", "name", "subtitle"?, "avatar"?, "unread"?, "awaiting"?, "hidden"?, "activityAt"?, "open"? } ] }
// avatar: { shape, color } | { image } | { logo } | { glyph } | { emoji }
// open:   { type: "url", url } | { type: "app", target: <bundle id> } | { type: "shell", cmd }
//
// Trust: a doc is data from another app, so what a press may do is the user's call, kept in
// profile.botProviders[{ id, enabled?, schemes?, allowShell? }] (never in the doc itself):
//   - only enabled providers show (Grok Bot and the user's own command providers are on by default);
//   - url: https always; another scheme only if the doc declares it in `schemes` AND the user allowed it;
//   - shell: only with allowShell; app: bundle ids only (open -b).

export const SHAPES = ['arch', 'bean', 'blob', 'capsule', 'cloud', 'clover', 'crystal', 'cylinder', 'dome', 'egg', 'flower', 'gem', 'heart', 'hex', 'house', 'leaf', 'pebble', 'pumpkin', 'shield', 'sparkle', 'square', 'squircle', 'star', 'tablet', 'teardrop', 'wedge']
export const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'brown', 'gray', 'black', 'white']
export const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{0,31}$/
export const MAX_BOTS = 200
export const GROK = { id: 'grokbot', name: 'Grok Bot', app: 'com.anysphere.sand', logo: 'app-grokbot', schemes: ['grokbot'] }
export const MAX_DOC = 2 << 20          // one limit: a provider file, a push, a command's output
export const MAX_INLINE_IMAGE = 256 << 10 // a data: avatar (decoded bytes); https avatars are fetched and shrunk
export const BUNDLE_RE = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/
const LAMP = '#e5484d'
const SHAPE_SET = new Set(SHAPES)
const COLOR_SET = new Set(COLORS)
const IMAGE_RE = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+={0,2}$/
const NAME_RE = /^[a-z0-9-]{1,80}$/
const GLYPH_RE = /^[A-Za-z0-9-]{1,80}$/ // Carbon has upper-case names (4K, AI, CSV…)
const SCHEME_RE = /^[a-z][a-z0-9+.-]{1,30}$/
const NEVER = new Set(['javascript', 'data', 'file', 'vbscript', 'blob', 'view-source', 'jar', 'about', 'filesystem']) // not even with the user's ok
const MAX_INLINE_URL = Math.ceil(MAX_INLINE_IMAGE / 3) * 4 + 32
const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter() : null
/** Cut to n UTF-16 units without splitting a grapheme (emoji, flags, combining marks). */
function cut(s, n) {
  if (s.length <= n) return s
  if (!seg) return s.slice(0, n)
  let out = ''
  for (const { segment } of seg.segment(s)) { if (out.length + segment.length > n) break; out += segment }
  return out
}
const str = (v, n) => (v == null || typeof v === 'object' ? '' : cut(String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim(), n))
export const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)))
/** ISO string, ms number or a numeric string → ms (0 if none). */
export function activityMs(v) {
  const n = typeof v === 'string' ? (/^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : Date.parse(v)) : Number(v)
  return Number.isFinite(n) && n > 0 && n < 1e14 ? n : 0
}
const schemeOf = u => u.slice(0, u.indexOf(':')).toLowerCase()

/** "Grok Bot" / "my app" → a provider id ("grok-bot", "my-app"). */
export function providerId(v, fallback = 'bots') {
  const id = String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return PROVIDER_RE.test(id) ? id : fallback
}
/** A stable color for a provider with no avatar of its own. */
export function providerColor(p) {
  let h = 0
  for (const c of String(p)) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % 10] // skip black/white
}
const safeUrl = u => /^[a-z][a-z0-9+.-]{1,30}:/i.test(u) && !NEVER.has(schemeOf(u))
const httpsOk = u => { try { const x = new URL(u); return x.protocol === 'https:' && !x.username && !x.password && u.length <= 2000 } catch { return false } }

function normAvatar(raw, r) {
  const a = raw && typeof raw === 'object' ? raw : {}
  const s = typeof raw === 'string' ? raw : ''
  const im = a.image ?? a.imageUrl ?? r.imageUrl ?? (/^(data:|https:)/.test(s) ? s : '')
  const image = typeof im === 'string' ? im.trim() : ''
  // checked once here (data URLs up to MAX_INLINE_IMAGE), so drawing never re-scans them
  if (image && (image.startsWith('data:') ? image.length <= MAX_INLINE_URL && IMAGE_RE.test(image) : httpsOk(image))) return { image }
  const logo = str(a.logo ?? r.logo, 80).toLowerCase()
  if (logo && NAME_RE.test(logo)) return { logo }
  const glyph = str(a.glyph ?? r.glyph, 80)
  if (glyph && GLYPH_RE.test(glyph)) return { glyph }
  const emoji = str(a.emoji ?? r.emoji, 8)
  if (emoji) return { emoji }
  const shape = str(a.shape ?? r.shape ?? r.avatarShape, 20)
  const color = str(a.color ?? r.color ?? r.avatarColor, 20).toLowerCase()
  if (shape || color) {
    return { shape: SHAPE_SET.has(shape) ? shape : 'blob', color: COLOR_SET.has(color) || /^#[0-9a-f]{6}$/.test(color) ? color : 'black' }
  }
  return null
}
function normOpen(o) {
  if (!o || typeof o !== 'object') return typeof o === 'string' && safeUrl(o) ? { type: 'url', url: str(o, 2000) } : null
  const type = String(o.type || (o.url ? 'url' : o.target ? 'app' : o.cmd ? 'shell' : ''))
  if (type === 'url') { const url = str(o.url, 2000); return safeUrl(url) ? { type, url } : null }
  if (type === 'app') { const target = str(o.target, 200); return BUNDLE_RE.test(target) ? { type, target } : null }
  if (type === 'shell') { const cmd = str(o.cmd, 2000); return cmd ? { type, cmd } : null }
  return null
}

/** One bot from any provider, cleaned. Also takes Grok Bot's export rows (shape/color at the top). */
export function normalizeBot(r, provider, i = 0) {
  if (!r || typeof r !== 'object') return null
  const full = str(r.fullName || r.name, 120)
  const id = typeof r.id === 'string' || Number.isFinite(r.id) ? str(r.id, 128) : ''
  if (!full || !id) return null // id and name are required
  const name = str(full.split(' · ')[0], 60) || full
  const subtitle = str(r.subtitle, 60)
  const bot = {
    key: `${provider}:${id}`, id, provider, name, fullName: subtitle ? `${name} · ${subtitle}` : full,
    avatar: normAvatar(r.avatar, r) || (provider === GROK.id ? { shape: 'blob', color: 'black' } : null),
    unread: clampN(r.unread ?? r.unreadCount, 0, 999), awaiting: !!(r.awaiting ?? r.awaitingUserResponse), hidden: !!r.hidden,
    activityAt: activityMs(r.activityAt),
    open: normOpen(r.open) || (provider === GROK.id && /^[0-9a-f-]{8,64}$/i.test(id) ? { type: 'url', url: `grokbot://app/v1/agent?id=${encodeURIComponent(id)}` } : null),
  }
  if (bot.avatar?.shape) { bot.shape = bot.avatar.shape; bot.color = bot.avatar.color } // older editors read these
  return bot
}

/**
 * Parse anything a bot app may hand us into provider docs:
 * a provider doc, { providers: [docs] }, an array of docs, Grok Bot's export ({ grokbots: 1, bots }),
 * or a bare array of bots (filed under `fallback`).
 */
/** The raw docs in any accepted shape: [{ provider, doc, rows }], rows being the doc's own (mutable) bots array. */
export function splitDocs(d, fallback = 'bots') {
  let docs
  if (Array.isArray(d)) docs = d.length && d.every(x => x && Array.isArray(x.bots)) ? d : [{ provider: fallback, bots: d }]
  else if (d && Array.isArray(d.providers)) docs = d.providers
  else if (d && Array.isArray(d.bots)) docs = [d.grokbots ? { ...d, provider: GROK.id } : d]
  else throw new Error('expected {"provider": …, "bots": [ … ]}')
  return docs.slice(0, 20).filter(x => x && typeof x === 'object').map(doc => ({ provider: providerId(doc.provider ?? doc.id ?? doc.name, fallback), doc, rows: Array.isArray(doc.bots) ? doc.bots : [] }))
}
export function parseBotDocs(input, fallback = 'bots') {
  const d = typeof input === 'string' ? JSON.parse(input) : input
  const out = splitDocs(d, fallback).map(({ provider, doc, rows }) => {
    const bots = []
    const seen = new Set()
    for (const [i, r] of rows.slice(0, MAX_BOTS).entries()) {
      const b = normalizeBot(r, provider, i)
      if (b && !seen.has(b.id)) { seen.add(b.id); bots.push(b) }
    }
    const isGrok = provider === GROK.id
    const app = str(doc.app, 200)
    const schemes = [...new Set((Array.isArray(doc.schemes) ? doc.schemes : []).map(x => String(x).toLowerCase().replace(/:$/, '')))].filter(x => SCHEME_RE.test(x) && !NEVER.has(x) && x !== 'https').slice(0, 8)
    return {
      provider, name: str(doc.name, 40) || (isGrok ? GROK.name : provider),
      app: BUNDLE_RE.test(app) ? app : isGrok ? GROK.app : undefined,
      logo: NAME_RE.test(String(doc.logo || '')) ? doc.logo : isGrok ? GROK.logo : undefined,
      ...(schemes.length ? { schemes } : {}),
      bots,
    }
  })
  if (!out.some(x => x.bots.length)) throw new Error('no bots found (each needs at least a name)')
  return out
}

/** Matches a key's `bot` ref: "provider:id", or (older profiles) a bare Grok bot id or name. */
export function findBot(bots, ref) {
  const r = String(ref ?? '').trim()
  if (!r) return null
  const lo = r.toLowerCase()
  const byKey = bots.find(b => b.key === r)
  if (byKey) return byKey
  const m = /^([a-z0-9][a-z0-9-]{0,31}):(.+)$/.exec(r)
  if (m) {
    const inP = bots.filter(b => b.provider === m[1]), x = m[2].toLowerCase()
    const hit = inP.find(b => b.id === m[2]) || inP.find(b => b.name.toLowerCase() === x || b.fullName.toLowerCase() === x)
    if (hit) return hit
  }
  // a bare id / name is an older Grok Bot ref only: another provider can't claim it by naming a bot alike
  const grok = bots.filter(b => b.provider === GROK.id)
  return grok.find(b => b.id === r) || grok.find(b => b.name.toLowerCase() === lo || b.fullName.toLowerCase() === lo) || null
}
const pinIndex = (pins, b) => pins.findIndex(p => p === b.key.toLowerCase() || (b.provider === GROK.id && (p === b.id.toLowerCase() || p === b.name.toLowerCase() || p === b.fullName.toLowerCase())))

/** What a page shows: only `providers` (empty = all); pinned refs in their order, else waiting first, then recent. */
export function listBots(bots, { providers = [], pins = [] } = {}) {
  const want = (Array.isArray(providers) ? providers : []).map(String).filter(Boolean)
  const pool = want.length ? bots.filter(b => want.includes(b.provider)) : bots
  const ps = (Array.isArray(pins) ? pins : []).map(p => String(p).toLowerCase())
  if (ps.length) return pool.filter(b => pinIndex(ps, b) >= 0).sort((a, b) => pinIndex(ps, a) - pinIndex(ps, b))
  const score = b => (b.awaiting ? 2 : 0) + (b.unread ? 1 : 0)
  return pool.filter(b => !b.hidden).sort((a, b) => score(b) - score(a) || b.activityAt - a.activityAt)
}
export const isWaiting = b => !b.hidden && (b.awaiting || b.unread > 0)

/** The key face for a bot (avatar, name, unread badge, red lamp while it waits on you). */
export function botFace(b, { image } = {}) {
  const needs = b.awaiting || b.unread > 0
  const a = b.avatar || { shape: 'blob', color: providerColor(b.provider) }
  const img = a.image && (a.image.startsWith('data:') ? a.image : image) // data URLs were validated by normalizeBot
  const icon = a.shape || (a.image && !img)
    ? { sprite: `grokbot/bot-${a.shape || 'blob'}-face`, spriteColor: a.color || providerColor(b.provider), spriteMode: needs ? 'loop' : 'blink' }
    : img ? { image: img } : a.logo ? { logo: a.logo } : a.glyph ? { glyph: a.glyph } : { icon: a.emoji }
  return {
    ...icon, motion: b.awaiting ? 'shake' : needs ? 'bob' : undefined,
    label: b.name, title: b.awaiting ? 'waiting on you' : b.unread ? `${b.unread} new` : '', badge: b.unread ? String(b.unread) : undefined,
    led: needs, ledColor: LAMP, tone: b.awaiting ? 'black' : 'paper',
  }
}

/** A small preview image for the editor's bot chips (null: show the emoji). */
export function botThumb(b, logoUrl = n => `/logos/${n}.png`) {
  const a = b.avatar || { shape: 'blob', color: providerColor(b.provider) }
  if (a.image) return a.image.startsWith('data:') ? a.image : `/botavatar/blob-${providerColor(b.provider)}.png`
  if (a.logo) return logoUrl(a.logo)
  if (a.glyph) return `/glyphs/${a.glyph}.svg`
  if (a.emoji) return null
  return `/botavatar/${a.shape || 'blob'}-${COLOR_SET.has(a.color) ? a.color : 'gray'}.png`
}

/** What the user allowed a provider (profile.botProviders[{ id, enabled, schemes, allowShell }]), given the doc's declared schemes. */
export function providerTrust(list, id, declared = []) {
  const c = (Array.isArray(list) ? list : []).find(x => x && x.id === id) || {}
  const ok = Array.isArray(c.schemes) ? c.schemes.map(x => String(x).toLowerCase()) : []
  return {
    enabled: typeof c.enabled === 'boolean' ? c.enabled : id === GROK.id || c.type === 'command',
    allowShell: c.allowShell === true,
    schemes: id === GROK.id ? GROK.schemes : (declared || []).filter(x => ok.includes(x) && !NEVER.has(x)),
  }
}
/** What a press on this bot does: { kind: url|app|shell|none, url?, target?, cmd?, blocked? }. */
export function botPress(b, trust = {}, app) {
  const o = b.open
  if (o?.type === 'url') {
    const sc = schemeOf(o.url)
    return sc === 'https' || (trust.schemes || []).includes(sc) ? { kind: 'url', url: o.url } : { kind: 'url', url: o.url, blocked: `${sc}: links are off until you allow them for this provider` }
  }
  if (o?.type === 'app') return { kind: 'app', target: o.target }
  if (o?.type === 'shell') return trust.allowShell ? { kind: 'shell', cmd: o.cmd } : { kind: 'shell', cmd: o.cmd, blocked: 'shell commands are off until you trust this provider' }
  return app ? { kind: 'app', target: app } : { kind: 'none' }
}
export function pressText(p) {
  const what = p.kind === 'url' ? `opens ${p.url.length > 60 ? p.url.slice(0, 59) + '…' : p.url}` : p.kind === 'app' ? `opens app ${p.target}` : p.kind === 'shell' ? `runs shell: ${p.cmd.slice(0, 60)}` : 'does nothing'
  return p.blocked ? `${what} — blocked: ${p.blocked}` : what
}
/** "2 bots open https links · 1 needs shell (blocked until you trust this provider)" */
export function pressSummary(presses) {
  const n = {}
  for (const p of presses) {
    const k = p.kind === 'url' ? `${p.blocked ? '!' : ''}${schemeOf(p.url)}` : `${p.blocked ? '!' : ''}${p.kind}`
    n[k] = (n[k] || 0) + 1
  }
  return Object.entries(n).map(([k, c]) => {
    const blocked = k.startsWith('!'), w = k.replace(/^!/, ''), one = c === 1
    const bots = `${c} bot${one ? '' : 's'}`, v = (s, p) => `${bots} ${one ? s : p}`
    if (w === 'shell') return blocked ? `${v('needs', 'need')} shell (blocked until you trust this provider)` : `${v('runs', 'run')} shell commands`
    if (w === 'app') return `${v('opens', 'open')} an app`
    if (w === 'none') return `${v('does', 'do')} nothing on press`
    return blocked ? `${v('opens', 'open')} ${w}: links (blocked until you allow ${w}:)` : `${v('opens', 'open')} ${w} links`
  }).join(' · ')
}
/** POST /api/bots/status values, coerced: { unread?, awaiting?, hidden?, activityAt? } */
export function cleanStatus(b) {
  const o = {}
  if (b && 'unread' in b) o.unread = clampN(b.unread, 0, 999)
  for (const k of ['awaiting', 'hidden']) if (b && k in b) o[k] = b[k] === true
  if (b && 'activityAt' in b && activityMs(b.activityAt)) o.activityAt = activityMs(b.activityAt)
  return o
}

/** The schema example shown in the editor and docs. */
export const EXAMPLE_DOC = {
  deckstudio: 'bots/v1',
  provider: 'my-bot-app',
  name: 'My Bot App',
  app: 'com.example.mybotapp',
  schemes: ['mybotapp'], // url schemes besides https its bots open (the user still has to allow them)
  bots: [
    { id: 'support', name: 'Support', subtitle: 'inbox triage', avatar: { shape: 'blob', color: 'violet' }, unread: 2, awaiting: false, open: { type: 'url', url: 'mybotapp://bots/support' } },
    { id: 'builder', name: 'Builder', avatar: { glyph: 'tool-kit' }, awaiting: true, open: { type: 'app', target: 'com.example.mybotapp' } },
    { id: 'notes', name: 'Notes', avatar: { emoji: '📝' }, activityAt: '2026-01-01T12:00:00Z' },
  ],
}
