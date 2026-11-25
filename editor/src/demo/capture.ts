// The demo's stand-in for src/capture.mjs: nothing is captured on the visitor's machine; the deck
// shows what each capture key would do (file name, clipboard, countdown, a red recording key).
type Eng = { toast(text: unknown, ms?: number): void; notify(msg: string, level?: string): void; scheduleRender(): void; dialValue(i: number, page?: string): unknown; page: string }

const st: { rec: { started: number; tick: ReturnType<typeof setInterval> } | null; last: string; timed: ReturnType<typeof setTimeout> | null } = { rec: null, last: "", timed: null }
const pad = (n: number) => String(n).padStart(2, "0")
const fmtDur = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${pad(s % 60)}` }
function stamp(d = new Date()) {
  const h = d.getHours()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${h % 12 || 12}.${pad(d.getMinutes())}.${pad(d.getSeconds())} ${h < 12 ? "AM" : "PM"}`
}

/** {recording} {rec_time} {last_capture}, as on the real deck */
export function demoCaptureVars() {
  return {
    recording: st.rec ? "on" : "",
    rec_time: st.rec ? fmtDur(Date.now() - st.rec.started) : "off",
    last_capture: st.last ? st.last.replace(/^(Screenshot|Screen Recording) \d{4}-\d\d-\d\d at /, (_m, k) => (k === "Screenshot" ? "" : "🎬 ")) : "—",
  }
}
/** the record key turns red with the elapsed time while "recording" */
export function demoCaptureDecorate(k: any) {
  const p = k?.onPress
  const rec = (p?.type === "capture" && p.mode === "record") || (p?.type === "plugin" && p.plugin === "capture" && p.action === "record")
  if (!st.rec || !rec) return k
  return { ...k, tone: "key", accent: "#e5484d", led: true, ledColor: "#e5484d", motion: "pulse", label: "Stop", title: `● ${fmtDur(Date.now() - st.rec.started)}` }
}

export function demoCapture(a: Record<string, any>, vars: Record<string, unknown>, e: Eng) {
  const mode = String(a.mode || "screen")
  const clip = a.to === "clipboard"
  const say = (t: string, ms = 2200) => { e.toast(t, ms); e.notify(`demo · ${t}`) }
  const shotName = () => (st.last = `Screenshot ${stamp()}.png`)
  switch (mode) {
    case "screen": case "selection": case "window": {
      // as src/capture.mjs: an explicit `delay` wins; `delayDial` (1-4) reads that dial on the key's page
      const explicit = a.delay != null && String(a.delay).trim() !== ""
      let delay = 0
      if (mode === "screen" && !explicit && a.delayDial != null) {
        const n = Number(a.delayDial)
        if (!Number.isInteger(n) || n < 1 || n > 4) return say("capture: delayDial must be 1-4")
        delay = Number(e.dialValue(n - 1, typeof vars.page === "string" ? vars.page : e.page))
      } else if (mode === "screen") delay = Number(String(a.delay ?? 0).replace(/\{value\}/g, String(vars.value ?? 0)))
      delay = Number.isFinite(delay) ? Math.max(0, Math.min(60, Math.round(delay))) : 0
      const what = mode === "screen" ? "the screen" : mode === "window" ? "a window you click" : "a region you drag"
      const done = () => {
        if (clip) say(`would copy ${what} to the clipboard`)
        else { say(`would save "${shotName()}"`); e.scheduleRender() }
      }
      if (st.timed && mode === "screen" && delay > 0) { clearTimeout(st.timed); st.timed = null; return say("timer cancelled", 1200) } // only a timed press cancels the countdown
      if (delay > 0) {
        let n = delay
        const step = () => { if (n > 0) { e.toast(`📸 in ${n}…`, 1100); n--; st.timed = setTimeout(step, 1000) } else { st.timed = null; done() } }
        return step()
      }
      return done()
    }
    case "record":
      if (st.rec) {
        clearInterval(st.rec.tick)
        st.last = `Screen Recording ${stamp(new Date(st.rec.started))}.mov`
        st.rec = null
        e.scheduleRender()
        return say(`would save "${st.last}"`)
      }
      st.rec = { started: Date.now(), tick: setInterval(() => e.scheduleRender(), 1000) }
      e.scheduleRender()
      return say("● recording (simulated) · press again to stop", 2000)
    case "toolbar": return say("would open the screenshot toolbar (⌘⇧5)")
    case "folder": return say("would open the screenshots folder (Desktop)")
    case "copy-last": case "reveal-last": case "open-last":
      if (!st.last) return say("no capture yet", 1200)
      return say(`would ${mode === "copy-last" ? "copy the path of" : mode === "reveal-last" ? "show in Finder" : "open"} "${st.last}"`)
    case "check": return say("would check the Screen Recording permission")
    default: return say(`capture: unknown mode ${mode}`)
  }
}
