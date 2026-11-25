// Rendering of every Stream Deck+ surface: 120x120 keys and the 800x100 touch strip.
// Everything is drawn with Skia (@napi-rs/canvas) so the web editor previews are
// byte-identical to what lands on the hardware.
import { VAR_RE } from './plugin-schema.mjs'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { renderKeySpec, renderStripSpec } from './render-spec.mjs'

export const KEY = 120
export const STRIP_W = 800
export const STRIP_H = 100
export const SEG_W = 200

const imageCache = new Map() // src -> Promise<Image|null>
function getImage(src) {
  // Only inline data URLs: never read local files or fetch remote URLs from the server process.
  if (typeof src !== 'string' || !/^data:image\/(png|jpeg|gif|webp);base64,/.test(src)) return null
  if (!imageCache.has(src)) {
    if (imageCache.size > 200) imageCache.clear()
    imageCache.set(src, loadImage(src).catch(() => null))
  }
  return imageCache.get(src)
}

function fontStack(theme, weight, size) {
  return `${weight} ${size}px "${theme.font || 'Helvetica Neue'}", "Helvetica Neue", Helvetica, "Apple Color Emoji"`
}

function fillBg(ctx, w, h, bg, fallback) {
  const v = bg || fallback || '#000'
  if (Array.isArray(v) && v.length >= 2) {
    const g = ctx.createLinearGradient(0, 0, w * 0.4, h)
    v.forEach((c, i) => g.addColorStop(i / (v.length - 1), c))
    ctx.fillStyle = g
  } else ctx.fillStyle = Array.isArray(v) ? v[0] : v
  ctx.fillRect(0, 0, w, h)
}

function drawCover(ctx, img, x, y, w, h, fit = 'cover') {
  const s = fit === 'contain' ? Math.min(w / img.width, h / img.height) : Math.max(w / img.width, h / img.height)
  const dw = img.width * s, dh = img.height * s
  ctx.drawImage(img, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh)
}

// Greedy word wrap that shrinks the font until it fits maxLines.
function fitText(ctx, text, theme, weight, size, maxW, maxLines, minSize = 10) {
  text = String(text ?? '')
  size = Math.max(minSize, Math.min(200, Number(size) || minSize))
  for (let s = size; s >= minSize; s--) {
    ctx.font = fontStack(theme, weight, s)
    const lines = []
    for (const para of text.split('\n')) {
      let line = ''
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const t = line ? line + ' ' + word : word
        if (ctx.measureText(t).width <= maxW || !line) line = t
        else { lines.push(line); line = word }
      }
      lines.push(line)
    }
    if (lines.length <= maxLines && lines.every(l => ctx.measureText(l).width <= maxW)) return { lines, size: s }
    if (s === minSize) return { lines: lines.slice(0, maxLines), size: s }
  }
}

function drawLines(ctx, fit, cx, cy, lineH) {
  const total = fit.lines.length * lineH
  fit.lines.forEach((l, i) => ctx.fillText(l, cx, cy - total / 2 + lineH * (i + 0.5)))
}

export function interpolate(str, vars) {
  return String(str ?? '').replace(VAR_RE, (m, k) => (vars[k] ?? m))
}

/** key: { label, title, icon, image, imageFit, bg, fg, fontSize, iconSize, border, progress } */
export async function renderKey(key = {}, theme = {}, opts = {}) {
  if (theme.style === 'spec') return renderKeySpec(key, theme, opts)
  const c = createCanvas(KEY, KEY)
  const ctx = c.getContext('2d')
  fillBg(ctx, KEY, KEY, key.bg, theme.keyBg)
  const fg = key.fg || theme.fg || '#fff'
  const vars = opts.vars || {}
  const label = interpolate(key.label, vars)
  const title = interpolate(key.title, vars)

  const img = await getImage(key.image)
  if (img) {
    if ((key.imageFit || 'cover') === 'cover') drawCover(ctx, img, 0, 0, KEY, KEY)
    else drawCover(ctx, img, 14, label ? 8 : 14, 92, label ? 80 : 92, 'contain')
  }

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = fg
  const hasIcon = !!key.icon && !img
  const top = title ? 22 : 0
  const bottom = label ? (hasIcon || img ? 30 : 0) : 0

  if (title) {
    const f = fitText(ctx, title, theme, 600, 15, KEY - 12, 1, 9)
    ctx.globalAlpha = 0.7
    drawLines(ctx, f, KEY / 2, 13, f.size)
    ctx.globalAlpha = 1
  }
  if (hasIcon) {
    const size = key.iconSize || (label ? 52 : 68)
    const f = fitText(ctx, key.icon, theme, 500, size, KEY - 10, 1, 14)
    drawLines(ctx, f, KEY / 2, top + (KEY - top - bottom) / 2 + 2, f.size)
  }
  if (label) {
    if (hasIcon || img) {
      if (img && (key.imageFit || 'cover') === 'cover') { // legibility scrim
        const g = ctx.createLinearGradient(0, KEY - 44, 0, KEY)
        g.addColorStop(0, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,0.75)')
        ctx.fillStyle = g; ctx.fillRect(0, KEY - 44, KEY, 44); ctx.fillStyle = fg
      }
      const f = fitText(ctx, label, theme, 600, key.fontSize || 17, KEY - 10, 1, 10)
      drawLines(ctx, f, KEY / 2, KEY - 16, f.size)
    } else {
      const f = fitText(ctx, label, theme, 700, key.fontSize || 26, KEY - 14, 3, 11)
      drawLines(ctx, f, KEY / 2, top + (KEY - top) / 2, f.size * 1.1)
    }
  }
  if (typeof key.progress === 'number') {
    const p = Math.max(0, Math.min(1, key.progress))
    ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(10, KEY - 7, KEY - 20, 4)
    ctx.fillStyle = key.accent || theme.accent || '#7c5cff'; ctx.fillRect(10, KEY - 7, (KEY - 20) * p, 4)
  }
  if (key.border) {
    ctx.strokeStyle = key.border; ctx.lineWidth = 6; ctx.strokeRect(3, 3, KEY - 6, KEY - 6)
  }
  if (opts.pressed) { ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(0, 0, KEY, KEY) }
  return c
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath()
}

/** One 200x100 strip segment above a dial. dial: { label, icon, bg, fg, accent, style, min, max, unit, display } */
async function drawSegment(ctx, x, dial = {}, value, theme, active, vars) {
  ctx.save()
  ctx.beginPath(); ctx.rect(x, 0, SEG_W, STRIP_H); ctx.clip()
  ctx.translate(x, 0)
  fillBg(ctx, SEG_W, STRIP_H, dial.bg, theme.stripBg)
  const img = await getImage(dial.image)
  if (img) drawCover(ctx, img, 0, 0, SEG_W, STRIP_H)
  const fg = dial.fg || theme.fg || '#fff'
  const accent = dial.accent || theme.accent || '#7c5cff'
  const style = dial.style || 'bar'
  const min = Number(dial.min ?? 0), max = Number(dial.max ?? 100)
  const num = typeof value === 'number' && isFinite(value)
  const pct = num && max > min ? Math.max(0, Math.min(1, (value - min) / (max - min))) : 0
  const shown = dial.display != null ? interpolate(dial.display, vars)
    : value == null ? '' : num ? `${+value.toFixed(Math.max(0, Math.min(6, Math.trunc(Number(dial.decimals) || 0))))}${dial.unit ?? ''}` : String(value)

  ctx.fillStyle = fg; ctx.textBaseline = 'middle'
  const padL = dial.icon ? 52 : 14
  if (dial.icon) {
    ctx.textAlign = 'center'; ctx.font = fontStack(theme, 500, 34); ctx.fillText(dial.icon, 28, style === 'text' ? 50 : 42)
  }
  ctx.textAlign = 'left'
  if (style === 'gauge') {
    const cx = SEG_W - 48, cy = 56, r = 32
    ctx.lineWidth = 8; ctx.lineCap = 'round'
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * 2.25); ctx.stroke()
    ctx.strokeStyle = accent; ctx.beginPath(); ctx.arc(cx, cy, r, Math.PI * 0.75, Math.PI * (0.75 + 1.5 * pct)); ctx.stroke()
    ctx.textAlign = 'center'
    const f = fitText(ctx, shown, theme, 700, 20, 50, 1, 10); drawLines(ctx, f, cx, cy, f.size)
    ctx.textAlign = 'left'
    const lf = fitText(ctx, interpolate(dial.label, vars), theme, 600, 18, SEG_W - padL - 90, 2, 10)
    drawLines(ctx, lf, padL, 50, lf.size * 1.1)
  } else {
    const lf = fitText(ctx, interpolate(dial.label, vars), theme, 600, 17, SEG_W - padL - 10, 1, 10)
    ctx.globalAlpha = 0.75; drawLines(ctx, lf, padL, 22, lf.size); ctx.globalAlpha = 1
    const vf = fitText(ctx, shown, theme, 700, style === 'text' ? 34 : 30, SEG_W - padL - 10, 1, 12)
    drawLines(ctx, vf, padL, style === 'text' ? 60 : 54, vf.size)
    if (style === 'bar') {
      roundRect(ctx, 14, 80, SEG_W - 28, 8, 4); ctx.fillStyle = 'rgba(255,255,255,0.15)'; ctx.fill()
      if (pct > 0) { roundRect(ctx, 14, 80, Math.max(8, (SEG_W - 28) * pct), 8, 4); ctx.fillStyle = accent; ctx.fill() }
    }
  }
  if (active) { ctx.strokeStyle = accent; ctx.lineWidth = 4; roundRect(ctx, 2, 2, SEG_W - 4, STRIP_H - 4, 10); ctx.stroke() }
  ctx.restore()
  // separator
  if (x > 0 && !theme.hideDividers) { ctx.fillStyle = 'rgba(255,255,255,0.12)'; ctx.fillRect(x, 12, 1, STRIP_H - 24) }
}

/** strip: { mode: 'segments'|'full', bg, image, text, fg } ; dials: 4 dial configs ; values: 4 values */
export async function renderStrip(strip = {}, dials = [], values = [], theme = {}, opts = {}) {
  if (theme.style === 'spec') return renderStripSpec(strip, dials, values, theme, opts)
  const c = createCanvas(STRIP_W, STRIP_H)
  const ctx = c.getContext('2d')
  const vars = opts.vars || {}
  if (strip.mode === 'full') {
    fillBg(ctx, STRIP_W, STRIP_H, strip.bg, theme.stripBg)
    const img = await getImage(strip.image)
    if (img) drawCover(ctx, img, 0, 0, STRIP_W, STRIP_H, strip.imageFit || 'cover')
    if (strip.text) {
      ctx.fillStyle = strip.fg || theme.fg || '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
      const f = fitText(ctx, interpolate(strip.text, vars), theme, 700, strip.fontSize || 40, STRIP_W - 40, 2, 12)
      drawLines(ctx, f, STRIP_W / 2, STRIP_H / 2, f.size * 1.1)
    }
  } else {
    for (let i = 0; i < 4; i++) {
      // a read-only dial being browsed: show the item in place of the live value
      // (item names are command output: never templated, so no vars for a browsed segment)
      const b = opts.browse?.[i], d = b ? { ...dials[i], label: `${b.pos}/${b.n} ${b.name}`, display: b.value + (/^[-+]?\d+(\.\d+)?$/.test(b.value) ? dials[i]?.unit ?? '' : '') } : dials[i]
      await drawSegment(ctx, i * SEG_W, d, b ? parseFloat(b.value) : values[i], theme, opts.active === i, b ? {} : { ...vars, ...(opts.dialVars?.[i] || {}) })
    }
  }
  if (opts.toast) {
    ctx.fillStyle = 'rgba(0,0,0,0.78)'; roundRect(ctx, 200, 22, 400, 56, 14); ctx.fill()
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
    const f = fitText(ctx, opts.toast, theme, 700, 26, 380, 1, 12); drawLines(ctx, f, 400, 50, f.size)
  }
  return c
}

export function renderError(w, h, msg) {
  const c = createCanvas(w, h), ctx = c.getContext('2d')
  ctx.fillStyle = '#3a1016'; ctx.fillRect(0, 0, w, h)
  ctx.fillStyle = '#ff8a9a'; ctx.font = 'bold 14px Helvetica'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'
  ctx.fillText('⚠ render error', w / 2, h / 2 - 9); ctx.font = '10px Helvetica'; ctx.fillText(String(msg).slice(0, 28), w / 2, h / 2 + 9)
  return c
}

export function rgba(canvas) {
  const { width, height } = canvas
  return Buffer.from(canvas.getContext('2d').getImageData(0, 0, width, height).data.buffer)
}
