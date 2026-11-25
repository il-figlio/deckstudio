import * as React from "react"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { Lcd } from "@/components/ui/lcd"
import { Segmented } from "@/components/ui/segmented-control"
import { Slider } from "@/components/ui/slider"
import { IconStudio } from "./IconStudio"
import { Recipes } from "./Recipes"
import { Plugins } from "./Plugins"
import { adoptProfile, api, flushSave, select, state, toast, touch, undo, useStore, type Profile } from "./store"
import { DEMO } from "./store"
import { DemoConnect } from "../demo/ui"

function Brightness() {
  const timer = React.useRef(0)
  return (
    <div data-ds-bright>
      <Slider
        label="brightness"
        value={state.brightness}
        min={0}
        max={100}
        step={1}
        onValueChange={(v) => {
          state.brightness = v
          if (state.profile) state.profile.brightness = v
          touch()
          clearTimeout(timer.current)
          timer.current = window.setTimeout(() => api("POST", "/api/brightness", { value: v }), 60)
        }}
      />
    </div>
  )
}

function ImportExport() {
  const input = React.useRef<HTMLInputElement>(null)
  const [pending, setPending] = React.useState<{ name: string; profile: Profile; cmds: string[] } | null>(null)
  return (
    <>
      <Button
        onClick={() => {
          const a = document.createElement("a")
          a.href = URL.createObjectURL(new Blob([JSON.stringify(state.profile, null, 2)], { type: "application/json" }))
          a.download = "deckstudio-profile.json"
          a.click()
        }}
      >
        <Icon name="download" /> export
      </Button>
      <Button onClick={() => input.current?.click()}>
        <Icon name="upload" /> import
      </Button>
      <input
        ref={input}
        type="file"
        accept="application/json"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0]
          e.target.value = ""
          if (!f) return
          try {
            const profile = JSON.parse(await f.text())
            const cmds: string[] = []
            JSON.stringify(profile, (k, v) => {
              if (["cmd", "script", "url", "target"].includes(k) && typeof v === "string") cmds.push(`${k}: ${v}`)
              return v
            })
            setPending({ name: f.name, profile, cmds: [...new Set(cmds)] })
          } catch (err) {
            toast(`import failed: ${(err as Error).message}`, "error")
          }
        }}
      />
      {pending && (
        <div data-ds-modal role="dialog" aria-modal aria-labelledby="imp-title">
          <div data-kit="module" data-ds-modal-card>
            <h2 id="imp-title">import "{pending.name}"?</h2>
            <p>this replaces your current profile. export first if you want a backup (⌘z also undoes it).</p>
            {pending.cmds.length > 0 && (
              <>
                <p data-ds-warn>this profile can run these on your mac — some immediately, as live-data polls:</p>
                <pre data-ds-cmds>{pending.cmds.slice(0, 40).join("\n")}{pending.cmds.length > 40 ? "\n…" : ""}</pre>
              </>
            )}
            <div data-ds-row>
              <Button
                tone="primary"
                onClick={async () => {
                  const p = pending.profile
                  setPending(null)
                  await flushSave()
                  await api("PUT", "/api/profile", p)
                  const st = await api("GET", "/api/state")
                  state.sel = { kind: "page" }
                  state.page = st.page
                  adoptProfile(st.profile, true) // one undo step brings the old profile back
                  touch()
                }}
              >
                replace profile
              </Button>
              <Button onClick={() => setPending(null)}>cancel</Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

export function TopBar() {
  useStore()
  const [studio, setStudio] = React.useState(false)
  const [recipes, setRecipes] = React.useState(false)
  const [plugins, setPlugins] = React.useState(false)
  const st = state.status.state
  const led = st === "connected" ? "on" : st === "busy" || st === "released" ? "warn" : "off"
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "z") return
      if ((e.target as HTMLElement).closest("input, textarea")) return // native text undo inside fields
      e.preventDefault()
      undo(e.shiftKey)
    }
    addEventListener("keydown", onKey)
    return () => removeEventListener("keydown", onKey)
  }, [])
  return (
    <header data-ds-topbar>
      <div data-ds-brand>
        <strong>deckstudio</strong>
        <span>stream deck + editor</span>
      </div>
      <Lcd tag={<span data-ds-led data-state={led} />} size="sm" data-ds-status title={state.status.detail}>
        <span>{st}</span>
        {state.status.detail && <small>{state.status.detail}</small>}
        {state.front.name && <small data-ds-front>front app · {state.front.name}</small>}
      </Lcd>
      {DEMO && <DemoConnect />}
      {!DEMO && <div data-ds-row>
        <Button
          tone="primary"
          disabled={st === "connected"}
          onClick={async () => {
            state.status = { state: "busy", detail: "quitting the elgato app and connecting…" }
            touch()
            await api("POST", "/api/takeover")
          }}
        >
          <Icon name="power" /> take over
        </Button>
        <Button disabled={st === "released"} onClick={() => api("POST", "/api/release", { launchElgato: true })}>
          release
        </Button>
      </div>}
      <span data-ds-spacer />
      <span data-ds-save data-state={state.save.state} onClick={() => state.save.state === "bad" && flushSave()}>
        {state.save.msg}
      </span>
      <div data-ds-row>
        <Button round aria-label="undo" disabled={!state.canUndo} onClick={() => undo(false)}>
          <Icon name="undo" />
        </Button>
        <Button round aria-label="redo" disabled={!state.canRedo} onClick={() => undo(true)}>
          <Icon name="redo" />
        </Button>
      </div>
      <Segmented
        label="mode"
        hideLabel
        value={state.mode}
        options={[{ value: "edit", label: "edit" }, { value: "live", label: "live" }]}
        onValueChange={(m) => {
          state.mode = m as "edit" | "live"
          touch()
        }}
      />
      <Brightness />
      <div data-ds-row>
        <Button onClick={() => select({ kind: "theme" })}>
          <Icon name="palette" /> theme
        </Button>
        <Button onClick={() => setStudio(true)}>
          <Icon name="image" /> icons
        </Button>
        {studio && <IconStudio onClose={() => setStudio(false)} />}
        <Button onClick={() => setRecipes(true)}>
          <Icon name="document" /> recipes
        </Button>
        {recipes && <Recipes onClose={() => setRecipes(false)} />}
        <Button onClick={() => setPlugins(true)}>
          <Icon name="dashboard" /> plugins
        </Button>
        {plugins && <Plugins onClose={() => setPlugins(false)} />}
        <ImportExport />
      </div>
    </header>
  )
}

export function Banner() {
  useStore()
  const st = state.status.state
  if (st !== "busy" && st !== "released") return null
  return (
    <div data-kit="alert" data-tone="warning" data-ds-banner>
      <span data-ds-led data-state="warn" />
      <p>
        {st === "busy"
          ? "the elgato stream deck app owns the device. you can still edit and simulate here."
          : "device handed back to the elgato app. edits still save."}
      </p>
      <Button tone="primary" onClick={() => api("POST", "/api/takeover")}>
        take over device
      </Button>
    </div>
  )
}
