// Inspector field builders on top of the SPEC-01 kit. Each binds to obj[key], saves on change,
// and treats an empty value as "inherit" (the key is deleted).
import * as React from "react"
import { TextField } from "@/components/ui/text-field"
import { Textarea } from "@/components/ui/textarea"
import { Stepper } from "@/components/ui/stepper"
import { Segmented } from "@/components/ui/segmented-control"
import { Switch } from "@/components/ui/switch"
import { Select } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { IconStudio, Thumb } from "./IconStudio"
import { readImage, setOrDel, state, toast, touch, save, TOKEN } from "./store"

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>

type After = { after?: () => void }
export function Text({ obj, k, label, placeholder, after }: { obj: Obj; k: string; label: string; placeholder?: string } & After) {
  return <TextField label={label} defaultValue={obj[k] ?? ""} placeholder={placeholder} onValueChange={(v) => (setOrDel(obj, k, v), after?.())} />
}

export function Area({ obj, k, label, placeholder, after }: { obj: Obj; k: string; label: string; placeholder?: string } & After) {
  return <Textarea label={label} defaultValue={obj[k] ?? ""} placeholder={placeholder} onValueChange={(v) => (setOrDel(obj, k, v), after?.())} />
}

export function Num({
  obj, k, label, min = -9999, max = 9999, step = 1, check, after,
}: { obj: Obj; k: string; label: string; min?: number; max?: number; step?: number; check?: (v: number) => string | false } & After) {
  // Validate only committed values (blur, Enter, a step button), never half-typed ones like "1" of "150".
  const [n, remount] = React.useReducer((x: number) => x + 1, 0)
  return (
    <Stepper
      key={n}
      label={label}
      defaultValue={typeof obj[k] === "number" ? obj[k] : null}
      min={min}
      max={max}
      step={step}
      onValueCommit={(v) => {
        if (v === (obj[k] ?? null)) return
        const err = v != null && check?.(v)
        if (err) {
          toast(err, "error")
          remount() // snap the field back to the saved value
          return
        }
        setOrDel(obj, k, v)
        after?.()
        touch()
      }}
    />
  )
}

export function Choice({
  obj, k, label, options, dflt, onChange,
}: { obj: Obj; k: string; label: string; options: { value: string; label: string }[]; dflt: string; onChange?: () => void }) {
  return (
    <Segmented
      label={label}
      options={options}
      value={obj[k] ?? dflt}
      onValueChange={(v) => {
        setOrDel(obj, k, v === dflt ? "" : v)
        onChange?.()
        touch()
      }}
    />
  )
}

export function Wheel({
  obj, k, label, options, dflt, onChange,
}: { obj: Obj; k: string; label: string; options: { value: string; label: string }[]; dflt: string; onChange?: (v: string) => void }) {
  const cb = React.useCallback(
    (v: string) => {
      if (onChange) onChange(v)
      else setOrDel(obj, k, v)
      touch()
    },
    [obj, k, onChange],
  )
  return <Select label={label} options={options} defaultValue={obj[k] ?? dflt} onValueChange={cb} />
}

export function Toggle({ obj, k, label, invert }: { obj: Obj; k: string; label: string; invert?: boolean }) {
  return (
    <Switch
      label={label}
      defaultChecked={invert ? !obj[k] : !!obj[k]}
      onCheckedChange={(c) => {
        setOrDel(obj, k, (invert ? !c : c) || "")
        touch()
      }}
    />
  )
}

// A color, or comma-separated colors for a gradient ("#ff5c8a, #7c5cff").
const cssHex = (v: unknown) => {
  const c = document.createElement("canvas").getContext("2d")!
  c.fillStyle = "#000"
  c.fillStyle = String(v || "#000")
  return /^#[0-9a-f]{6}$/i.test(c.fillStyle) ? c.fillStyle : "#000000"
}
const asText = (v: unknown) => (Array.isArray(v) ? v.join(", ") : ((v as string) ?? ""))
export function Color({ obj, k, label, gradient, inherit }: { obj: Obj; k: string; label: string; gradient?: boolean; inherit?: unknown }) {
  const [text, setText] = React.useState(asText(obj[k]))
  const first = (Array.isArray(obj[k]) ? obj[k][0] : obj[k]) || (Array.isArray(inherit) ? inherit[0] : inherit)
  const parse = (s: string) => {
    const parts = s.split(",").map((x) => x.trim()).filter(Boolean)
    return gradient && parts.length > 1 ? parts : parts[0] || ""
  }
  return (
    <div data-kit="field" data-ds-color>
      <span data-kit="label">{label}</span>
      <div data-ds-color-row>
        <label data-ds-swatch style={{ background: Array.isArray(obj[k]) ? `linear-gradient(135deg, ${obj[k].join(",")})` : cssHex(first) }}>
          <input
            type="color"
            value={cssHex(first)}
            aria-label={`${label} color picker`}
            onChange={(e) => {
              save()
              if (Array.isArray(obj[k])) obj[k][0] = e.target.value
              else obj[k] = e.target.value
              setText(asText(obj[k]))
              touch()
            }}
          />
        </label>
        <input
          data-kit="input"
          value={text}
          spellCheck={false}
          placeholder={inherit ? `inherit (${asText(inherit)})` : "inherit"}
          title={gradient ? "a color, or comma-separated colors for a gradient" : undefined}
          onChange={(e) => {
            setText(e.target.value)
            setOrDel(obj, k, parse(e.target.value))
            touch()
          }}
        />
      </div>
    </div>
  )
}

export function ImageField({ obj, k, label, w, h, fit }: { obj: Obj; k: string; label: string; w: number; h: number; fit: () => string }) {
  const input = React.useRef<HTMLInputElement>(null)
  return (
    <div data-kit="field">
      <span data-kit="label">{label}</span>
      <div data-ds-image-row>
        {obj[k] ? <img data-ds-thumb src={obj[k]} alt="" /> : <span data-ds-thumb data-empty />}
        <Button onClick={() => input.current?.click()}>
          <Icon name="upload" /> {obj[k] ? "replace" : "upload"}
        </Button>
        {obj[k] && (
          <Button
            onClick={() => {
              setOrDel(obj, k, "")
              state.formKey++
              touch()
            }}
          >
            <Icon name="trash" /> remove
          </Button>
        )}
        <input
          ref={input}
          type="file"
          accept="image/*"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0]
            e.target.value = ""
            if (!f) return
            try {
              const url = await readImage(f, w, h, fit())
              setOrDel(obj, k, url)
              state.formKey++
              touch()
            } catch (err) {
              toast(`could not read image (${(err as Error).message || "unsupported format"})`, "error")
            }
          }}
        />
      </div>
    </div>
  )
}

export function Group({ legend, children }: { legend: string; children: React.ReactNode }) {
  return (
    <fieldset data-kit="fieldset" data-ds-group>
      <legend data-kit="legend">{legend}</legend>
      <div data-kit="fieldset-body" data-ds-group-body>
        {children}
      </div>
    </fieldset>
  )
}

export function Note({ children }: { children: React.ReactNode }) {
  return <p data-ds-note>{children}</p>
}

// Carbon glyph picker: search ~2,600 icons by name; the device draws the same SVGs.
export function GlyphPicker({ obj, k, label }: { obj: Obj; k: string; label: string }) {
  const [q, setQ] = React.useState<string>(obj[k] ?? "")
  const [res, setRes] = React.useState<{ total: number; names: string[] }>({ total: 0, names: [] })
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    if (!open) return
    const t = setTimeout(async () => {
      const r = await fetch(`/api/glyphs?q=${encodeURIComponent(q)}`, { headers: { "x-deck-token": TOKEN } })
      if (r.ok) setRes(await r.json())
    }, 120)
    return () => clearTimeout(t)
  }, [q, open])
  const choose = (name: string) => {
    setOrDel(obj, k, name)
    setQ(name)
    setOpen(false)
    touch()
  }
  return (
    <div data-kit="field" data-ds-glyph>
      <span data-kit="label">{label}</span>
      <div data-ds-color-row>
        <span data-ds-glyph-preview>{obj[k] ? <img src={`/glyphs/${obj[k]}.svg`} alt="" /> : null}</span>
        <input
          data-kit="input"
          value={q}
          spellCheck={false}
          placeholder="search carbon icons · rocket, play, volume…"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setQ(e.target.value)
            setOpen(true)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && res.names[0]) (e.preventDefault(), choose(res.names[0]))
            if (e.key === "Escape") setOpen(false)
          }}
        />
        {obj[k] && (
          <Button round aria-label="remove glyph" onClick={() => (setOrDel(obj, k, ""), setQ(""), touch())}>
            <Icon name="close" />
          </Button>
        )}
      </div>
      {open && (
        <div data-ds-glyph-grid role="listbox" aria-label="icons">
          {res.names.map((n) => (
            <button key={n} type="button" role="option" aria-selected={obj[k] === n} title={n} onClick={() => choose(n)}>
              <Thumb src={`/glyphs/${n}.svg`} alt={n} />
            </button>
          ))}
          <p data-ds-note>{res.total > res.names.length ? `${res.names.length} of ${res.total} — keep typing` : `${res.total} icons`}</p>
        </div>
      )}
    </div>
  )
}

// Genuine logos (app icons, brand marks): assets/logos plus ~/.deckstudio/logos, and "use this app's real icon".
export function LogoPicker({ obj, k, label, bundleId }: { obj: Obj; k: string; label: string; bundleId?: string }) {
  const [logos, setLogos] = React.useState<{ name: string; file: string; url?: string }[]>([])
  const [studio, setStudio] = React.useState(false)
  const load = React.useCallback(() => {
    fetch("/api/logos", { headers: { "x-deck-token": TOKEN } }).then((r) => r.json()).then((j) => setLogos(j.logos || [])).catch(() => {})
  }, [])
  React.useEffect(load, [load])
  const cur = logos.find((l) => l.name === obj[k])
  const file = cur ? (cur.url ?? `/logos/${cur.file}`) : undefined
  return (
    <div data-kit="field" data-ds-glyph>
      <span data-kit="label">{label}</span>
      <div data-ds-color-row>
        <span data-ds-glyph-preview>{file ? <img src={file} alt="" /> : null}</span>
        <span data-ds-note style={{ flex: 1 }}>{obj[k] || "none — uses the glyph / icon below"}</span>
        {bundleId && /^[A-Za-z0-9.-]+$/.test(bundleId) && (
          <Button
            onClick={async () => {
              const r = await fetch("/api/logos/from-app", { method: "POST", headers: { "x-deck-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ bundleId }) })
              const j = await r.json()
              if (!r.ok) return toast(j.error || "couldn't read that app's icon", "error")
              setOrDel(obj, k, j.name)
              load()
              touch()
            }}
          >
            <Icon name="image" /> use app icon
          </Button>
        )}
        <Button onClick={() => setStudio(true)} title="make pixel-art or ascii key art in icon studio">
          <Icon name="brush" /> studio
        </Button>
        {studio && (
          <IconStudio
            onClose={() => setStudio(false)}
            onSaved={(name) => {
              setOrDel(obj, k, name)
              setStudio(false)
              load()
              touch()
            }}
          />
        )}
        {obj[k] && (
          <Button round aria-label="remove logo" onClick={() => (setOrDel(obj, k, ""), touch())}>
            <Icon name="close" />
          </Button>
        )}
      </div>
      <div data-ds-glyph-grid data-color role="listbox" aria-label="logos">
        {logos.map((l) => (
          <button key={l.name} type="button" role="option" aria-selected={obj[k] === l.name} title={l.name} onClick={() => (setOrDel(obj, k, l.name), touch())}>
            <Thumb src={l.url ?? `/logos/${l.file}`} alt={l.name} />
          </button>
        ))}
      </div>
    </div>
  )
}
