// Icon Studio effects: pure functions over RGBA pixel buffers (the shape of ImageData), so they
// run and test without a DOM. The studio draws a source into a small canvas, runs these, and
// scales the result back up with smoothing off.

export type Img = { width: number; height: number; data: Uint8ClampedArray }
export type RGB = [number, number, number]
export type RGBA = [number, number, number, number]

export const img = (width: number, height: number, data?: ArrayLike<number>): Img => ({
  width,
  height,
  data: data ? Uint8ClampedArray.from(data) : new Uint8ClampedArray(width * height * 4),
})

export function hex(h: string): RGB {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim())
  const n = m ? parseInt(m[1], 16) : 0
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

/** Rec. 601 luma, 0–255. */
export const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b

// ---------- pixelate ----------

/** Box-average each block×block cell into one pixel (alpha-weighted, so transparent edges don't darken). */
export function downsample(src: Img, block: number): Img {
  const b = Math.max(1, Math.floor(block))
  const w = Math.max(1, Math.ceil(src.width / b))
  const h = Math.max(1, Math.ceil(src.height / b))
  const out = img(w, h)
  for (let cy = 0; cy < h; cy++)
    for (let cx = 0; cx < w; cx++) {
      let r = 0, g = 0, bl = 0, a = 0, n = 0
      for (let y = cy * b; y < Math.min(src.height, (cy + 1) * b); y++)
        for (let x = cx * b; x < Math.min(src.width, (cx + 1) * b); x++) {
          const i = (y * src.width + x) * 4
          const al = src.data[i + 3]
          r += src.data[i] * al
          g += src.data[i + 1] * al
          bl += src.data[i + 2] * al
          a += al
          n++
        }
      const o = (cy * w + cx) * 4
      if (a > 0) {
        out.data[o] = r / a
        out.data[o + 1] = g / a
        out.data[o + 2] = bl / a
      }
      out.data[o + 3] = n ? a / n : 0
    }
  return out
}

/** Nearest-neighbour upscale by an integer factor. */
export function upscale(src: Img, f: number): Img {
  const k = Math.max(1, Math.floor(f))
  const out = img(src.width * k, src.height * k)
  for (let y = 0; y < out.height; y++)
    for (let x = 0; x < out.width; x++) {
      const i = (((y / k) | 0) * src.width + ((x / k) | 0)) * 4
      out.data.set(src.data.subarray(i, i + 4), (y * out.width + x) * 4)
    }
  return out
}

/** Same-size pixelation: average blocks, then paint each block flat. */
export function pixelate(src: Img, block: number): Img {
  if (block <= 1) return img(src.width, src.height, src.data)
  const up = upscale(downsample(src, block), block)
  // crop back to the source size (the last row/column of blocks may overhang)
  const out = img(src.width, src.height)
  for (let y = 0; y < src.height; y++) out.data.set(up.data.subarray(y * up.width * 4, (y * up.width + src.width) * 4), y * src.width * 4)
  return out
}

// ---------- tone ----------

export type Adjust = { brightness: number; contrast: number; invert: boolean }

/** brightness and contrast are −100…100 (0 = unchanged); invert flips color, not alpha. */
export function adjust(src: Img, { brightness, contrast, invert }: Adjust): Img {
  const out = img(src.width, src.height, src.data)
  const c = (contrast / 100) * 255
  const f = (259 * (c + 255)) / (255 * (259 - c))
  const b = (brightness / 100) * 255
  const lut = new Uint8ClampedArray(256)
  for (let v = 0; v < 256; v++) {
    const x = f * (v - 128) + 128 + b
    lut[v] = invert ? 255 - x : x
  }
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = lut[out.data[i]]
    out.data[i + 1] = lut[out.data[i + 1]]
    out.data[i + 2] = lut[out.data[i + 2]]
  }
  return out
}

// ---------- palettes ----------

/**
 * `match` is what pixels are compared against, `out` what gets written. Tonal palettes ("luma")
 * turn the pixel gray first and spread the entries evenly from dark to light, so a 4-tone
 * Game Boy ramp uses all four tones no matter how its real colors are spaced.
 */
export type Palette = { id: string; label: string; mode: "nearest" | "luma"; out: RGBA[] }

const solid = (...hs: string[]): RGBA[] => hs.map((h) => [...hex(h), 255] as RGBA)
export const INK = "#1b1b19"
export const PAPER = "#efefeb"
export const KEY = "#7c5cff"

export const PALETTES: Palette[] = [
  { id: "original", label: "original", mode: "nearest", out: [] },
  { id: "ink", label: "1-bit ink", mode: "luma", out: [[...hex(INK), 255], [0, 0, 0, 0]] },
  { id: "duotone", label: "duotone", mode: "luma", out: solid("#1e1547", KEY) },
  { id: "gameboy", label: "game boy", mode: "luma", out: solid("#0f380f", "#306230", "#8bac0f", "#9bbc0f") },
  { id: "amber", label: "amber crt", mode: "luma", out: solid("#1a0d00", "#7a3c00", "#e08a00", "#ffcc66") },
  { id: "cga", label: "cga", mode: "nearest", out: solid("#000000", "#55ffff", "#ff55ff", "#ffffff") },
  { id: "paper", label: "paper ink", mode: "luma", out: solid(INK, "#6b6b66", PAPER) },
  { id: "custom", label: "custom 2-color", mode: "luma", out: [] },
]

export function paletteFor(id: string, custom: [string, string] = [INK, PAPER]): Palette | null {
  if (id === "custom") return { id, label: "custom", mode: "luma", out: solid(custom[0], custom[1]) }
  const p = PALETTES.find((x) => x.id === id)
  return p && p.out.length ? p : null
}

/** The colors pixels are matched against: the real colors, or an even gray ramp for tonal palettes. */
export function matchColors(p: Palette): RGB[] {
  if (p.mode === "nearest") return p.out.map(([r, g, b]) => [r, g, b])
  const n = p.out.length
  return p.out.map((_, i) => {
    const v = n === 1 ? 0 : Math.round((i / (n - 1)) * 255)
    return [v, v, v]
  })
}

export function nearest(colors: RGB[], r: number, g: number, b: number): number {
  let best = 0, bd = Infinity
  for (let i = 0; i < colors.length; i++) {
    const [cr, cg, cb] = colors[i]
    // weighted RGB distance, a cheap step toward perceptual
    const d = 2 * (r - cr) ** 2 + 4 * (g - cg) ** 2 + 3 * (b - cb) ** 2
    if (d < bd) {
      bd = d
      best = i
    }
  }
  return best
}

// ---------- dithering ----------

export type Dither = "none" | "floyd" | "atkinson" | "bayer4" | "bayer8"

// [dx, dy, weight]
const KERNELS: Record<"floyd" | "atkinson", [number, number, number][]> = {
  floyd: [[1, 0, 7 / 16], [-1, 1, 3 / 16], [0, 1, 5 / 16], [1, 1, 1 / 16]],
  atkinson: [[1, 0, 1 / 8], [2, 0, 1 / 8], [-1, 1, 1 / 8], [0, 1, 1 / 8], [1, 1, 1 / 8], [0, 2, 1 / 8]],
}

/** Recursive Bayer matrix, n a power of two; values 0…n²−1. */
export function bayer(n: number): number[][] {
  if (n <= 1) return [[0]]
  const h = bayer(n / 2)
  const m: number[][] = []
  for (let y = 0; y < n; y++) {
    m.push([])
    for (let x = 0; x < n; x++) {
      const base = 4 * h[y % (n / 2)][x % (n / 2)]
      const q = [[0, 2], [3, 1]][(y * 2) / n | 0][(x * 2) / n | 0]
      m[y].push(base + q)
    }
  }
  return m
}

/**
 * Map every pixel to the palette, optionally dithering. Pixels under half alpha stay
 * transparent and neither take nor spread error.
 */
export function quantize(src: Img, p: Palette, dither: Dither = "none"): Img {
  const { width: w, height: h } = src
  const out = img(w, h)
  const match = matchColors(p)
  const gray = p.mode === "luma"
  const buf = new Float32Array(w * h * 3)
  for (let i = 0, j = 0; i < src.data.length; i += 4, j += 3) {
    const [r, g, b] = [src.data[i], src.data[i + 1], src.data[i + 2]]
    if (gray) buf[j] = buf[j + 1] = buf[j + 2] = luma(r, g, b)
    else {
      buf[j] = r
      buf[j + 1] = g
      buf[j + 2] = b
    }
  }
  const kernel = dither === "floyd" || dither === "atkinson" ? KERNELS[dither] : null
  const mat = dither === "bayer4" ? bayer(4) : dither === "bayer8" ? bayer(8) : null
  // ordered-dither spread: about one palette step
  const spread = 255 / Math.max(1, match.length - 1)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p4 = (y * w + x) * 4, p3 = (y * w + x) * 3
      if (src.data[p4 + 3] < 128) continue // left transparent
      let r = buf[p3], g = buf[p3 + 1], b = buf[p3 + 2]
      if (mat) {
        const n = mat.length
        const t = ((mat[y % n][x % n] + 0.5) / (n * n) - 0.5) * spread
        r += t
        g += t
        b += t
      }
      const k = nearest(match, r, g, b)
      out.data.set(p.out[k], p4)
      if (!kernel) continue
      const [mr, mg, mb] = match[k]
      const er = r - mr, eg = g - mg, eb = b - mb
      for (const [dx, dy, wt] of kernel) {
        const nx = x + dx, ny = y + dy
        if (nx < 0 || nx >= w || ny >= h || src.data[(ny * w + nx) * 4 + 3] < 128) continue
        const q = (ny * w + nx) * 3
        buf[q] += er * wt
        buf[q + 1] += eg * wt
        buf[q + 2] += eb * wt
      }
    }
  return out
}

// ---------- ascii ----------

export const RAMPS: { id: string; label: string; chars: string }[] = [
  { id: "classic", label: "classic", chars: " .:-=+*#%@" },
  { id: "blocks", label: "blocks", chars: " ░▒▓█" },
  { id: "dense", label: "dense", chars: " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$" },
  { id: "binary", label: "binary", chars: " 01" },
  { id: "dots", label: "dots", chars: " ·•●" },
]

export type Cell = { ch: string; r: number; g: number; b: number; a: number }

/**
 * Average each cell×cell block and pick a character by ink coverage: `ramp` runs from empty
 * to dense. On a light ground darker pixels are denser; on a dark ground, brighter ones.
 * Fully empty cells come back as " ".
 */
export function ascii(src: Img, cell: number, ramp: string, dark = false): Cell[][] {
  const chars = [...ramp]
  const small = downsample(src, cell)
  const rows: Cell[][] = []
  for (let y = 0; y < small.height; y++) {
    const row: Cell[] = []
    for (let x = 0; x < small.width; x++) {
      const i = (y * small.width + x) * 4
      const [r, g, b, a] = small.data.subarray(i, i + 4)
      const l = luma(r, g, b) / 255
      const cover = (a / 255) * (dark ? l : 1 - l)
      const k = chars.length ? Math.min(chars.length - 1, Math.round(cover * (chars.length - 1))) : 0
      row.push({ ch: chars[k] ?? " ", r, g, b, a })
    }
    rows.push(row)
  }
  return rows
}

/** Bounding box of pixels with alpha above `min`, or null when the image is empty. */
export function opaqueBox(src: Img, min = 8): { x: number; y: number; w: number; h: number } | null {
  let x0 = src.width, y0 = src.height, x1 = -1, y1 = -1
  for (let y = 0; y < src.height; y++)
    for (let x = 0; x < src.width; x++)
      if (src.data[(y * src.width + x) * 4 + 3] > min) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }
}

/** "My Cool Icon!" → "my-cool-icon", at most 48 chars of [a-z0-9-]. */
export const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48).replace(/-+$/, "")
