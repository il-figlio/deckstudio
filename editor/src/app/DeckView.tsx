// The Stream Deck+ as a SPEC-01 device: 8 lcd keys in their holes, the touch strip behind a
// display bezel, and 4 knobs. Images are the server's own renders, so this is a true mirror.
import * as React from "react"
import { Device } from "@/components/ui/device"
import { Display } from "@/components/ui/display"
import { Segmented } from "@/components/ui/segmented-control"
import { haptic } from "@/lib/haptics"
import { api, dialReadonly, page, readImage, save, select, sim, state, toast, touch, useStore } from "./store"

type Act = { type?: string; page?: string; target?: string; combo?: string; cmd?: string; url?: string; name?: string; command?: string; text?: string; desc?: string } | undefined
const act = (a: Act) => (a && a.type && a.type !== "none" ? a : undefined)
const describe = (a: Act): string => {
  if (!a?.type) return ""
  const arg = a.page ?? a.target ?? a.combo ?? a.url ?? a.name ?? a.command ?? a.text ?? a.cmd ?? ""
  return a.type === "internal" ? a.desc || "built-in action" : `${a.type}${arg ? " " + String(arg).slice(0, 40) : ""}`
}
// what each dial does on the current page, for hover tooltips
function dialTip(d: Record<string, any>): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  const mode = d.mode || "value"
  const ro = dialReadonly(d)
  const turn = ro ? (d.browse?.cmd ? "browse the list (value is a read-only live readout)" : "nothing: read-only live readout") : mode === "volume" ? "volume" : mode === "brightness" ? "brightness" : mode === "actions" ? `${describe(d.onLeft) || "–"} / ${describe(d.onRight) || "–"}` : `adjusts ${d.label || "value"}`
  const press = act(d.onPress) ? describe(d.onPress) : mode === "volume" ? "mute" : mode === "value" && d.default != null ? `reset to ${d.default}` : ""
  return [`turn: ${turn}`, `press: ${press || "nothing set"}`, `touch segment: ${act(d.onTouch) ? describe(d.onTouch) : "nothing set"}`, act(d.onLongTouch) ? `long touch: ${describe(d.onLongTouch)}` : ""].filter(Boolean).join("\n")
}
function stripTip(): string {
  const p = page()
  const st = p.strip || {}
  const n = Object.keys(state.profile!.pages).length
  const left = act(st.onSwipeLeft) ? describe(st.onSwipeLeft) : n > 1 ? "next page" : "nothing"
  const right = act(st.onSwipeRight) ? describe(st.onSwipeRight) : n > 1 ? "previous page" : "nothing"
  const lines = [`swipe left: ${left}`, `swipe right: ${right}`]
  if (st.mode === "full") lines.push(`tap: ${act(st.onTap) ? describe(st.onTap) : "nothing set"}`)
  else lines.push("tap a segment: its dial's touch action (hint shows 'tap' when set)")
  return lines.join("\n")
}

const flashing = (id: string) => Date.now() - (state.flash[id] || 0) < 260

function Key({ i }: { i: number }) {
  const [drop, setDrop] = React.useState(false)
  const keyHeld = React.useRef(false)
  const s = state.sel
  const selected = s.kind === "key" && s.index === i
  const live = state.mode === "live"
  return (
    <button
      type="button"
      data-ds-key
      data-selected={selected || undefined}
      data-flash={flashing(`key${i}`) || undefined}
      data-drop={drop || undefined}
      aria-label={`key ${i + 1}${page().keys[i]?.label ? `: ${page().keys[i].label}` : ""}`}
      title={act(page().keys[i]?.onPress) ? `press: ${describe(page().keys[i].onPress)}${act(page().keys[i]?.onLongPress) ? `\nhold: ${describe(page().keys[i].onLongPress)}` : ""}` : undefined}
      draggable={!live}
      onPointerDown={(e) => {
        if (!live || e.button !== 0 || !e.isPrimary) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        haptic("medium")
        const el = e.currentTarget
        const q = sim({ event: "keyDown", index: i })
        const up = () => {
          el.removeEventListener("pointerup", up)
          el.removeEventListener("pointercancel", up)
          q.finally(() => sim({ event: "keyUp", index: i }))
        }
        el.addEventListener("pointerup", up)
        el.addEventListener("pointercancel", up)
      }}
      onClick={() => !live && select({ kind: "key", index: i })}
      onKeyDown={(e) => {
        if (!live || (e.key !== "Enter" && e.key !== " ")) return
        e.preventDefault()
        if (!e.repeat) {
          keyHeld.current = true
          sim({ event: "keyDown", index: i })
        }
      }}
      onBlur={() => {
        if (live && keyHeld.current) {
          keyHeld.current = false
          sim({ event: "keyUp", index: i })
        }
      }}
      onKeyUp={(e) => {
        if (!live || (e.key !== "Enter" && e.key !== " ")) return
        e.preventDefault()
        if (!keyHeld.current) return
        keyHeld.current = false
        sim({ event: "keyUp", index: i })
      }}
      onDragStart={(e) => e.dataTransfer.setData("text/deck-key", String(i))}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("text/deck-key") || e.dataTransfer.types.includes("Files")) {
          e.preventDefault()
          setDrop(true)
        }
      }}
      onDragLeave={() => setDrop(false)}
      onDrop={async (e) => {
        setDrop(false)
        e.preventDefault()
        const keys = page().keys
        const file = e.dataTransfer.files[0]
        if (file) {
          try {
            const url = await readImage(file, 120, 120, keys[i].imageFit || "cover")
            save()
            keys[i].image = url
            select({ kind: "key", index: i })
          } catch (err) {
            toast(`could not read image: ${(err as Error).message}`, "error")
          }
          return
        }
        const from = Number(e.dataTransfer.getData("text/deck-key"))
        if (from === i || isNaN(from)) return
        save()
        ;[keys[from], keys[i]] = [keys[i], keys[from]]
        select({ kind: "key", index: i })
      }}
    >
      {state.frame.keys[i] ? <img src={state.frame.keys[i]} alt="" draggable={false} /> : <span data-ds-key-blank />}
      <span data-ds-key-num aria-hidden>{i + 1}</span>
    </button>
  )
}

function Strip() {
  const ref = React.useRef<HTMLDivElement>(null)
  const down = React.useRef<{ x: number; t: number } | null>(null)
  const full = page().strip?.mode === "full"
  const s = state.sel
  const pos = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return { x: ((e.clientX - r.left) * 800) / r.width, y: ((e.clientY - r.top) * 100) / r.height }
  }
  return (
    <div data-ds-strip-wrap data-selected={s.kind === "strip" || undefined} data-flash={flashing("strip") || undefined}>
      <Display aspect="8 / 1" label={full ? "touch strip · full width" : "touch strip · 4 segments"}>
        <div
          ref={ref}
          data-ds-strip
          title={stripTip()}
          tabIndex={0}
          role={state.mode === "live" ? "application" : "button"}
          aria-label={state.mode === "live" ? "touch strip: enter taps the middle, left/right arrows swipe" : "touch strip: click a segment to edit its dial"}
          onKeyDown={(e) => {
            if (state.mode === "edit") {
              if (e.key === "Enter" || e.key === " ") (e.preventDefault(), select({ kind: "strip" }))
              return
            }
            if (e.key === "Enter" || e.key === " ") sim({ event: "tap", x: 400, y: 50 })
            else if (e.key === "ArrowLeft") sim({ event: "swipe", fromX: 600, toX: 200 })
            else if (e.key === "ArrowRight") sim({ event: "swipe", fromX: 200, toX: 600 })
            else return
            e.preventDefault()
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !e.isPrimary) return
            e.currentTarget.setPointerCapture(e.pointerId)
            down.current = { x: pos(e).x, t: Date.now() }
          }}
          onPointerCancel={() => (down.current = null)}
          onPointerUp={(e) => {
            const d = down.current
            down.current = null
            if (!d) return
            const { x, y } = pos(e)
            if (state.mode === "edit") {
              if (full) return select({ kind: "strip" })
              return select({ kind: "dial", index: Math.min(3, Math.max(0, Math.floor(x / 200))) })
            }
            haptic("light")
            if (Math.abs(x - d.x) > 40) sim({ event: "swipe", fromX: d.x, toX: x })
            else sim({ event: "tap", x: Math.max(0, Math.min(799, x)), y, long: Date.now() - d.t > 500 })
          }}
        >
          {state.frame.strip && <img src={state.frame.strip} alt="" draggable={false} />}
          {!full && (
            <div data-ds-zones aria-hidden>
              {[0, 1, 2, 3].map((i) => (
                <span key={i} data-selected={(s.kind === "dial" && s.index === i) || undefined} />
              ))}
            </div>
          )}
        </div>
      </Display>
      <button type="button" data-ds-strip-btn data-selected={s.kind === "strip" || undefined} onClick={() => select({ kind: "strip" })}>
        strip settings · layout & swipes
      </button>
    </div>
  )
}

const TICKS = 27
function Knob({ i }: { i: number }) {
  const drag = React.useRef<{ y: number; acc: number; moved: boolean } | null>(null)
  const wheelAcc = React.useRef(0)
  const justDragged = React.useRef(false)
  const info = state.dials[i]
  const lit = info?.pct != null ? Math.round(info.pct * TICKS) : -1
  const live = state.mode === "live"
  const s = state.sel
  const selected = s.kind === "dial" && s.index === i
  const d = page().dials[i] || {}
  const fixed = info ? !!info.readonly : dialReadonly(d) // a live readout: the knob doesn't turn its value
  const rotate = (delta: number) => {
    if (fixed && !d.browse?.cmd) return
    haptic("selection")
    sim({ event: "rotate", index: i, delta })
  }
  return (
    <div data-ds-knob-cell>
      <div
        data-kit="knob"
        data-ds-knob
        data-selected={selected || undefined}
        data-readonly={fixed || undefined}
        data-flash={flashing(`dial${i}`) || undefined}
        style={{ "--turn": `${state.turn[i]}deg` } as React.CSSProperties}
      >
        <div
          data-kit="knob-dial"
          role={live ? "spinbutton" : "button"}
          tabIndex={0}
          title={dialTip(d)}
          aria-label={`dial ${i + 1}${d.label ? `: ${d.label}` : ""}`}
          aria-description={live ? "arrows turn, enter presses; drag or scroll to turn, click to press" : "drag or scroll to turn, click to edit"}
          aria-valuenow={typeof info?.value === "number" ? info.value : undefined}
          aria-readonly={fixed || undefined}
          onWheel={(e) => {
            // turning works in both modes: the knob is the real dial
            wheelAcc.current += e.deltaMode === 1 ? Math.sign(e.deltaY) * 40 : e.deltaY
            const n = Math.trunc(wheelAcc.current / 40)
            if (!n) return
            wheelAcc.current -= n * 40
            rotate(-Math.max(-5, Math.min(5, n)))
          }}
          onPointerDown={(e) => {
            if (e.button !== 0 || !e.isPrimary) return
            e.currentTarget.setPointerCapture(e.pointerId)
            drag.current = { y: e.clientY, acc: 0, moved: false }
          }}
          onPointerMove={(e) => {
            const g = drag.current
            if (!g) return
            const dy = g.y - e.clientY
            g.y = e.clientY
            g.acc += dy
            const n = Math.trunc(g.acc / 12)
            if (!n) return
            g.acc -= n * 12
            g.moved = true
            justDragged.current = true
            rotate(n)
          }}
          onPointerUp={() => {
            const g = drag.current
            drag.current = null
            if (g && !g.moved && live) {
              haptic("medium")
              sim({ event: "dialDown", index: i }).then(() => sim({ event: "dialUp", index: i }))
            }
          }}
          onPointerCancel={() => (drag.current = null)}
          onClick={() => { if (!live && !justDragged.current) select({ kind: "dial", index: i }); justDragged.current = false }}
          onKeyDown={(e) => {
            if (!live) {
              if (e.key === "Enter" || e.key === " ") (e.preventDefault(), select({ kind: "dial", index: i }))
              return
            }
            if (e.repeat && (e.key === "Enter" || e.key === " ")) return
            if (e.key === "ArrowUp" || e.key === "ArrowRight") rotate(1)
            else if (e.key === "ArrowDown" || e.key === "ArrowLeft") rotate(-1)
            else if (e.key === "Enter" || e.key === " ") sim({ event: "dialDown", index: i }).then(() => sim({ event: "dialUp", index: i }))
            else return
            e.preventDefault()
          }}
        >
          <svg data-kit="knob-ticks" viewBox="-50 -50 100 100" aria-hidden>
            {Array.from({ length: TICKS + 1 }, (_, t) => {
              const a = ((-135 + (t / TICKS) * 270 - 90) * Math.PI) / 180
              return <line key={t} x1={Math.cos(a) * 40} y1={Math.sin(a) * 40} x2={Math.cos(a) * 50} y2={Math.sin(a) * 50} data-major={t % 9 === 0 || undefined} data-lit={t <= lit || undefined} />
            })}
          </svg>
          <span data-kit="knob-cap" />
        </div>
        <span data-kit="label">{info?.label || d.label || `dial ${i + 1}`}</span>
        <span data-ds-knob-value>{info?.value == null ? "—" : typeof info.value === "number" ? Math.round(info.value) : String(info.value).slice(0, 14)}</span>
      </div>
    </div>
  )
}

function PageTabs() {
  const pages = Object.entries(state.profile!.pages)
  return (
    <div data-ds-tabs>
      <Segmented
        label="page"
        hideLabel
        value={state.page}
        options={pages.map(([id, pg]) => ({ value: id, label: `${id === state.profile!.startPage ? "★ " : ""}${pg.name}` }))}
        onValueChange={(id) => {
          if (id !== state.page) api("POST", "/api/goto", { page: id })
        }}
      />
    </div>
  )
}

export function DeckView() {
  useStore()
  // re-render shortly after flashes so they clear
  React.useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now()
      let expired = false
      for (const [id, at] of Object.entries(state.flash)) if (now - at >= 260) (delete state.flash[id], (expired = true))
      if (expired) touch()
    }, 300)
    return () => clearInterval(t)
  }, [])
  if (!state.profile || !page()) return null
  const connected = state.status.state === "connected"
  return (
    <div data-ds-stage>
      <PageTabs />
      <Device model="SD+" name={connected ? state.status.detail.split("·")[0].trim().toLowerCase() : "stream deck +"} on={connected}>
        <div data-ds-deck data-mode={state.mode}>
          <div data-ds-keys>
            {Array.from({ length: 8 }, (_, i) => <Key key={i} i={i} />)}
          </div>
          <Strip />
          <div data-ds-knobs>
            {[0, 1, 2, 3].map((i) => <Knob key={i} i={i} />)}
          </div>
        </div>
      </Device>
      <p data-ds-hint>
        {state.mode === "edit"
          ? "edit · click a key, strip segment or knob to customize it · drag keys to swap · drop an image on a key"
          : "live · press keys (hold for long-press) · drag or scroll knobs to turn, click to press · tap or swipe the strip"}
      </p>
    </div>
  )
}
