// Icon Studio: turn a logo, glyph, running app's icon or any image into pixel-art or ASCII key art.
// Everything runs client-side on <canvas>; the effects themselves are pure functions in iconfx.ts.
import * as React from "react"
import { createPortal } from "react-dom"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { Segmented } from "@/components/ui/segmented-control"
import { Slider } from "@/components/ui/slider"
import { Stepper } from "@/components/ui/stepper"
import { Switch } from "@/components/ui/switch"
import { api, toast, state, save, select, page } from "./store"
import {
  INK, KEY, PAPER, PALETTES, RAMPS, adjust, ascii, downsample, img, opaqueBox, paletteFor, quantize, slug,
  type Cell, type Dither, type Img,
} from "./iconfx"

type Fx = {
  mode: "pixel" | "ascii"
  block: number
  brightness: number
  contrast: number
  invert: boolean
  palette: string
  c1: string
  c2: string
  dither: Dither
  ramp: string
  customRamp: string
  cell: number
  glyphs: "mono" | "color"
  bg: "none" | "paper" | "black" | "key"
  scale: number
  mask: boolean
  trim: boolean
}
const DEFAULTS: Fx = {
  mode: "pixel", block: 4, brightness: 0, contrast: 0, invert: false, palette: "original", c1: INK, c2: PAPER,
  dither: "none", ramp: "classic", customRamp: "", cell: 6, glyphs: "mono", bg: "none", scale: 84, mask: false, trim: true,
}
const BG: Record<Fx["bg"], string | null> = { none: null, paper: PAPER, black: "#000000", key: KEY }
const DITHERS: { value: Dither; label: string }[] = [
  { value: "none", label: "none" },
  { value: "floyd", label: "floyd–steinberg" },
  { value: "atkinson", label: "atkinson" },
  { value: "bayer4", label: "bayer 4×4" },
  { value: "bayer8", label: "bayer 8×8" },
]
const SAVE_PX = 256

// ---------- canvas plumbing ----------

type Source = { url: string; label: string }
type Prepared = { canvas: HTMLCanvasElement; box: { x: number; y: number; w: number; h: number } | null }

const canvas = (w: number, h = w) => Object.assign(document.createElement("canvas"), { width: w, height: h })
const ctx2d = (c: HTMLCanvasElement) => c.getContext("2d", { willReadFrequently: true })!

/** Decode a source once into a 512px canvas and find its opaque bounds (for "trim edges"). */
async function prepare(url: string): Promise<Prepared> {
  const im = new Image()
  im.src = url
  await im.decode()
  const svg = /\.svg(\?|$)/.test(url) || !im.naturalWidth // viewBox-only svgs have no reliable intrinsic size
  const w0 = svg ? 1 : im.naturalWidth, h0 = svg ? 1 : im.naturalHeight
  const k = 512 / Math.max(w0, h0)
  const c = canvas(Math.max(1, Math.round(w0 * k)), Math.max(1, Math.round(h0 * k)))
  const x = ctx2d(c)
  x.imageSmoothingQuality = "high"
  x.drawImage(im, 0, 0, c.width, c.height)
  return { canvas: c, box: opaqueBox(x.getImageData(0, 0, c.width, c.height)) }
}

/** The source contain-fit into an a×a square, as pixels. */
function sample(p: Prepared, a: number, trim: boolean): Img {
  const r = trim && p.box ? p.box : { x: 0, y: 0, w: p.canvas.width, h: p.canvas.height }
  const s = a / Math.max(r.w, r.h)
  const c = canvas(a)
  const x = ctx2d(c)
  x.imageSmoothingQuality = "high"
  x.drawImage(p.canvas, r.x, r.y, r.w, r.h, (a - r.w * s) / 2, (a - r.h * s) / 2, r.w * s, r.h * s)
  return x.getImageData(0, 0, a, a)
}

type Art = { kind: "pixel"; canvas: HTMLCanvasElement } | { kind: "ascii"; cells: Cell[][]; mono: string }

/** Run the pipeline at key scale (120px): sample → pixelate/cells → tone → palette (+dither). */
function process(p: Prepared, fx: Fx): Art {
  const artPx = (120 * fx.scale) / 100
  const pal = fx.palette === "custom" ? paletteFor("custom", [fx.c1, fx.c2]) : paletteFor(fx.palette)
  const dark = fx.bg === "black" || fx.bg === "key"
  const tone = { brightness: fx.brightness, contrast: fx.contrast, invert: fx.invert }
  if (fx.mode === "pixel") {
    const n = Math.max(1, Math.round(artPx / fx.block))
    let im = adjust(downsample(sample(p, n * fx.block, fx.trim), fx.block), tone)
    if (pal) im = quantize(im, pal, fx.dither)
    const c = canvas(im.width, im.height)
    c.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(im.data), im.width, im.height), 0, 0)
    return { kind: "pixel", canvas: c }
  }
  const cols = Math.max(1, Math.round(artPx / fx.cell))
  const ramp = fx.ramp === "custom" ? fx.customRamp || " #" : RAMPS.find((r) => r.id === fx.ramp)!.chars
  const cells = ascii(adjust(sample(p, cols * fx.cell, fx.trim), tone), fx.cell, ramp, dark)
  if (pal && fx.glyphs === "color") {
    // map each glyph's color through the palette too
    const flat = cells.flat()
    const q = quantize(img(flat.length, 1, flat.flatMap((c) => [c.r, c.g, c.b, c.a])), pal)
    flat.forEach((c, i) => ([c.r, c.g, c.b, c.a] = q.data.subarray(i * 4, i * 4 + 4)))
  }
  return { kind: "ascii", cells, mono: dark ? PAPER : INK }
}

/** Lay the art out on a size×size key: background, optional rounded tile, then the art. */
function compose(out: HTMLCanvasElement, art: Art, fx: Fx) {
  const size = out.width
  const x = out.getContext("2d")!
  x.clearRect(0, 0, size, size)
  const side = (size * fx.scale) / 100
  const off = (size - side) / 2
  x.save()
  if (fx.mask) {
    const m = size * 0.06
    x.beginPath()
    x.roundRect(m, m, size - 2 * m, size - 2 * m, (size - 2 * m) * 0.22)
    x.clip()
  }
  const bg = BG[fx.bg]
  if (bg) {
    x.fillStyle = bg
    x.fillRect(0, 0, size, size)
  }
  if (art.kind === "pixel") {
    x.imageSmoothingEnabled = false
    x.drawImage(art.canvas, off, off, side, side)
  } else {
    const rows = art.cells.length, cols = art.cells[0]?.length || 1
    const cs = side / Math.max(rows, cols)
    x.font = `500 ${cs * 1.15}px "IBM Plex Mono", ui-monospace, monospace`
    x.textAlign = "center"
    x.textBaseline = "middle"
    art.cells.forEach((row, y) =>
      row.forEach((c, i) => {
        if (c.ch === " " || (fx.glyphs === "color" && c.a < 16)) return
        x.fillStyle = fx.glyphs === "color" ? `rgb(${c.r} ${c.g} ${c.b})` : art.mono
        x.fillText(c.ch, off + (i + 0.5) * cs, off + (y + 0.5) * cs)
      }),
    )
  }
  x.restore()
}

function render(p: Prepared, fx: Fx, size: number) {
  const c = canvas(size)
  compose(c, process(p, fx), fx)
  return c
}

// ---------- sources ----------

type Tab = "logos" | "glyphs" | "apps" | "upload"

/** A grid thumbnail. Loaded eagerly: lazy images in this scroll-clipped modal grid could sit unloaded
 *  (a lazy img that hasn't started paints nothing: an empty tile). A failed one shows its name instead. */
export function Thumb({ src, alt }: { src: string; alt: string }) {
  const [broken, setBroken] = React.useState(false)
  React.useEffect(() => setBroken(false), [src])
  return broken ? <span data-ds-thumb-missing>{alt.replace(/^(app|provider|custom)-/, "").slice(0, 6)}</span> : <img src={src} alt={alt} decoding="async" draggable={false} onError={() => setBroken(true)} />
}

function Sources({ current, onPick }: { current: string; onPick(s: Source): void }) {
  const [tab, setTab] = React.useState<Tab>("logos")
  const [logos, setLogos] = React.useState<{ name: string; file: string; url?: string }[]>([])
  const [q, setQ] = React.useState("")
  const [glyphs, setGlyphs] = React.useState<string[]>([])
  const [apps, setApps] = React.useState<{ bundleId: string; name: string; icon?: string | null }[] | null>(null)
  const [busy, setBusy] = React.useState("")
  const [drag, setDrag] = React.useState(false)
  const file = React.useRef<HTMLInputElement>(null)
  const lastBlob = React.useRef("")

  const loadLogos = React.useCallback(() => {
    api<{ logos: { name: string; file: string; url?: string }[] }>("GET", "/api/logos").then((j) => setLogos(j.logos || [])).catch(() => {})
  }, [])
  React.useEffect(loadLogos, [loadLogos])
  React.useEffect(() => {
    if (tab !== "glyphs") return
    const t = setTimeout(() => {
      api<{ names: string[] }>("GET", `/api/glyphs?q=${encodeURIComponent(q)}`).then((j) => setGlyphs(j.names || [])).catch(() => {})
    }, 120)
    return () => clearTimeout(t)
  }, [q, tab])
  React.useEffect(() => {
    if (tab !== "apps" || apps) return
    api<{ running: { bundleId: string; name: string; icon?: string | null }[] }>("GET", "/api/apps?icons=1")
      .then((j) => setApps((j.running || []).filter((a) => a && a.bundleId)))
      .catch(() => setApps([]))
  }, [tab, apps])
  React.useEffect(() => () => URL.revokeObjectURL(lastBlob.current), [])

  const upload = (f: File | undefined) => {
    if (!f) return
    if (!f.type.startsWith("image/")) return toast("that isn't an image file", "error")
    URL.revokeObjectURL(lastBlob.current)
    lastBlob.current = URL.createObjectURL(f)
    onPick({ url: lastBlob.current, label: f.name.replace(/\.[^.]+$/, "") })
  }

  return (
    <section data-ds-studio-sources aria-label="source">
      <Segmented
        label="source"
        value={tab}
        options={["logos", "glyphs", "apps", "upload"]}
        onValueChange={(v) => setTab(v as Tab)}
      />
      {tab === "logos" && (
        <div data-ds-glyph-grid data-color role="listbox" aria-label="logos">
          {logos.map((l) => (
            <button key={l.file} type="button" role="option" aria-selected={current === (l.url ?? `/logos/${l.file}`)} title={l.name}
              onClick={() => onPick({ url: l.url ?? `/logos/${l.file}`, label: l.name.replace(/^(custom|app)-/, "") })}>
              <Thumb src={l.url ?? `/logos/${l.file}`} alt={l.name} />
            </button>
          ))}
          {!logos.length && <p data-ds-note>no logos yet — try the apps tab</p>}
        </div>
      )}
      {tab === "glyphs" && (
        <>
          <input data-kit="input" value={q} spellCheck={false} placeholder="search carbon icons · rocket, play…" onChange={(e) => setQ(e.target.value)} />
          <div data-ds-glyph-grid role="listbox" aria-label="glyphs">
            {glyphs.map((n) => (
              <button key={n} type="button" role="option" aria-selected={current === `/glyphs/${n}.svg`} title={n}
                onClick={() => onPick({ url: `/glyphs/${n}.svg`, label: n })}>
                <Thumb src={`/glyphs/${n}.svg`} alt={n} />
              </button>
            ))}
          </div>
        </>
      )}
      {tab === "apps" && (
        <div data-ds-studio-list>
          {apps === null && <p data-ds-note>reading running apps…</p>}
          {apps?.length === 0 && <p data-ds-note>no running apps found</p>}
          {apps?.map((a) => (
            <Button
              key={a.bundleId}
              disabled={!!busy}
              title={a.bundleId}
              onClick={async () => {
                setBusy(a.bundleId)
                try {
                  const j = await api<{ name: string }>("POST", "/api/logos/from-app", { bundleId: a.bundleId })
                  onPick({ url: `/logos/${j.name}.png?v=${Date.now()}`, label: a.name || j.name })
                  loadLogos()
                } catch {
                  /* api() already toasted */
                } finally {
                  setBusy("")
                }
              }}
            >
              {a.icon ? <img data-ds-app-icon src={a.icon} alt="" /> : <Icon name="image" />}{" "}
              {busy === a.bundleId ? "extracting…" : a.name || a.bundleId}
            </Button>
          ))}
        </div>
      )}
      {tab === "upload" && (
        <div
          data-ds-studio-drop
          data-over={drag || undefined}
          onDragOver={(e) => (e.preventDefault(), setDrag(true))}
          onDragLeave={() => setDrag(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDrag(false)
            upload(e.dataTransfer.files[0])
          }}
        >
          <p data-ds-note>drop any image here (png, jpg, svg, webp…)</p>
          <Button onClick={() => file.current?.click()}>
            <Icon name="upload" /> choose file
          </Button>
          <input ref={file} type="file" accept="image/*" hidden onChange={(e) => (upload(e.target.files?.[0]), (e.target.value = ""))} />
        </div>
      )}
    </section>
  )
}

// ---------- controls ----------

function Group({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset data-kit="fieldset" data-ds-group>
      <legend data-kit="legend">{legend}</legend>
      <div data-kit="fieldset-body" data-ds-group-body>
        {children}
      </div>
    </fieldset>
  )
}

function Chips<T extends string>({ label, value, options, onChange, swatches }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange(v: T): void; swatches?: Record<string, string[]>
}) {
  return (
    <div data-kit="field">
      <span data-kit="label">{label}</span>
      <div data-ds-chips role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={value === o.value} data-on={value === o.value || undefined} onClick={() => onChange(o.value)}>
            {swatches?.[o.value]?.map((c, i) => <i key={i} data-ds-chip-swatch style={{ background: c }} />)}
            {o.label}
          </button>
        ))}
      </div>
    </div>
  )
}

const rgba = ([r, g, b, a]: number[]) => (a ? `rgb(${r} ${g} ${b})` : "transparent")
const SWATCHES = Object.fromEntries(PALETTES.map((p) => [p.id, p.out.map(rgba)]))

function Controls({ fx, set, gen }: { fx: Fx; set(p: Partial<Fx>): void; gen: number }) {
  const n = Math.max(1, Math.round((120 * fx.scale) / 100 / fx.block))
  const cols = Math.max(1, Math.round((120 * fx.scale) / 100 / fx.cell))
  return (
    <section data-ds-studio-controls aria-label="effects">
      <Group legend="style">
        <Segmented label="mode" value={fx.mode} options={[{ value: "pixel", label: "pixel art" }, { value: "ascii", label: "ascii" }]} onValueChange={(v) => set({ mode: v as Fx["mode"] })} />
        {fx.mode === "pixel" ? (
          <>
            <Slider label="pixel block" value={fx.block} min={1} max={24} step={1} onValueChange={(v) => set({ block: v })} />
            <p data-ds-note>working grid {n}×{n} on the 120px key</p>
          </>
        ) : (
          <>
            <Chips label="character ramp" value={fx.ramp} options={[...RAMPS.map((r) => ({ value: r.id, label: r.label })), { value: "custom", label: "custom" }]} onChange={(v) => set({ ramp: v })} />
            {fx.ramp === "custom" ? (
              <input data-kit="input" data-ds-studio-ramp value={fx.customRamp} spellCheck={false} placeholder="empty → dense, e.g.  .oO@" aria-label="custom ramp" onChange={(e) => set({ customRamp: e.target.value })} />
            ) : (
              <p data-ds-note><code>{RAMPS.find((r) => r.id === fx.ramp)?.chars.trim().slice(0, 40)}</code></p>
            )}
            <div data-ds-pair>
              <Stepper key={`cell${gen}`} label="cell size" defaultValue={fx.cell} min={3} max={24} onValueChange={(v) => v != null && v >= 3 && v <= 24 && set({ cell: v })} />
              <Segmented label="glyphs" value={fx.glyphs} options={["mono", "color"]} onValueChange={(v) => set({ glyphs: v as Fx["glyphs"] })} />
            </div>
            <p data-ds-note>{cols}×{cols} characters · ibm plex mono</p>
          </>
        )}
      </Group>
      <Group legend="tone">
        <Slider label="brightness" value={fx.brightness} min={-100} max={100} step={1} onValueChange={(v) => set({ brightness: v })} />
        <Slider label="contrast" value={fx.contrast} min={-100} max={100} step={1} onValueChange={(v) => set({ contrast: v })} />
        <Switch key={`inv${gen}`} label="invert" defaultChecked={fx.invert} onCheckedChange={(c) => set({ invert: c })} />
      </Group>
      <Group legend="palette">
        <Chips label="colors" value={fx.palette} options={PALETTES.map((p) => ({ value: p.id, label: p.label }))} swatches={{ ...SWATCHES, custom: [fx.c1, fx.c2] }} onChange={(v) => set({ palette: v })} />
        {fx.palette === "custom" && (
          <div data-ds-pair>
            {(["c1", "c2"] as const).map((k, i) => (
              <label key={k} data-ds-inline>
                <span data-ds-swatch style={{ background: fx[k] }}>
                  <input type="color" value={fx[k]} aria-label={i ? "light color" : "dark color"} onChange={(e) => set({ [k]: e.target.value })} />
                </span>
                <span data-ds-note>{i ? "lights" : "darks"} {fx[k]}</span>
              </label>
            ))}
          </div>
        )}
        {fx.mode === "pixel" && (
          <>
            <Chips label="dither" value={fx.dither} options={DITHERS} onChange={(v) => set({ dither: v })} />
            {fx.palette === "original" && fx.dither !== "none" && <p data-ds-note>dither needs a palette — pick one above</p>}
          </>
        )}
      </Group>
      <Group legend="tile">
        <Segmented label="background" value={fx.bg} options={[{ value: "none", label: "clear" }, { value: "paper", label: "paper" }, { value: "black", label: "black" }, { value: "key", label: "key" }]} onValueChange={(v) => set({ bg: v as Fx["bg"] })} />
        <Slider label="art size %" value={fx.scale} min={30} max={100} step={1} onValueChange={(v) => set({ scale: v })} />
        <Switch key={`mask${gen}`} label="rounded tile" defaultChecked={fx.mask} onCheckedChange={(c) => set({ mask: c })} />
        <Switch key={`trim${gen}`} label="trim empty edges" defaultChecked={fx.trim} onCheckedChange={(c) => set({ trim: c })} />
      </Group>
    </section>
  )
}

// ---------- the studio ----------

export function IconStudio({ onClose, onSaved }: { onClose(): void; onSaved?(name: string): void }) {
  const [source, setSource] = React.useState<Source | null>(null)
  const [prep, setPrep] = React.useState<Prepared | null>(null)
  const [fx, setFx] = React.useState<Fx>(DEFAULTS)
  const [past, setPast] = React.useState<Fx[]>([])
  const [gen, setGen] = React.useState(0) // remounts the uncontrolled kit fields after undo/reset
  const [preview, setPreview] = React.useState("")
  const [name, setName] = React.useState("")
  const [saving, setSaving] = React.useState(false)
  const [fontRev, setFontRev] = React.useState(0)
  const last = React.useRef({ key: "", t: 0 })

  // edits to the same control within a moment fold into one undo step (a slider drag)
  const set = (patch: Partial<Fx>) => {
    const key = Object.keys(patch).join()
    const now = performance.now()
    if (key !== last.current.key || now - last.current.t > 700) setPast((p) => [...p.slice(-59), fx])
    last.current = { key, t: now }
    setFx((f) => ({ ...f, ...patch }))
  }
  const undo = () => {
    if (!past.length) return
    setFx(past[past.length - 1])
    setPast((p) => p.slice(0, -1))
    setGen((g) => g + 1)
    last.current.key = ""
  }
  const reset = () => {
    if (JSON.stringify(fx) === JSON.stringify(DEFAULTS)) return
    setPast((p) => [...p.slice(-59), fx])
    setFx(DEFAULTS)
    setGen((g) => g + 1)
    last.current.key = ""
  }

  React.useEffect(() => {
    document.fonts?.load('500 16px "IBM Plex Mono"').then(() => setFontRev((r) => r + 1)).catch(() => {})
  }, [])

  React.useEffect(() => {
    if (!source) return
    let live = true
    prepare(source.url)
      .then((p) => live && setPrep(p))
      .catch(() => live && toast("couldn't read that image", "error"))
    return () => {
      live = false
    }
  }, [source])

  React.useEffect(() => {
    if (!prep) return
    const raf = requestAnimationFrame(() => setPreview(render(prep, fx, 120).toDataURL("image/png")))
    return () => cancelAnimationFrame(raf)
  }, [prep, fx, fontRev])

  // keyboard: esc closes; ⌘z here undoes studio settings, not the profile
  const undoRef = React.useRef(undo)
  React.useEffect(() => {
    undoRef.current = undo
  })
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return e.stopImmediatePropagation(), onClose()
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return
      e.stopImmediatePropagation()
      if ((e.target as HTMLElement).closest("input, textarea")) return
      e.preventDefault()
      if (!e.shiftKey) undoRef.current()
    }
    addEventListener("keydown", onKey, true)
    return () => removeEventListener("keydown", onKey, true)
  }, [onClose])

  const s = slug(name)
  const finalName = s.startsWith("custom-") ? s : `custom-${s}`
  const pick = (src: Source) => {
    setSource(src)
    setName(slug(src.label))
  }
  const png = () => render(prep!, fx, SAVE_PX).toDataURL("image/png")

  const root = document.querySelector("[data-ds-root]") ?? document.body
  return createPortal(
    <div data-ds-modal role="dialog" aria-modal aria-labelledby="studio-title" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div data-kit="module" data-ds-modal-card data-ds-studio>
        <header data-ds-studio-head>
          <h2 id="studio-title">icon studio</h2>
          <p data-ds-note>turn any logo, glyph or app icon into pixel-art or ascii key art</p>
          <span data-ds-spacer />
          <Button disabled={!past.length} onClick={undo}>
            <Icon name="undo" /> undo
          </Button>
          <Button onClick={reset}>
            <Icon name="restart" /> reset
          </Button>
          <Button round aria-label="close" onClick={onClose}>
            <Icon name="close" />
          </Button>
        </header>
        <Sources current={source?.url ?? ""} onPick={pick} />
        <section data-ds-studio-stage aria-label="preview">
          <div data-ds-studio-big data-bg={fx.bg}>
            {preview && prep ? <img src={preview} alt="preview, magnified 3×" /> : <p data-ds-note>pick a source on the left</p>}
          </div>
          <div data-ds-studio-trues>
            <figure>
              <div data-ds-keycap>{preview && prep && <img src={preview} alt="true size preview" width={120} height={120} />}</div>
              <figcaption data-ds-note>true 120px</figcaption>
            </figure>
            <figure>
              <div data-ds-studio-mini>
                {[0, 1, 2, 3].map((i) => (
                  <div key={i} data-ds-keycap data-small>
                    {preview && prep && <img src={preview} alt="" />}
                  </div>
                ))}
              </div>
              <figcaption data-ds-note>small · legibility</figcaption>
            </figure>
          </div>
          <div data-ds-studio-save>
            <label data-kit="field">
              <span data-kit="label">logo name</span>
              <input data-kit="input" value={name} spellCheck={false} maxLength={64} placeholder="my-icon" onChange={(e) => setName(e.target.value)} />
            </label>
            <p data-ds-note>{s ? <>saves as <code>{finalName}</code> · 256×256 png</> : "letters, digits and dashes"}</p>
            <div data-ds-row>
              <Button
                tone="primary"
                disabled={!prep || !s || saving}
                onClick={async () => {
                  setSaving(true)
                  try {
                    const j = await api<{ name: string }>("POST", "/api/logos/save", { name: s, dataUrl: png() })
                    toast(`saved logo ${j.name}`)
                    onSaved?.(j.name)
                  } catch {
                    /* api() already toasted */
                  } finally {
                    setSaving(false)
                  }
                }}
              >
                <Icon name="save" /> {saving ? "saving…" : "save as logo"}
              </Button>
              {state.sel.kind === "key" && (
                <Button
                  disabled={!prep || !s || saving}
                  title="save this art and use it as the selected key's logo"
                  onClick={async () => {
                    const sel = state.sel as { kind: "key"; index: number } // captured now: the selection/page may change during the upload
                    const pg = page()
                    setSaving(true)
                    try {
                      const j = await api<{ name: string }>("POST", "/api/logos/save", { name: s, dataUrl: png() })
                      save()
                      const k = pg.keys[sel.index]
                      k.logo = j.name
                      delete k.glyph; delete k.sprite; delete k.bot; delete k.image
                      select(sel)
                      toast(`key ${sel.index + 1} now uses ${j.name}`)
                      onSaved?.(j.name)
                      onClose()
                    } catch {
                      /* api() already toasted */
                    } finally {
                      setSaving(false)
                    }
                  }}
                >
                  <Icon name="check" /> save &amp; put on key {(state.sel as { index: number }).index + 1}
                </Button>
              )}
              <Button
                disabled={!prep}
                onClick={() => {
                  const a = document.createElement("a")
                  a.href = png()
                  a.download = `${s || "icon"}.png`
                  a.click()
                }}
              >
                <Icon name="download" /> export png
              </Button>
            </div>
          </div>
        </section>
        <Controls fx={fx} set={set} gen={gen} />
      </div>
    </div>,
    root,
  )
}
