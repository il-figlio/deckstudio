// SPEC-01 "hardware" look for the Stream Deck+ itself: keys drawn as off-white keycaps
// standing in a dotted panel with mono lowercase legends, Carbon glyphs and LED lamps; the
// touch strip drawn as the kit's gray reflective LCD with dark print and ghost segments.
// Mirrors editor/src/components/ui/hardware/*.css (tokens, lcd, field) so device == editor.
import { VAR_RE } from './plugin-schema.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createCanvas, GlobalFonts, loadImage, ImageData } from '@napi-rs/canvas'
import omggif from 'omggif'
import { dialReadonly } from './dial-rules.mjs'

const require = createRequire(import.meta.url)
// Where assets/ lives. A browser build sets globalThis.__DECK_ASSET_ROOT__ (see editor/src/demo).
const ROOT_DIR = globalThis.__DECK_ASSET_ROOT__ ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..')
const KEY = 120, W = 800, H = 100, SEG = 200

// ---- fonts: IBM Plex Mono, as the kit uses ----
const plexDir = path.join(path.dirname(require.resolve('@ibm/plex-mono/package.json')), 'fonts/complete/woff2')
for (const f of ['ExtraLight', 'Light', 'Regular', 'Medium', 'SemiBold']) {
  try { GlobalFonts.registerFromPath(path.join(plexDir, `IBMPlexMono-${f}.woff2`), 'Plex Mono') } catch {}
}
const mono = (weight, size) => `${weight} ${size}px "Plex Mono", "SF Mono", Menlo, "Apple Color Emoji"`

// ---- palette (tokens.css / hardware.css / hardware-lcd.css) ----
export const SPEC = {
  paper: '#efefeb', metal: '#e2e2dd', hair: '#c8c8c2', ink: '#1b1b19', dim: '#8a8a84',
  glass: ['#b6b7b1', '#c8c9c3', '#c2c3bd'], grayInk: '#141413', grayDim: 'rgba(20,20,19,0.6)', ghost: 'rgba(20,20,19,0.075)',
  ledOff: '#c4c4be', green: '#22a05a',
}
const TONES = {
  paper: { cap: ['#fbfbf9', '#ececE8'], edge: '#d2d2cc', ink: SPEC.ink, dim: SPEC.dim },
  black: { cap: ['#34332f', '#1a1918'], edge: '#0b0b0a', ink: '#f4f4f0', dim: 'rgba(244,244,240,0.55)' },
}

// ---- Carbon glyphs (2,600+ icons, by name: "rocket", "play--filled--alt", "volume--up") ----
const carbonDir = path.join(path.dirname(require.resolve('@carbon/icons/package.json')), 'svg/32')
// DeckStudio's own glyphs (app icons etc., drawn with currentColor) take precedence over Carbon.
export const customGlyphDir = path.join(ROOT_DIR, 'assets/glyphs')
const glyphCache = new Map()
// exact names (Carbon has 4K, AI, CSV…; the Mac's file system would also match "4k"). The browser
// demo's fs has no readdir: there, existsSync is already exact.
const svgSet = d => { try { return new Set(fs.readdirSync(d).filter(f => f.endsWith('.svg')).map(f => f.slice(0, -4))) } catch { return null } }
const GLYPH_DIRS = [[customGlyphDir, svgSet(customGlyphDir)], [carbonDir, svgSet(carbonDir)]]
export function glyphFile(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9-]{1,80}$/.test(name)) return null
  for (const [d, set] of GLYPH_DIRS) { const f = path.join(d, name + '.svg'); if (set ? set.has(name) : fs.existsSync(f)) return f }
  return null
}
export function glyphExists(name) { return !!glyphFile(name) }
async function glyph(name, color) {
  const file = glyphFile(name)
  if (!file) return null
  const k = name + color
  if (!glyphCache.has(k)) {
    if (glyphCache.size > 400) glyphCache.clear()
    const raw = fs.readFileSync(file, 'utf8').replace(/currentColor/g, color)
    const root = /<svg[^>]*>/.exec(raw)?.[0] || ''
    // Carbon icons are bare fills (no fill attr: give them the color); ours declare their own
    const svg = raw.replace('<svg', `<svg width="128" height="128"${/\sfill=/.test(root) ? '' : ` fill="${color}"`}`)
      .replace(/<rect[^>]*data-name="&lt;Transparent Rectangle&gt;"[^>]*\/>/g, '')
    glyphCache.set(k, loadImage(Buffer.from(svg)).catch(() => null))
  }
  return glyphCache.get(k)
}

// ---- helpers ----
function rr(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}
function grad(ctx, y0, y1, stops) {
  const g = ctx.createLinearGradient(0, y0, 0, y1)
  stops.forEach((c, i) => g.addColorStop(stops.length === 1 ? 0 : i / (stops.length - 1), c))
  return g
}
function fit(ctx, text, weight, size, maxW, min = 9) {
  for (let s = size; s >= min; s--) { ctx.font = mono(weight, s); if (ctx.measureText(text).width <= maxW) return s }
  ctx.font = mono(weight, min)
  let t = text; while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1)
  return { size: min, text: t + '…' }
}
function fitText(ctx, text, weight, size, maxW, min) {
  const r = fit(ctx, text, weight, size, maxW, min)
  return typeof r === 'number' ? { size: r, text } : r
}
// deterministic matte grain, like --tex-matte
function grain(ctx, w, h, alpha, seed = 7) {
  let s = seed
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647)
  ctx.fillStyle = `rgba(255,255,255,${alpha})`
  for (let i = 0; i < (w * h) / 26; i++) ctx.fillRect(rnd() * w, rnd() * h, 1, 1)
  ctx.fillStyle = `rgba(0,0,0,${alpha * 0.8})`
  for (let i = 0; i < (w * h) / 30; i++) ctx.fillRect(rnd() * w, rnd() * h, 1, 1)
}
// dark print that floats above the reflective backing (--lcd-print)
function printText(ctx, text, x, y, color = SPEC.grayInk) {
  ctx.fillStyle = 'rgba(20,20,19,0.14)'; ctx.fillText(text, x + 0.5, y + 1.5)
  ctx.fillStyle = color; ctx.fillText(text, x, y)
}
const ghostOf = s => String(s).replace(/[0-9]/g, '8')
const isDigitsish = s => /^[\s\d.:,%+\-/°]+$/.test(String(s)) && /\d/.test(String(s))
const lower = s => String(s ?? '').toLowerCase()
function lightness(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return 0.3
  const n = parseInt(m[1], 16); const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map(v => v / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function shade(hex, k) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || ''); if (!m) return hex
  const n = parseInt(m[1], 16)
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.max(0, Math.min(255, Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k))))
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')
}
function led(ctx, x, y, on, color) {
  ctx.beginPath(); ctx.arc(x, y, 4, 0, Math.PI * 2)
  if (on) {
    ctx.save(); ctx.shadowColor = color; ctx.shadowBlur = 8; ctx.fillStyle = color; ctx.fill(); ctx.restore()
    ctx.beginPath(); ctx.arc(x - 1, y - 1, 1.3, 0, Math.PI * 2); ctx.fillStyle = 'rgba(255,255,255,0.7)'; ctx.fill()
  } else {
    ctx.fillStyle = SPEC.ledOff; ctx.fill()
    ctx.beginPath(); ctx.arc(x, y + 0.6, 3.4, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.lineWidth = 1; ctx.stroke()
  }
}
function glassFill(ctx, x, y, w, h, r) {
  ctx.save(); rr(ctx, x, y, w, h, r); ctx.clip()
  ctx.fillStyle = grad(ctx, y, y + h, [SPEC.glass[0], SPEC.glass[1], SPEC.glass[2]]); ctx.fillRect(x, y, w, h)
  ctx.translate(x, y); grain(ctx, w, h, 0.05, Math.round(w + h)); ctx.translate(-x, -y)
  // the well: shadow along the top, light lip at the bottom
  ctx.fillStyle = grad(ctx, y, y + 6, ['rgba(0,0,0,0.22)', 'rgba(0,0,0,0)']); ctx.fillRect(x, y, w, 6)
  ctx.restore()
  ctx.save(); rr(ctx, x + 0.5, y + 0.5, w - 1, h - 1, r); ctx.strokeStyle = 'rgba(0,0,0,0.16)'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore()
}
// Genuine logos / app icons (name → .png or .svg), full color, never recolored. Shipped ones live in
// assets/logos; icons made on this Mac (pulled from installed apps, saved from Icon Studio) live in
// ~/.deckstudio/logos, outside the repo, and win on a name clash. The browser demo has only the shipped ones.
export const logoDir = path.join(ROOT_DIR, 'assets/logos')
export const userLogoDir = globalThis.__DECK_ASSET_ROOT__ ? null
  : path.join(process.env.DECKSTUDIO_HOME || path.join(process.env.HOME || '', '.deckstudio'), 'logos')
const logoCache = new Map()
export function logoFile(name) {
  if (typeof name !== 'string' || !/^[a-z0-9-]+$/.test(name)) return null
  for (const dir of [userLogoDir, logoDir]) if (dir) for (const ext of ['.png', '.svg']) { const f = path.join(dir, name + ext); if (fs.existsSync(f)) return f }
  return null
}
async function logo(name) {
  const f = logoFile(name)
  if (!f) return null
  const k = f + '@' + fs.statSync(f).mtimeMs // re-saved logos get a new key
  if (!logoCache.has(k)) {
    let src = fs.readFileSync(f)
    if (f.endsWith('.svg')) src = Buffer.from(String(src).replace('<svg', '<svg width="256" height="256"'))
    for (const o of logoCache.keys()) if (o.startsWith(f + '@')) logoCache.delete(o)
    logoCache.set(k, loadImage(src).catch(() => null))
  }
  return logoCache.get(k)
}
// ---- animation: animated GIF uploads, sprite strips, and motions ----
const gifCache = new Map(), GIF_MAX = 240, GIF_FRAME_BYTES = 40e6, GIF_CACHE_BYTES = 160e6
let gifBytes = 0
// area-average RGBA downscale (alpha-weighted)
function boxScale(src, w, h, dst, fw, fh) {
  const sx = Math.max(1, Math.round(w / fw / 2)), sy = Math.max(1, Math.round(h / fh / 2)) // ~2x2 samples per output pixel
  for (let y = 0; y < fh; y++) {
    const y0 = Math.floor(y * h / fh), y1 = Math.max(y0 + 1, Math.floor((y + 1) * h / fh))
    for (let x = 0; x < fw; x++) {
      const x0 = Math.floor(x * w / fw), x1 = Math.max(x0 + 1, Math.floor((x + 1) * w / fw))
      let r = 0, g = 0, b = 0, a = 0, n = 0
      for (let yy = y0; yy < y1; yy += sy) for (let xx = x0, i = (yy * w + x0) * 4; xx < x1; xx += sx, i += 4 * sx) { const al = src[i + 3]; r += src[i] * al; g += src[i + 1] * al; b += src[i + 2] * al; a += al; n++ }
      const o = (y * fw + x) * 4
      if (a) { dst[o] = r / a; dst[o + 1] = g / a; dst[o + 2] = b / a; dst[o + 3] = a / n } else dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0
    }
  }
}
function gifFrames(src) {
  if (gifCache.has(src)) { const e = gifCache.get(src); gifCache.delete(src); gifCache.set(src, e); return e.out } // LRU touch
  let out = null, bytes = 0
  try {
    const r = new omggif.GifReader(Buffer.from(src.slice(src.indexOf(',') + 1), 'base64'))
    const w = r.width, h = r.height, n = Math.min(r.numFrames(), 120)
    if (n > 1 && w <= 800 && h <= 800) {
      // the accumulator stays native-size; only downscaled frames are kept (keys are 120px)
      const s = Math.min(1, GIF_MAX / Math.max(w, h)), fw = Math.max(1, Math.round(w * s)), fh = Math.max(1, Math.round(h * s))
      const acc = new Uint8ClampedArray(w * h * 4), frames = [], small = new ImageData(fw, fh)
      let total = 0
      for (let i = 0; i < n && (i + 1) * fw * fh * 4 <= GIF_FRAME_BYTES; i++) {
        const info = r.frameInfo(i)
        const before = info.disposal === 3 ? acc.slice() : null
        r.decodeAndBlitFrameRGBA(i, acc)
        boxScale(acc, w, h, small.data, fw, fh) // (canvas-to-canvas drawImage retains a snapshot of the 800px source per call)
        const c = createCanvas(fw, fh); c.getContext('2d').putImageData(small, 0, 0)
        const delay = Math.max(20, (info.delay || 10) * 10)
        frames.push({ c, at: total, delay }); total += delay; bytes += fw * fh * 4
        if (info.disposal === 2) for (let y = info.y; y < info.y + info.height; y++) acc.fill(0, (y * w + info.x) * 4, (y * w + info.x + info.width) * 4)
        else if (before) acc.set(before)
      }
      if (frames.length > 1) out = { frames, total }
    }
  } catch {}
  bytes += src.length // the cache key keeps the source string alive too
  gifCache.set(src, { out, bytes }); gifBytes += bytes
  while (gifBytes > GIF_CACHE_BYTES && gifCache.size > 1) { const [k, e] = gifCache.entries().next().value; gifCache.delete(k); gifBytes -= e.bytes }
  return out
}
export function isAnimatedGif(src) { return typeof src === 'string' && src.startsWith('data:image/gif') && !!gifFrames(src) }

// Sprite strips (e.g. Grok Bot's own blinking avatars): frames laid out horizontally, square.
const assetDir = path.join(ROOT_DIR, 'assets')
const spriteCache = new Map()
export function spriteFile(name) {
  if (typeof name !== 'string' || !/^[a-z0-9-]+(\/[a-z0-9-]+)?$/.test(name)) return null
  const f = path.join(assetDir, name + '.png')
  return fs.existsSync(f) ? f : null
}
async function spriteFrame(name, color, t, mode = 'blink', fps = 14) {
  const f = spriteFile(name)
  if (!f) return null
  if (!spriteCache.has(f)) spriteCache.set(f, loadImage(fs.readFileSync(f)).catch(() => null))
  const img = await spriteCache.get(f)
  if (!img) return null
  const size = img.height, n = Math.max(1, Math.floor(img.width / size))
  let i = 0
  if (mode === 'loop') i = Math.floor((t / 1000) * fps) % n
  else if (mode === 'blink' && t) { const cycle = 4200, at = t % cycle; i = at < (n / fps) * 1000 ? Math.floor((at / 1000) * fps) % n : 0 }
  const c = createCanvas(size, size), x = c.getContext('2d')
  x.drawImage(img, i * size, 0, size, size, 0, 0, size, size)
  if (color) { x.globalCompositeOperation = 'source-in'; x.fillStyle = color; x.fillRect(0, 0, size, size) }
  return c
}
/** A still avatar for previews (editor bot picker). */
export async function spriteThumb(name, color, size = 96) {
  const f = await spriteFrame(name, SPRITE_COLORS[color] || color || '#1b1b19', 0, 'still')
  if (!f) return null
  const c = createCanvas(size, size); c.getContext('2d').drawImage(f, 0, 0, size, size)
  return c.toBuffer('image/png')
}
/** Run draw() with a motion applied around (cx, cy). */
function withMotion(ctx, motion, t, cx, cy, draw) {
  if (!motion || !t) return draw()
  const s = t / 1000
  ctx.save()
  ctx.translate(cx, cy)
  switch (motion) {
    case 'bob': ctx.translate(0, Math.sin(s * 3.2) * 4); break
    case 'pulse': { const k = 1 + Math.sin(s * 5) * 0.07; ctx.scale(k, k); break }
    case 'breathe': ctx.globalAlpha = 0.65 + 0.35 * (0.5 + 0.5 * Math.sin(s * 2.4)); break
    case 'shake': ctx.rotate(Math.sin(s * 28) * 0.09 * (Math.sin(s * 2) > 0.3 ? 1 : 0)); break
    case 'spin': ctx.rotate(s * 2.4); break
    case 'flicker': { const k = 1 + (Math.sin(s * 17) * Math.sin(s * 7.3)) * 0.05; ctx.scale(k, 1 + (k - 1) * 1.6); ctx.globalAlpha = 0.85 + 0.15 * Math.abs(Math.sin(s * 11)); break }
  }
  ctx.translate(-cx, -cy)
  draw()
  ctx.restore()
}
export const SPRITE_COLORS = { red: '#e5484d', orange: '#f76b15', yellow: '#e2a336', green: '#30a46c', cyan: '#05a2c2', blue: '#0090ff', violet: '#6e56cf', magenta: '#d6409f', brown: '#a07553', gray: '#6f6e77', black: '#1b1b19', white: '#f4f4f0' }

export async function getImage(src, t = 0) { // exported for the cache test
  if (typeof src === 'string' && src.startsWith('data:image/gif')) {
    const g = gifFrames(src)
    if (g) { const at = (t || 0) % g.total; return (g.frames.find(f => at < f.at + f.delay) || g.frames[0]).c }
  }
  if (typeof src !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(src.slice(0, 32))) return null
  // decoded once per data URL (a Map hashes a string once), not every frame; a small LRU
  let img = imageCache.get(src)
  if (img) imageCache.delete(src)
  else img = loadImage(src).catch(() => null)
  imageCache.set(src, img)
  if (imageCache.size > 48) imageCache.delete(imageCache.keys().next().value)
  return img
}
const imageCache = new Map()

// ============================== keys ==============================
/**
 * key: { face: 'cap'|'lcd'|'screen', tone: 'paper'|'black'|'key', glyph, icon, label, title, image,
 *        bg (custom cap color), fg, led (bool), progress, accent }
 */
export async function renderKeySpec(key = {}, theme = {}, opts = {}) {
  const c = createCanvas(KEY, KEY), ctx = c.getContext('2d')
  const vars = opts.vars || {}
  const tpl = s => String(s ?? '').replace(VAR_RE, (m, k) => (vars[k] ?? m))
  const accent = key.accent || theme.accent || '#7c5cff'
  const pressed = !!opts.pressed
  const label = lower(tpl(key.label)), title = lower(tpl(key.title))
  const t = opts.t || 0
  const img = await getImage(key.image, t)
  const face = key.face || (img ? 'screen' : 'cap')
  // lamps can follow live data: led: "{agents_needs}" is lit when that value isn't 0/empty
  const ledOn = typeof key.led === 'string' ? !['', '0', 'false', 'off', 'no'].includes(tpl(key.led).trim().toLowerCase()) : !!key.led

  // the panel the key stands in: paper with the kit's dot grid
  ctx.fillStyle = SPEC.paper; ctx.fillRect(0, 0, KEY, KEY)
  ctx.fillStyle = 'rgba(0,0,0,0.13)'
  for (let y = 4; y < KEY; y += 10) for (let x = 4; x < KEY; x += 10) { ctx.beginPath(); ctx.arc(x, y, 0.8, 0, Math.PI * 2); ctx.fill() }
  // the hole
  rr(ctx, 5, 4, 110, 112, 18); ctx.fillStyle = '#262624'; ctx.fill()

  const sink = pressed ? 3 : 0
  const cx = 8, cy = 6 + sink, cw = 104, ch = 102 - sink
  // tone
  let tone = TONES[key.tone] || TONES.paper
  if (key.tone === 'key' || (key.bg && typeof key.bg === 'string')) {
    const base = key.tone === 'key' ? accent : key.bg
    const light = lightness(base) > 0.62
    tone = { cap: [shade(base, 0.12), shade(base, -0.08)], edge: shade(base, -0.35), ink: light ? SPEC.ink : '#ffffff', dim: light ? 'rgba(27,27,25,0.55)' : 'rgba(255,255,255,0.65)' }
  }
  const ink = key.fg || tone.ink

  // key edge (lip) then cap
  rr(ctx, cx, cy + 4, cw, ch - 4, 15); ctx.fillStyle = tone.edge; ctx.fill()
  rr(ctx, cx, cy, cw, ch - (pressed ? 1 : 5), 15)
  ctx.fillStyle = Array.isArray(key.bg) ? grad(ctx, cy, cy + ch, key.bg) : grad(ctx, cy, cy + ch, tone.cap); ctx.fill()
  ctx.save(); rr(ctx, cx + 0.5, cy + 0.5, cw - 1, ch - 6, 15); ctx.strokeStyle = 'rgba(255,255,255,0.55)'; ctx.lineWidth = 1; ctx.stroke(); ctx.restore()

  const ix = cx + 10, iw = cw - 20 // inner print area
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'

  if (face === 'agent') {
    // Built to be read in a glance: who (genuine app logo), how it's doing (status pill),
    // what about (topic glyph), and the task itself in two big lines.
    const st = key.status || {}
    const urgent = !!st.urgent
    const capInk = urgent ? '#ffffff' : ink
    if (urgent) { rr(ctx, cx, cy, cw, ch - (pressed ? 1 : 5), 15); ctx.fillStyle = grad(ctx, cy, cy + ch, [st.blinkOff ? '#2a2a28' : '#ef5a5f', st.blinkOff ? '#151514' : '#c9363b']); ctx.fill() }
    const lg = await logo(key.logo)
    if (lg) {
      ctx.save(); rr(ctx, cx + 8, cy + 8, 26, 26, 7); ctx.clip(); ctx.drawImage(lg, cx + 8, cy + 8, 26, 26); ctx.restore()
    }
    // topic glyph, beside the logo
    const tg = await glyph(key.topic, capInk)
    if (tg) ctx.drawImage(tg, cx + (lg ? 40 : 9), cy + 10, 22, 22)
    // task title: full width, as big as fits in two lines (three when it must)
    const words = lower(tpl(key.label)).split(/\s+/).filter(Boolean)
    const maxW = cw - 18
    let size = 17, lines = []
    for (; size >= 10; size--) {
      ctx.font = mono(600, size)
      lines = ['']
      for (const w of words) {
        const t = lines[lines.length - 1] ? lines[lines.length - 1] + ' ' + w : w
        if (ctx.measureText(t).width <= maxW || !lines[lines.length - 1]) lines[lines.length - 1] = t
        else lines.push(w)
      }
      const maxLines = Math.max(1, Math.floor(36 / (size + 3)))
      if (lines.length <= maxLines && lines.every(l => ctx.measureText(l).width <= maxW)) break
    }
    const cap = Math.max(1, Math.floor(36 / (size + 3)))
    if (lines.length > cap) { lines = lines.slice(0, cap); lines[cap - 1] = lines[cap - 1].replace(/\s*$/, '') + '…' } // cut: say so
    ctx.fillStyle = capInk
    const lh = size + 3, top = cy + 40 + size * 0.75
    lines.forEach((l, i) => { const f = fitText(ctx, l, 600, size, maxW, 8); ctx.font = mono(600, f.size); ctx.fillText(f.text, cx + 9, top + i * lh) })
    // bottom row: where (session) on the left, status pill on the right — nothing shares the top row with the logo
    ctx.font = mono(700, 10)
    const txt = String(st.text || '').toUpperCase()
    const pw = Math.min(56, ctx.measureText(txt).width + 12)
    const py = cy + ch - 26
    rr(ctx, cx + cw - pw - 7, py, pw, 17, 8.5)
    ctx.fillStyle = urgent ? '#ffffff' : st.color || '#8a8a84'; ctx.fill()
    ctx.fillStyle = urgent ? '#c9363b' : '#ffffff'; ctx.textAlign = 'center'
    ctx.font = mono(700, fitText(ctx, txt, 700, 10, pw - 6, 7).size); ctx.fillText(fitText(ctx, txt, 700, 10, pw - 6, 7).text, cx + cw - pw / 2 - 7, py + 12.5); ctx.textAlign = 'left'
    if (key.title) { const f = fitText(ctx, lower(key.title), 500, 9, cw - pw - 24, 7); ctx.font = mono(500, f.size); ctx.fillStyle = urgent ? 'rgba(255,255,255,0.8)' : tone.dim; ctx.fillText(f.text, cx + 9, py + 12) }
    if (typeof st.progress === 'number') {
      ctx.fillStyle = urgent ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.08)'; ctx.fillRect(cx + 9, cy + ch - 8, cw - 18, 2.5)
      ctx.fillStyle = st.color || accent; ctx.fillRect(cx + 9, cy + ch - 8, (cw - 18) * Math.max(0, Math.min(1, st.progress / 100)), 2.5)
    }
    if (key.border) { ctx.save(); rr(ctx, cx + 2, cy + 2, cw - 4, ch - 9, 13); ctx.strokeStyle = key.border; ctx.lineWidth = 3; ctx.stroke(); ctx.restore() }
    return c
  }

  if (face === 'lcd' || face === 'screen') {
    // a window set into the cap: gray reflective lcd, or black glass for images
    const wx = cx + 7, wy = cy + 7, ww = cw - 14, wh = ch - 26
    if (face === 'lcd') glassFill(ctx, wx, wy, ww, wh, 8)
    else {
      ctx.save(); rr(ctx, wx, wy, ww, wh, 8); ctx.clip()
      ctx.fillStyle = '#0b0b0a'; ctx.fillRect(wx, wy, ww, wh)
      if (img) { const s = Math.max(ww / img.width, wh / img.height); ctx.drawImage(img, wx + (ww - img.width * s) / 2, wy + (wh - img.height * s) / 2, img.width * s, img.height * s) }
      const g = ctx.createRadialGradient(wx + ww / 2, wy + wh / 2, ww * 0.3, wx + ww / 2, wy + wh / 2, ww * 0.75)
      g.addColorStop(0, 'rgba(255,255,255,0)'); g.addColorStop(1, 'rgba(255,255,255,0.08)'); ctx.fillStyle = g; ctx.fillRect(wx, wy, ww, wh)
      ctx.restore()
    }
    const printInk = face === 'lcd' ? SPEC.grayInk : '#f4f4f0'
    if (title) { ctx.font = mono(500, 10); ctx.fillStyle = face === 'lcd' ? SPEC.grayDim : 'rgba(244,244,240,0.7)'; ctx.fillText(title.toUpperCase().split('').join(' '.repeat(0)), wx + 7, wy + 15) }
    const big = face === 'lcd' ? label || tpl(key.icon) : ''
    if (big) {
      const f = fitText(ctx, big, 300, key.fontSize || 34, ww - 12, 12)
      const ty = wy + wh / 2 + f.size * 0.36 + (title ? 5 : 0)
      ctx.font = mono(300, f.size)
      if (isDigitsish(f.text)) { ctx.fillStyle = SPEC.ghost; ctx.fillText(ghostOf(f.text), wx + 7, ty) }
      printText(ctx, f.text, wx + 7, ty, printInk)
    }
    // legend under the window
    const legend = face === 'lcd' ? lower(tpl(key.caption ?? '')) : label
    if (legend) { const f = fitText(ctx, legend, 500, 12, iw, 8); ctx.font = mono(500, f.size); ctx.fillStyle = ink; ctx.fillText(f.text, ix - 3, cy + ch - 12) }
    led(ctx, cx + cw - 12, cy + ch - 16, pressed || ledOn, key.ledColor || accent)
  } else {
    // a plain cap: title tag, glyph/emoji, lowercase legend, lamp
    if (title) { const f = fitText(ctx, title.toUpperCase(), 500, 10, iw - 16, 8); ctx.font = mono(500, f.size); ctx.fillStyle = tone.dim; ctx.fillText(f.text, ix, cy + 19) }
    led(ctx, cx + cw - 14, cy + 15, pressed || ledOn, key.ledColor || accent)
    const lg = await logo(key.logo)
    const g = lg ? null : await glyph(key.glyph, ink)
    const gs = key.iconSize || (lg ? (label ? (title ? 46 : 60) : title ? 60 : 76) : label ? (title ? 36 : 42) : 56)
    const gy = title ? cy + 25 : cy + (lg ? (label ? 7 : 12) : label ? 18 : 22)
    const sp = key.sprite ? await spriteFrame(key.sprite, SPRITE_COLORS[key.spriteColor] || key.spriteColor || ink, t, key.spriteMode) : null
    const icx = cx + cw / 2, icy = gy + gs / 2
    if (sp) {
      const ss = key.iconSize || (label ? (title ? 44 : 56) : title ? 58 : 72)
      withMotion(ctx, key.motion, t, icx, icy, () => ctx.drawImage(sp, cx + (cw - ss) / 2, gy + (gs - ss) / 2, ss, ss))
    } else if (lg) {
      withMotion(ctx, key.motion, t, icx, icy, () => {
        ctx.save(); ctx.shadowColor = 'rgba(0,0,0,0.25)'; ctx.shadowBlur = 4; ctx.shadowOffsetY = 1.5
        ctx.drawImage(lg, cx + (cw - gs) / 2, gy, gs, gs); ctx.restore()
      })
    } else if (g) withMotion(ctx, key.motion, t, icx, icy + 2, () => ctx.drawImage(g, cx + (cw - gs) / 2, gy + (label ? 0 : 4), gs, gs))
    else if (key.icon) {
      const t = tpl(key.icon)
      const emojiish = /\p{Extended_Pictographic}/u.test(t)
      const f = fitText(ctx, emojiish ? t : lower(t), emojiish ? 400 : 300, key.iconSize || (label ? 40 : 52), iw, 12)
      ctx.font = mono(emojiish ? 400 : 300, f.size); ctx.textAlign = 'center'
      ctx.fillStyle = ink; ctx.fillText(f.text, cx + cw / 2, gy + gs / 2 + f.size * 0.36); ctx.textAlign = 'left'
    }
    if (label) {
      if (!g && !lg && !sp && !key.icon) {
        // label-only key: the legend is the face, large and light
        const f = fitText(ctx, label, 300, key.fontSize || 26, iw, 10)
        ctx.font = mono(300, f.size); ctx.fillStyle = ink; ctx.fillText(f.text, ix, cy + ch / 2 + f.size * 0.35)
      } else {
        const f = fitText(ctx, label, 500, key.fontSize || 14, iw, 9)
        ctx.font = mono(500, f.size); ctx.fillStyle = ink; ctx.fillText(f.text, ix, cy + ch - 16)
      }
    }
  }
  if (key.badge) {
    const b = String(tpl(key.badge)); if (b && b !== '0') {
      ctx.font = mono(700, 13); const bw = Math.max(22, ctx.measureText(b).width + 12)
      rr(ctx, cx + cw - bw - 4, cy + 4, bw, 22, 11); ctx.fillStyle = key.badgeColor || '#e5484d'; ctx.fill()
      ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.fillText(b, cx + cw - bw / 2 - 4, cy + 20); ctx.textAlign = 'left'
    }
  }
  if (typeof key.progress === 'number') {
    const p = Math.max(0, Math.min(1, key.progress)), n = 10, sw = (iw - (n - 1) * 2) / n
    for (let i = 0; i < n; i++) { ctx.fillStyle = i < Math.round(p * n) ? accent : 'rgba(0,0,0,0.1)'; ctx.fillRect(ix + i * (sw + 2), cy + ch - 12, sw, 3) }
  }
  if (key.border) { ctx.save(); rr(ctx, cx + 2, cy + 2, cw - 4, ch - 9, 13); ctx.strokeStyle = key.border; ctx.lineWidth = 3; ctx.stroke(); ctx.restore() }
  if (key.dim) { // not available (app not installed…): wash it out so nobody presses it expecting something
    ctx.save(); rr(ctx, cx, cy, cw, ch - 5, 15); ctx.fillStyle = 'rgba(239,239,235,0.62)'; ctx.fill(); ctx.restore()
  }
  return c
}

// ============================== strip ==============================
function segBar(ctx, x, y, w, h, pct, color, n = 20) {
  const gap = 2, sw = (w - (n - 1) * gap) / n, lit = Math.round(pct * n)
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i < lit ? color : SPEC.ghost
    if (i < lit) { ctx.fillStyle = 'rgba(20,20,19,0.12)'; ctx.fillRect(x + i * (sw + gap) + 0.5, y + 1, sw, h) ; ctx.fillStyle = color }
    ctx.fillRect(x + i * (sw + gap), y, sw, h)
  }
}
function tickArc(ctx, cx, cy, r, pct, color) {
  const N = 27
  for (let i = 0; i <= N; i++) {
    const a = ((-135 + (i / N) * 270 - 90) * Math.PI) / 180
    const major = i % 9 === 0, lit = i <= Math.floor(pct * N)
    ctx.strokeStyle = lit ? color : 'rgba(20,20,19,0.16)'; ctx.lineWidth = major ? 2.2 : 1.4; ctx.lineCap = 'round'
    ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * (r - (major ? 9 : 6)), cy + Math.sin(a) * (r - (major ? 9 : 6))); ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); ctx.stroke()
  }
  // pointer
  const a = ((-135 + pct * 270 - 90) * Math.PI) / 180
  ctx.strokeStyle = SPEC.grayInk; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + Math.cos(a) * (r - 12), cy + Math.sin(a) * (r - 12)); ctx.stroke()
  ctx.beginPath(); ctx.arc(cx, cy, 3, 0, Math.PI * 2); ctx.fillStyle = SPEC.grayInk; ctx.fill()
}

async function segment(ctx, x, dial = {}, value, active, vars, theme, browse = null, reserveRight = 0) {
  const tpl = s => String(s ?? '').replace(VAR_RE, (m, k) => (vars[k] ?? m))
  ctx.save(); ctx.beginPath(); ctx.rect(x, 0, SEG, H); ctx.clip(); ctx.translate(x, 0)
  const style = dial.style || 'bar'
  const min = Number(dial.min ?? 0), max = Number(dial.max ?? 100)
  const num = typeof value === 'number' && isFinite(value)
  const pct = num && max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0
  const color = dial.accent ? dial.accent : SPEC.grayInk
  const decimals = Math.max(0, Math.min(6, Math.trunc(Number(dial.decimals) || 0)))
  const shown = dial.display != null ? lower(tpl(dial.display)) : value == null ? '--' : num ? String(+value.toFixed(decimals)) : lower(value)
  const unit = num && dial.display == null ? lower(dial.unit ?? '') : ''
  const img = await getImage(dial.image)
  if (img) { ctx.globalCompositeOperation = 'multiply'; const s = Math.max(SEG / img.width, H / img.height); ctx.drawImage(img, (SEG - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s); ctx.globalCompositeOperation = 'source-over' }

  // tag: an uppercase printed label, inverted while the dial is in use
  let tx = 14
  const g = await glyph(dial.glyph, active ? '#c4c5bf' : SPEC.grayInk)
  ctx.font = mono(500, 12)
  const tag = (lower(tpl(dial.label)) || '').toUpperCase()
  const tagW = Math.min(SEG - 28, (g ? 18 : 0) + ctx.measureText(tag).width + (active ? 12 : 0))
  if (active) { rr(ctx, 9, 9, tagW + 2, 20, 4); ctx.fillStyle = SPEC.grayInk; ctx.fill(); tx = 15 }
  if (g) { ctx.drawImage(g, tx, 12, 14, 14); tx += 18 }
  else if (dial.icon) { ctx.font = mono(400, 13); ctx.fillStyle = active ? '#c4c5bf' : SPEC.grayInk; ctx.fillText(dial.icon, tx, 24); tx += 20; ctx.font = mono(500, 12) }
  ctx.fillStyle = active ? '#c4c5bf' : SPEC.grayDim
  ctx.fillText(tag, tx, 24)

  if (browse) {
    // a read-only dial being turned through its browse list: item name, its value, and the gauge
    // (when gauge style) showing that item. Text stays left of the gauge (x <= 110 for gauges).
    const bn = parseFloat(browse.value), bnum = Number.isFinite(bn)
    const bpct = bnum && max > min ? Math.max(0, Math.min(1, (bn - min) / (max - min))) : 0
    const textW = style === 'gauge' ? 96 : SEG - 28
    if (style === 'gauge') tickArc(ctx, SEG - 48, 60, 32, bpct, color)
    const nf = fitText(ctx, lower(browse.name), 500, 13, textW, 9)
    ctx.font = mono(500, nf.size); printText(ctx, nf.text, 14, 48)
    const val = browse.value ? browse.value + (/^[-+]?\d+(\.\d+)?$/.test(browse.value) ? lower(dial.unit ?? '') : '') : '' // unit only on a bare number ("1.0 gb" keeps its own)
    if (val) { const vf = fitText(ctx, val, 300, 26, textW, 12); ctx.font = mono(300, vf.size); printText(ctx, vf.text, 14, 78) }
    if (style === 'bar') segBar(ctx, 14, 84, SEG - 28, 4, bpct, color)
  } else if (style === 'gauge') {
    tickArc(ctx, SEG - 48, 60, 32, pct, color)
    const f = fitText(ctx, shown + unit, 300, 30, SEG - 110, 12)
    ctx.font = mono(300, f.size)
    if (isDigitsish(f.text)) { ctx.fillStyle = SPEC.ghost; ctx.fillText(ghostOf(f.text), 14, 72) }
    printText(ctx, f.text, 14, 72)
  } else {
    const big = style === 'text' ? 40 : 38
    const f = fitText(ctx, shown, 300, big, SEG - 28 - (unit ? 26 : 0), 12)
    ctx.font = mono(300, f.size)
    const vy = style === 'text' ? 74 : 64
    if (isDigitsish(f.text)) { ctx.fillStyle = SPEC.ghost; ctx.fillText(ghostOf(f.text), 14, vy) }
    printText(ctx, f.text, 14, vy)
    if (unit) { const w = ctx.measureText(f.text).width; ctx.font = mono(400, 15); printText(ctx, unit, 18 + w, vy, SPEC.grayDim) }
    if (style === 'bar') segBar(ctx, 14, 78, SEG - 28, 8, pct, color)
  }
  // affordance hint: what this dial answers to besides turning. Bottom-left, below the bar (ends y 86)
  // and the value baseline (<= 74), left of nothing else; tiny and low-contrast so it reads as print.
  if (browse) {
    const t = fitText(ctx, [`${browse.pos}/${browse.n}`, browse.note].filter(Boolean).join(' · ').toUpperCase(), 500, 8, SEG - 28 - reserveRight, 8) // under the gauge's open bottom (its ticks end y≈83); clear of the ‹ SWIPE › hint on the last segment
    ctx.font = mono(500, 8); ctx.fillStyle = 'rgba(20,20,19,0.6)'; ctx.fillText(t.text, 14, 97)
  } else if (theme.hints !== false) {
    const act = a => !!(a && a.type && a.type !== 'none')
    const pressable = act(dial.onPress) || !!dial._press || dial.mode === 'volume' || ((dial.mode || 'value') === 'value' && dial.default != null && !dialReadonly(dial))
    const hint = [pressable && 'press', act(dial.onTouch) && 'tap'].filter(Boolean).join(' · ').toUpperCase()
    if (hint) { ctx.font = mono(500, 8); ctx.fillStyle = 'rgba(20,20,19,0.45)'; ctx.fillText(hint, 14, 97) }
  }
  ctx.restore()
  // printed rule between segments, with ticks at each end (the kit's fieldset bracket)
  if (x > 0 && !theme.hideDividers) {
    ctx.fillStyle = 'rgba(20,20,19,0.28)'; ctx.fillRect(x, 14, 1, H - 28)
    ctx.fillRect(x - 3, 14, 7, 1); ctx.fillRect(x - 3, H - 15, 7, 1)
  }
}

export async function renderStripSpec(strip = {}, dials = [], values = [], theme = {}, opts = {}) {
  const c = createCanvas(W, H), ctx = c.getContext('2d')
  const vars = opts.vars || {}
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left'
  ctx.fillStyle = grad(ctx, 0, H, SPEC.glass); ctx.fillRect(0, 0, W, H)
  grain(ctx, W, H, 0.05, 11)
  ctx.fillStyle = grad(ctx, 0, 8, ['rgba(0,0,0,0.25)', 'rgba(0,0,0,0)']); ctx.fillRect(0, 0, W, 8)
  if (strip.mode === 'full') {
    const img = await getImage(strip.image)
    if (img) {
      ctx.globalCompositeOperation = 'multiply'
      const s = (strip.imageFit === 'contain' ? Math.min : Math.max)(W / img.width, H / img.height)
      ctx.drawImage(img, (W - img.width * s) / 2, (H - img.height * s) / 2, img.width * s, img.height * s)
      ctx.globalCompositeOperation = 'source-over'
    }
    if (strip.text) {
      const t = lower(String(strip.text).replace(VAR_RE, (m, k) => (vars[k] ?? m)))
      const f = fitText(ctx, t, 300, strip.fontSize || 34, W - 48, 12)
      ctx.font = mono(300, f.size); ctx.textAlign = 'center'
      if (isDigitsish(f.text)) { ctx.fillStyle = SPEC.ghost; ctx.fillText(ghostOf(f.text), W / 2, H / 2 + f.size * 0.36) }
      printText(ctx, f.text, W / 2, H / 2 + f.size * 0.36); ctx.textAlign = 'left'
    }
  } else {
    ctx.font = mono(500, 8)
    const swipeW = opts.swipe && theme.hints !== false ? ctx.measureText('‹ SWIPE ›').width + 22 : 0 // its width + right margin + a gap
    for (let i = 0; i < 4; i++) await segment(ctx, i * SEG, dials[i], values[i], opts.active === i, { ...vars, ...(opts.dialVars?.[i] || {}) }, theme, opts.browse?.[i] || null, i === 3 ? swipeW : 0)
  }
  if (opts.swipe && theme.hints !== false) {
    // pages hint: bottom-right corner, clear of segment hints (left-aligned at x+14) and the 4th gauge's dial
    ctx.font = mono(500, 8); ctx.fillStyle = 'rgba(20,20,19,0.45)'; ctx.textAlign = 'right'
    ctx.fillText('‹ SWIPE ›', W - 12, 97); ctx.textAlign = 'left'
  }
  if (opts.toast) {
    // a black tooltip-style card on the lcd
    ctx.font = mono(500, 20)
    const t = lower(opts.toast)
    const f = fitText(ctx, t, 500, 20, 520, 11)
    const w = Math.min(560, ctx.measureText(f.text).width + 48)
    rr(ctx, (W - w) / 2, 24, w, 52, 10); ctx.fillStyle = '#141413'; ctx.fill()
    ctx.fillStyle = '#f4f4f0'; ctx.textAlign = 'center'; ctx.font = mono(500, f.size); ctx.fillText(f.text, W / 2, 50 + f.size * 0.35); ctx.textAlign = 'left'
  }
  return c
}
