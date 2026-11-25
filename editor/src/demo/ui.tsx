// Demo-only UI: the top bar's "connect stream deck" control and the landing banner.
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { demoTransport, state, toast, useStore } from "../app/store"

const hasHid = () => typeof navigator !== "undefined" && "hid" in navigator
const MAC_NOTE = "on macOS, quit the Elgato Stream Deck app first — it holds the device and the browser can't open it."

/** Top bar: connect / disconnect a real Stream Deck+ over WebHID. */
export function DemoConnect() {
  useStore()
  const [busy, setBusy] = React.useState(false)
  const on = state.status.state === "connected"
  if (!hasHid())
    return (
      <span data-ds-demo-note title="WebHID is available in Chrome and Edge on desktop">
        real device: needs chrome / edge
      </span>
    )
  return (
    <div data-ds-row>
      <Button
        tone={on ? undefined : "primary"}
        disabled={busy}
        title={on ? "hand the device back (shows the Elgato logo)" : `drive a Stream Deck + from this page. ${MAC_NOTE}`}
        onClick={async () => {
          setBusy(true)
          try {
            if (!(import.meta.env.VITE_DEMO === "1" || import.meta.env.DEV)) return
            const [{ connectDeck, disconnectDeck }, t] = await Promise.all([import("./hid"), demoTransport()])
            if (on) await disconnectDeck()
            else await connectDeck(t.engine)
          } catch (e) {
            toast((e as Error).message, "error")
          } finally {
            setBusy(false)
          }
        }}
      >
        <Icon name="power" /> {on ? "disconnect deck" : "connect stream deck"}
      </Button>
    </div>
  )
}

/** Landing banner: what this is, how to use a real deck, and a way back to the starter profile. */
export function DemoBanner() {
  const [open, setOpen] = React.useState(true)
  if (!open) return null
  return (
    <div data-kit="alert" data-tone="info" data-ds-banner data-ds-demo-banner>
      <span data-ds-led data-state="on" />
      <div>
        <p>
          <strong>DeckStudio demo</strong> — runs entirely in your browser. Plug in a Stream Deck+ and press connect (Chrome/Edge). For the full
          app (agents, apps, audio on your Mac) install DeckStudio locally.
        </p>
        <p data-ds-note>
          switch to <b>live</b> to press keys, turn knobs and swipe the strip. actions that would touch a computer only show what they would run.{" "}
          {hasHid() ? MAC_NOTE : ""} agents, bots and audio devices here are made up.
        </p>
      </div>
      <div data-ds-row>
        <Button
          onClick={async () => {
            if (!confirm("reset the demo to the starter profile? your edits here will be lost.")) return
            ;(await demoTransport()).reset()
            toast("demo reset")
          }}
        >
          reset demo
        </Button>
        <Button round aria-label="hide" onClick={() => setOpen(false)}>
          <Icon name="close" />
        </Button>
      </div>
    </div>
  )
}
