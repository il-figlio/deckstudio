import * as React from "react"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { Segmented } from "@/components/ui/segmented-control"
import { Area, Choice, Color, GlyphPicker, Group, ImageField, LogoPicker, Note, Num, Text, Toggle, Wheel } from "./fields"
import { BotProviders, KeyBotPicker, PageBots } from "./Bots"
import { AgentProviders } from "./Agents"
import { PluginActionFields, PluginGroup } from "./Plugins"
import {
  addPage, api, clone, deletePage, dialReadonly, flushSave, movePage, page, save, select, setOrDel, state, toast, touch, useStore,
  type Action,
} from "./store"

/* eslint-disable @typescript-eslint/no-explicit-any */
type Obj = Record<string, any>

const ACTION_LABELS: Record<string, string> = {
  none: "nothing", page: "go to page", back: "previous page", shell: "shell command", open: "open url / app / file",
  keys: "keyboard shortcut", type: "type text", applescript: "applescript", shortcut: "macos shortcut", http: "http request",
  media: "media key", volume: "change volume", brightness: "deck brightness", multi: "several (json)",
  app: "open app", "hold-keys": "hold keys (push-to-talk)", "agents-next": "go to agent needing me",
  "mic-mute": "mute microphone", "audio-input": "switch microphone", "audio-output": "switch output",
  capture: "screenshot / recording", plugin: "plugin action",
}
const CAPTURE_MODES = [
  { value: "screen", label: "full screen" }, { value: "selection", label: "selection" }, { value: "window", label: "window" },
  { value: "record", label: "record screen (toggle)" }, { value: "toolbar", label: "screenshot toolbar ⌘⇧5" },
  { value: "folder", label: "open screenshots folder" }, { value: "copy-last", label: "copy last capture's path" },
  { value: "reveal-last", label: "show last capture in finder" }, { value: "open-last", label: "open last capture" },
  { value: "check", label: "check screen recording permission" },
]
const HINTS: Record<string, string> = {
  device: "device name or uid",
  cmd: "zsh · $DECK_VALUE $DECK_DELTA $DECK_X $DECK_PAGE",
  target: "https://…, ~/file, or an app name like Safari",
  combo: "cmd+shift+4, ctrl+left, f5",
  url: "https://…  ({value} is url-encoded)",
  text: "text to type",
  name: "shortcut name",
  input: "optional input",
  script: 'display notification "hi"',
  body: '{"value": "{value}"}',
}

function ActionEditor({ owner, k, label }: { owner: Obj; k: string; label: string }) {
  useStore()
  const cur: Action = owner[k] || { type: "none" }
  const [testing, setTesting] = React.useState(false)
  const types = Object.keys(state.actionTypes).map((t) => ({ value: t, label: ACTION_LABELS[t] || t }))
  const pages = Object.entries(state.profile!.pages).map(([id, pg]) => ({ value: id, label: pg.name }))
  const setType = React.useCallback(
    (t: string) => {
      if (t === (owner[k]?.type || "none")) return
      save()
      if (t === "none") delete owner[k]
      else owner[k] = t === "page" ? { type: t, page: pages.find((p) => p.value !== state.page)?.value ?? state.page } : { type: t }
      touch()
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [owner, k],
  )
  return (
    <div data-ds-action>
      <Wheel obj={{ t: cur.type }} k="t" label={label} options={types} dflt="none" onChange={setType} />
      <div data-ds-action-params key={cur.type}>
        {cur.type === "plugin" && <PluginActionFields cur={cur} />}
        {cur.type !== "plugin" && (state.actionTypes[cur.type] || []).map((p) => {
          if (p === "page") return <Wheel key={p} obj={cur} k="page" label="page" options={pages} dflt={pages[0]?.value} />
          if (p === "method")
            return <Choice key={p} obj={cur} k="method" label="method" dflt="GET" options={["GET", "POST", "PUT", "DELETE"].map((m) => ({ value: m, label: m }))} />
          if (p === "mode" && cur.type === "mic-mute")
            return <Choice key={p} obj={cur} k="mode" label="mode" dflt="toggle" options={[{ value: "toggle", label: "toggle" }, { value: "on", label: "mute" }, { value: "off", label: "unmute" }]} />
          if (p === "mode" && cur.type === "capture") return <Wheel key={p} obj={cur} k="mode" label="capture" options={CAPTURE_MODES} dflt="screen" />
          if (p === "to" && cur.type === "capture")
            return ["screen", "selection", "window", undefined].includes(cur.mode)
              ? <Choice key={p} obj={cur} k="to" label="to" dflt="file" options={[{ value: "file", label: "file" }, { value: "clipboard", label: "clipboard" }]} />
              : null
          if (p === "delay" && cur.type === "capture")
            return !cur.mode || cur.mode === "screen" ? <Text key={p} obj={cur} k="delay" label="delay (s)" placeholder="0 · 5 · {value} = the dial's value · wins over the dial below" /> : null
          if (cur.type === "capture") {
            const shot = !cur.mode || ["screen", "selection", "window"].includes(cur.mode), rec = cur.mode === "record"
            if (p === "delayDial")
              return !cur.mode || cur.mode === "screen" ? (
                <Segmented key={p} label="delay from dial (secs = that dial's value)" options={["off", "1", "2", "3", "4"].map((v) => ({ value: v, label: v }))}
                  value={cur.delayDial != null ? String(cur.delayDial) : "off"} onValueChange={(v) => { setOrDel(cur, "delayDial", v === "off" ? "" : Number(v)); touch() }} />
              ) : null
            if (p === "cursor") {
              if (rec)
                return (
                  <Segmented key={p} label="pointer" options={[{ value: "show", label: "show" }, { value: "hide", label: "hide" }]}
                    value={cur.cursor === false ? "hide" : "show"} onValueChange={(v) => { setOrDel(cur, "cursor", v === "hide" ? false : ""); touch() }} />
                )
              return !cur.mode || cur.mode === "screen" ? <Toggle key={p} obj={cur} k="cursor" label="include the pointer" /> : null
            }
            if (p === "sound") return shot ? <Toggle key={p} obj={cur} k="sound" label="shutter sound" /> : null
            if (p === "audio") return rec ? <Toggle key={p} obj={cur} k="audio" label="record the microphone" /> : null
            if (p === "clicks") return rec ? <Toggle key={p} obj={cur} k="clicks" label="show clicks" /> : null
            if (p === "maxSeconds") return rec ? <Num key={p} obj={cur} k="maxSeconds" label="stop after (s, default 3 h)" min={1} max={86400} /> : null
          }
          if (p === "target" && cur.type === "app") return <AppField key={p} obj={cur} k="target" label="app" />
          if (p === "combo" && cur.type === "hold-keys") return <Text key={p} obj={cur} k="combo" label="combo held while pressed" placeholder="ropt · fn · ctrl+space — match your dictation hotkey" />
          if (p === "device") return <DeviceField key={p} obj={cur} k="device" kind={cur.type === "audio-input" ? "input" : "output"} />
          if (p === "command")
            return (
              <Choice key={p} obj={cur} k="command" label="key" dflt="playpause"
                options={[{ value: "playpause", label: "play" }, { value: "next", label: "next" }, { value: "previous", label: "prev" }, { value: "mute", label: "mute" }]} />
            )
          if (p === "step") return <Num key={p} obj={cur} k="step" label="step per detent" min={-100} max={100} />
          if (p === "actions") return <MultiJson key={p} cur={cur} />
          if (p === "cmd" || p === "script" || p === "body") return <Area key={p} obj={cur} k={p} label={p === "cmd" ? "command" : p} placeholder={HINTS[p]} />
          return <Text key={p} obj={cur} k={p} label={p} placeholder={HINTS[p]} />
        })}
        {cur.type === "shell" && <Toggle obj={cur} k="toast" label="flash output on strip" />}
      </div>
      {cur.type !== "none" && (
        <Button
          disabled={testing}
          onClick={async () => {
            setTesting(true)
            try {
              await flushSave()
              const s = state.sel as { index?: number }
              await api("POST", "/api/run", { action: cur, index: s.index })
            } finally {
              setTesting(false)
            }
          }}
        >
          <Icon name="play" /> test
        </Button>
      )}
    </div>
  )
}

type RunningApp = { bundleId: string; name: string }
function useRunningApps() {
  const [apps, setApps] = React.useState<RunningApp[]>([])
  React.useEffect(() => {
    api<{ running: RunningApp[] }>("GET", "/api/apps").then((r) => setApps(r.running.filter((a) => a.bundleId))).catch(() => {})
  }, [])
  return apps
}
function AppField({ obj, k, label }: { obj: Obj; k: string; label: string }) {
  const apps = useRunningApps()
  return (
    <>
      <Text obj={obj} k={k} label={label} placeholder="bundle id (com.superlogical.rex) or app name" />
      {apps.length > 0 && (
        <div data-ds-chips>
          {apps.slice(0, 18).map((a) => (
            <button key={a.bundleId} type="button" data-on={obj[k] === a.bundleId || undefined} onClick={() => { save(); obj[k] = a.bundleId; select(state.sel) }}>
              {a.name}
            </button>
          ))}
        </div>
      )}
    </>
  )
}
function DeviceField({ obj, k, kind }: { obj: Obj; k: string; kind: "input" | "output" }) {
  const [devs, setDevs] = React.useState<{ name: string; uid: string; input: boolean; output: boolean }[]>([])
  React.useEffect(() => { api("GET", "/api/audio").then((a) => setDevs(a.devices || [])).catch(() => {}) }, [])
  return (
    <>
      <Text obj={obj} k={k} label={`${kind} device`} placeholder={HINTS.device} />
      <div data-ds-chips>
        {devs.filter((d) => d[kind]).map((d) => (
          <button key={d.uid} type="button" data-on={obj[k] === d.name || undefined} onClick={() => { save(); obj[k] = d.name; select(state.sel) }}>
            {d.name}
          </button>
        ))}
      </div>
    </>
  )
}
// Pages that take over while given apps are frontmost (like Elgato's smart profiles)
function AppsForPage({ pg }: { pg: Obj }) {
  const apps = useRunningApps()
  const list: string[] = Array.isArray(pg.apps) ? pg.apps : []
  const set = (next: string[]) => {
    save()
    if (next.length) pg.apps = next
    else delete pg.apps
    touch()
  }
  const name = (id: string) => apps.find((a) => a.bundleId === id)?.name || id
  return (
    <>
      <div data-ds-chips>
        {list.length === 0 && <span data-ds-note>no apps — this page only shows when you go to it.</span>}
        {list.map((id) => (
          <button key={id} type="button" data-on title={`${id} — click to remove`} onClick={() => set(list.filter((x) => x !== id))}>
            {name(id)} ✕
          </button>
        ))}
      </div>
      <span data-kit="label">add a running app</span>
      <div data-ds-chips>
        {apps.filter((a) => !list.includes(a.bundleId)).slice(0, 24).map((a) => (
          <button key={a.bundleId} type="button" title={a.bundleId} onClick={() => set([...list, a.bundleId])}>
            + {a.name}
          </button>
        ))}
      </div>
    </>
  )
}

function MultiJson({ cur }: { cur: Action }) {
  const [bad, setBad] = React.useState(false)
  return (
    <div data-kit="field" data-invalid={bad || undefined}>
      <span data-kit="label">actions (json list)</span>
      <textarea
        data-kit="input"
        data-multiline=""
        spellCheck={false}
        defaultValue={JSON.stringify(cur.actions || [], null, 1)}
        onChange={(e) => {
          try {
            const v = JSON.parse(e.target.value)
            if (!Array.isArray(v)) throw new Error()
            save()
            cur.actions = v
            setBad(false)
          } catch {
            setBad(true)
          }
        }}
      />
    </div>
  )
}

function Poll({ obj, legend }: { obj: Obj; legend: string }) {
  const p = React.useMemo(() => obj.poll ?? {}, [obj])
  // attach/detach the poll object as its command is filled/cleared
  const sync = () => {
    if (p.cmd) obj.poll = p
    else delete obj.poll
  }
  return (
    <Group legend={legend}>
      <Area obj={p} k="cmd" label="command" placeholder="date +%H:%M   (first line of stdout → {out})" after={sync} />
      <Num obj={p} k="interval" label="every (seconds)" min={1} max={3600} after={sync} />
    </Group>
  )
}

function Head({ title, sub }: { title: string; sub: string }) {
  return (
    <header data-ds-head>
      <h2>{title}</h2>
      <p>{sub}</p>
    </header>
  )
}

function KeyPanel({ index }: { index: number }) {
  const pg = page()
  const k = (pg.keys[index] ??= {})
  const theme = state.profile!.theme
  const spec = theme.style === "spec"
  return (
    <>
      <Head title={`key ${index + 1}`} sub={`${pg.name} · 120×120 lcd key`} />
      {pg.source && <Note>⚡ this page is generated live from {pg.source === "rex" ? "your agents" : "your audio devices"}. settings here apply only when the slot is empty.</Note>}
      {spec && (
        <Group legend="keycap">
          <Choice obj={k} k="face" label="face" dflt="cap" onChange={() => select(state.sel)}
            options={[{ value: "cap", label: "keycap" }, { value: "lcd", label: "lcd window" }, { value: "screen", label: "screen" }]} />
          <Choice obj={k} k="tone" label="cap color" dflt="paper"
            options={[{ value: "paper", label: "paper" }, { value: "black", label: "black" }, { value: "key", label: "key color" }]} />
          <KeyBotPicker k={k} />
          <LogoPicker obj={k} k="logo" label="logo (genuine app icon / brand mark)"
            bundleId={k.onPress?.type === "app" ? String(k.onPress.target || "").split(",")[0].trim() : undefined} />
          <GlyphPicker obj={k} k="glyph" label="glyph (carbon icon, if no logo)" />
          <Choice obj={k} k="motion" label="animate the icon" dflt=""
            options={[{ value: "", label: "still" }, { value: "bob", label: "bob" }, { value: "pulse", label: "pulse" }, { value: "breathe", label: "breathe" }, { value: "flicker", label: "flicker" }, { value: "shake", label: "shake" }, { value: "spin", label: "spin" }]} />
          <Note>images can be animated gifs too — upload one under face → image.</Note>
          <Toggle obj={k} k="led" label="lamp lit" />
          {k.led && <Color obj={k} k="ledColor" label="lamp color" inherit={theme.accent} />}
          {k.face === "lcd" && <Text obj={k} k="caption" label="caption under window" placeholder="printed legend" />}
        </Group>
      )}
      <Group legend="face">
        <Text obj={k} k="icon" label={spec ? "icon (emoji / text, if no glyph)" : "icon"} placeholder="emoji or short text · 🚀" />
        <Text obj={k} k="label" label="label" placeholder="{out} poll output · {page} page name" />
        <Text obj={k} k="title" label="top title" placeholder="small caption" />
        <ImageField obj={k} k="image" label="image" w={120} h={120} fit={() => k.imageFit || "cover"} />
        <Choice obj={k} k="imageFit" label="image fit" dflt="cover" options={[{ value: "cover", label: "fill" }, { value: "contain", label: "fit" }]} />
      </Group>
      <PluginGroup obj={k} fields={[{ k: "label", label: "label" }, { k: "title", label: "top title" }, ...(k.face === "lcd" ? [{ k: "caption", label: "caption" }] : [])]} />
      <Group legend="color & type">
        <Color obj={k} k="bg" label={spec ? "custom cap color" : "background"} gradient inherit={spec ? undefined : theme.keyBg} />
        <Color obj={k} k="fg" label="text" inherit={theme.fg} />
        <Color obj={k} k="border" label="border" />
        <div data-ds-pair>
          <Num obj={k} k="fontSize" label="label size" min={10} max={60} />
          <Num obj={k} k="iconSize" label="icon size" min={14} max={110} />
        </div>
        <Num obj={k} k="progress" label="progress (0–1)" min={0} max={1} step={0.05} />
      </Group>
      <Group legend="press">
        <ActionEditor owner={k} k="onPress" label="on press" />
      </Group>
      <Group legend="hold">
        <ActionEditor owner={k} k="onLongPress" label="on long press" />
        <Note>when set, a normal press fires on release instead of on press.</Note>
      </Group>
      <Poll obj={k} legend="live data" />
      <div data-ds-row>
        <Button onClick={() => { state.clip.key = clone(k); toast("key copied — select any key and paste"); touch() }}><Icon name="copy" /> copy</Button>
        <Button disabled={!state.clip.key} onClick={() => { save(); pg.keys[index] = clone(state.clip.key!); select(state.sel) }}><Icon name="paste" /> paste</Button>
        <Button onClick={() => { save(); pg.keys[index] = {}; select(state.sel) }}><Icon name="erase" /> clear</Button>
      </div>
    </>
  )
}

// Value dials that only show a live readout (a poll, no on-change) are read-only: turning would just
// fight the next poll. `readonly` overrides the guess; `browse` gives turning a job instead.
function DialTurning({ d }: { d: Obj }) {
  const ro = dialReadonly(d)
  const v = d.readonly === true ? "readonly" : d.readonly === false ? "adjustable" : "auto"
  return (
    <>
      <Segmented
        label="turning"
        value={v}
        options={[{ value: "auto", label: "auto" }, { value: "readonly", label: "read-only" }, { value: "adjustable", label: "adjustable" }]}
        onValueChange={(x) => { setOrDel(d, "readonly", x === "readonly" ? true : x === "adjustable" ? false : ""); select(state.sel) }}
      />
      <Note>
        {ro
          ? <>read-only live readout{v === "auto" ? " (it polls a value and has no on-change)" : ""}: turning never changes the number, on the deck or here. {d.browse?.cmd ? "turning steps through the browse list below instead; the segment shows each item for 5 s, then the live value again." : "add a browse command below to make turning step through a list."}</>
          : v === "auto" ? "turning changes the value between min and max; press resets it when “press resets to” is set. a dial with a live poll and no on-change turns read-only." : "turning changes the value, even though a poll also sets it."}
      </Note>
    </>
  )
}

function Browse({ d }: { d: Obj }) {
  const b = React.useMemo(() => d.browse ?? {}, [d])
  const sync = () => {
    if (b.cmd) d.browse = b
    else delete d.browse
  }
  return (
    <Group legend="turn to browse">
      <Area obj={b} k="cmd" label="list command" placeholder={"one item per line: name<TAB>value<TAB>note\nps -Acr -o pcpu=,comm= | head -8 | …"} after={sync} />
      <Note>runs once when you start turning (never polled), then each click steps through its lines; a number in the value column drives the gauge. keep it cheap: ps, df, vm_stat.</Note>
    </Group>
  )
}

function DialPanel({ index }: { index: number }) {
  const pg = page()
  const d = (pg.dials[index] ??= {})
  const theme = state.profile!.theme
  const mode = d.mode || "value"
  const swap = (j: number) => {
    save()
    const a = pg.dials
    ;[a[index], a[j]] = [a[j], a[index]]
    select({ kind: "dial", index: j })
  }
  return (
    <>
      <Head title={`dial ${index + 1}`} sub={`${pg.name} · knob + its 200×100 strip segment`} />
      {pg.source && <Note>⚡ this page is generated live; settings here apply only where it leaves the dial free.</Note>}
      <Group legend="behavior">
        <Choice obj={d} k="mode" label="mode" dflt="value" onChange={() => select(state.sel)}
          options={[{ value: "value", label: "value" }, { value: "volume", label: "volume" }, { value: "brightness", label: "deck" }, { value: "actions", label: "actions" }]} />
        {mode === "value" && <DialTurning d={d} />}
        {mode === "value" && (
          <>
            <div data-ds-pair>
              <Num obj={d} k="min" label="min" check={(v) => v >= Number(d.max ?? 100) && "min must be below max"} />
              <Num obj={d} k="max" label="max" check={(v) => v <= Number(d.min ?? 0) && "max must be above min"} />
            </div>
            {!dialReadonly(d) && ( // a read-only readout never steps: min/max only scale its gauge
              <>
                <div data-ds-pair>
                  <Num obj={d} k="step" label="step" min={0} step={0.5} check={(v) => v <= 0 && "step must be > 0"} />
                  <Num obj={d} k="default" label="press resets to" />
                </div>
                <Toggle obj={d} k="wrap" label="wrap around" />
              </>
            )}
          </>
        )}
        {(mode === "volume" || mode === "brightness") && <Num obj={d} k="step" label="step" min={1} max={25} />}
      </Group>
      <Group legend="strip segment">
        <div data-ds-pair>
          <Text obj={d} k="label" label="label" />
          <Text obj={d} k="icon" label="icon" placeholder="emoji" />
        </div>
        {theme.style === "spec" && <GlyphPicker obj={d} k="glyph" label="glyph (carbon icon)" />}
        <Choice obj={d} k="style" label="style" dflt="bar" options={[{ value: "bar", label: "bar" }, { value: "gauge", label: "gauge" }, { value: "text", label: "text" }]} />
        <div data-ds-pair>
          <Text obj={d} k="unit" label="unit" placeholder="%" />
          <Num obj={d} k="decimals" label="decimals" min={0} max={6} />
        </div>
        <Text obj={d} k="display" label="display override" placeholder="text · {out} poll output" />
        <Color obj={d} k="bg" label="background" gradient inherit={theme.stripBg} />
        <Color obj={d} k="fg" label="text" inherit={theme.fg} />
        <Color obj={d} k="accent" label="accent" inherit={theme.accent} />
        <ImageField obj={d} k="image" label="image" w={200} h={100} fit={() => "cover"} />
        {pg.strip?.mode === "full" && <Note>⚠ this page's strip is a full-width canvas, so segments are hidden.</Note>}
      </Group>
      <PluginGroup obj={d} fields={[{ k: "label", label: "label" }, { k: "display", label: "display" }]} />
      {mode === "value" && (
        <Group legend="on change">
          <ActionEditor owner={d} k="onChange" label="on change (debounced)" />
          <Note>gets {"{value}"} / $DECK_VALUE.</Note>
        </Group>
      )}
      {mode === "actions" && (
        <Group legend="turn">
          <ActionEditor owner={d} k="onLeft" label="↺ turn left" />
          <ActionEditor owner={d} k="onRight" label="↻ turn right" />
        </Group>
      )}
      <Group legend="press & touch">
        <ActionEditor owner={d} k="onPress" label="dial press" />
        <ActionEditor owner={d} k="onTouch" label="strip tap" />
        <ActionEditor owner={d} k="onLongTouch" label="strip long tap" />
      </Group>
      <Poll obj={d} legend="live value" />
      {mode === "value" && dialReadonly(d) && <Browse d={d} />}
      <div data-ds-row>
        <Button onClick={() => { state.clip.dial = clone(d); toast("dial copied — select any dial and paste"); touch() }}><Icon name="copy" /> copy</Button>
        <Button disabled={!state.clip.dial} onClick={() => { save(); pg.dials[index] = clone(state.clip.dial!); select(state.sel) }}><Icon name="paste" /> paste</Button>
        {index > 0 && <Button onClick={() => swap(index - 1)}><Icon name="prev" /> move</Button>}
        {index < 3 && <Button onClick={() => swap(index + 1)}>move <Icon name="next" /></Button>}
        <Button onClick={() => { save(); pg.dials[index] = {}; select(state.sel) }}><Icon name="erase" /> clear</Button>
      </div>
    </>
  )
}

function StripPanel() {
  const pg = page()
  const st = (pg.strip ??= {})
  const theme = state.profile!.theme
  const full = st.mode === "full"
  return (
    <>
      <Head title="touch strip" sub={`${pg.name} · 800×100 touch lcd`} />
      <Group legend="layout">
        <Choice obj={st} k="mode" label="mode" dflt="segments" onChange={() => select(state.sel)}
          options={[{ value: "segments", label: "4 segments" }, { value: "full", label: "full width" }]} />
      </Group>
      {full && (
        <Group legend="canvas">
          <Text obj={st} k="text" label="text" placeholder="{page} = page name" />
          <Num obj={st} k="fontSize" label="font size" min={10} max={90} />
          <Color obj={st} k="bg" label="background" gradient inherit={theme.stripBg} />
          <Color obj={st} k="fg" label="text color" inherit={theme.fg} />
          <ImageField obj={st} k="image" label="image" w={800} h={100} fit={() => st.imageFit || "cover"} />
          <Choice obj={st} k="imageFit" label="image fit" dflt="cover" options={[{ value: "cover", label: "fill" }, { value: "contain", label: "fit" }]} />
        </Group>
      )}
      {full && (
        <Group legend="tap">
          <ActionEditor owner={st} k="onTap" label="tap" />
          <ActionEditor owner={st} k="onLongTap" label="long tap" />
          <Note>$DECK_X / $DECK_Y give the touch position.</Note>
        </Group>
      )}
      <Group legend="swipe">
        <ActionEditor owner={st} k="onSwipeLeft" label="← swipe left" />
        <ActionEditor owner={st} k="onSwipeRight" label="→ swipe right" />
        <Note>leave as "nothing" to swipe between pages.</Note>
      </Group>
    </>
  )
}

function ThemePanel() {
  const t = state.profile!.theme
  return (
    <>
      <Head title="theme" sub="how the deck itself is drawn, and the defaults every control inherits" />
      <Group legend="device look">
        <Choice obj={t} k="style" label="style" dflt="classic" onChange={() => select(state.sel)}
          options={[{ value: "spec", label: "spec-01 hardware" }, { value: "classic", label: "classic dark" }]} />
        <Note>
          {t.style === "spec"
            ? "keycaps on a dotted panel, carbon glyphs, plex mono legends, and the touch strip as a gray reflective lcd."
            : "dark lcd tiles with emoji and helvetica; the strip as a dark screen."}
        </Note>
      </Group>
      <Group legend="colors">
        <Color obj={t} k="keyBg" label="key background" gradient />
        <Color obj={t} k="stripBg" label="strip background" gradient />
        <Color obj={t} k="fg" label="text" />
        <Color obj={t} k="accent" label={t.style === "spec" ? "accent (lamps, key-color caps)" : "accent"} />
      </Group>
      <Group legend="behavior">
        <Switch2 label="follow the frontmost app" checked={state.profile!.appSwitching !== false}
          onChange={() => { save(); state.profile!.appSwitching = state.profile!.appSwitching === false; touch() }} />
        <AgentSetting k="toast" label="flash agents that need me on the strip" dflt />
        <AgentSetting k="autoSwitch" label="jump to the agents page when one needs me" />
      </Group>
      <Group legend="type">
        <Text obj={t} k="font" label="font family" placeholder="Helvetica Neue" />
        <Toggle obj={t} k="hideDividers" label="segment dividers" invert />
      </Group>
    </>
  )
}

function AgentSetting({ k, label, dflt }: { k: string; label: string; dflt?: boolean }) {
  const p = state.profile!
  const cur = Boolean(p.agents?.[k] ?? dflt)
  return <Switch2 label={label} checked={cur} onChange={() => { save(); p.agents = { ...(p.agents || {}), [k]: !cur }; touch() }} />
}

function PagePanel() {
  const pg = page()
  const p = state.profile!
  const [naming, setNaming] = React.useState<null | "new" | "copy">(null)
  const [name, setName] = React.useState("")
  const [confirmDel, setConfirmDel] = React.useState(false)
  return (
    <>
      <Head title="page" sub={`id: ${state.page}`} />
      <Group legend="page">
        <Text obj={pg} k="name" label="name" />
        <Toggle obj={pg} k="hidden" label="skip when swiping" />
        <Switch2 label="start page" checked={p.startPage === state.page} disabled={p.startPage === state.page}
          onChange={() => { save(); p.startPage = state.page; touch() }} />
      </Group>
      <Group legend="live content">
        <Choice obj={pg} k="source" label="generate keys from" dflt="" onChange={() => select(state.sel)}
          options={[{ value: "", label: "nothing" }, { value: "rex", label: "agents" }, { value: "bots", label: "bots · bring your own" }, ...(pg.source === "grokbots" ? [{ value: "grokbots", label: "grok bots (older setup)" }] : []), { value: "audio", label: "audio & camera" }]} />
        <Note>
          {pg.source === "rex"
            ? "every agent from every provider (rex, claude code / codex hooks, any app), most urgent first: red lamp = needs you, green = finished, amber = working. press jumps to it (rex) or opens its app, hold to mark seen. dial 1 picks, the strip counts filter."
            : pg.source === "bots" || pg.source === "grokbots"
              ? "your bots from every provider (grok bot, any bot app), the ones calling you first, with their own avatars. press opens that bot; hold opens its app."
            : pg.source === "audio"
              ? "microphones and outputs on this mac (press to switch), mic mute, and a camera-in-use lamp. dials 2–3 cycle mic and output."
              : "an ordinary page: every control is what you configure."}
        </Note>
      </Group>
      {pg.source === "rex" && (
        <Group legend="agents · providers">
          <AgentProviders />
        </Group>
      )}
      {(pg.source === "bots" || pg.source === "grokbots") && (
        <>
          <Group legend="bots · bring your own">
            <BotProviders />
          </Group>
          <Group legend="which bots, where">
            <PageBots pg={pg} />
          </Group>
        </>
      )}
      <Group legend="show automatically">
        <Note>while one of these apps is in front, the deck switches to this page, and back when you leave it.</Note>
        <AppsForPage pg={pg} />
      </Group>
      <Group legend="arrange">
        <div data-ds-row>
          <Button onClick={() => movePage(-1)}><Icon name="prev" /> earlier</Button>
          <Button onClick={() => movePage(1)}>later <Icon name="next" /></Button>
          <Button onClick={() => { setNaming("copy"); setName(`${pg.name} copy`) }}><Icon name="copy" /> duplicate</Button>
          <Button onClick={() => { setNaming("new"); setName("new page") }}><Icon name="plus" /> new</Button>
        </div>
        {naming && (
          <form
            data-ds-inline
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim()) addPage(naming === "copy", name.trim())
              setNaming(null)
            }}
          >
            <input data-kit="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} aria-label="page name" />
            <Button tone="primary" type="submit">create</Button>
            <Button onClick={() => setNaming(null)}>cancel</Button>
          </form>
        )}
        {Object.keys(p.pages).length > 1 &&
          (confirmDel ? (
            <div data-ds-inline>
              <span>delete "{pg.name}"?</span>
              <Button tone="primary" onClick={() => { setConfirmDel(false); deletePage() }}><Icon name="trash" /> delete</Button>
              <Button onClick={() => setConfirmDel(false)}>keep</Button>
            </div>
          ) : (
            <Button onClick={() => setConfirmDel(true)}><Icon name="trash" /> delete page</Button>
          ))}
      </Group>
      <Group legend="tips">
        <Note>everything saves to ~/.deckstudio/profile.json · ⌘z undoes.</Note>
        <Note>scripts and agents push live state with deckctl, e.g. <code>deckctl key 3 --label "build ✅" --bg "#1d5f3a"</code></Note>
      </Group>
    </>
  )
}

// A one-off controlled switch row (the kit switch is uncontrolled)
function Switch2({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: () => void }) {
  return (
    <label data-kit="switch-row">
      <span data-kit="label">{label}</span>
      <button type="button" role="switch" aria-checked={checked} data-kit="switch" data-checked={checked || undefined} disabled={disabled} onClick={onChange}>
        <span data-kit="switch-thumb" />
      </button>
    </label>
  )
}

export function Inspector() {
  useStore()
  if (!state.profile || !page()) return null
  const s = state.sel
  return (
    <aside data-ds-inspector key={`${state.page}:${s.kind}:${"index" in s ? s.index : ""}:${state.formKey}`}>
      {s.kind === "key" ? <KeyPanel index={s.index} />
        : s.kind === "dial" ? <DialPanel index={s.index} />
        : s.kind === "strip" ? <StripPanel />
        : s.kind === "theme" ? <ThemePanel />
        : <PagePanel />}
    </aside>
  )
}
