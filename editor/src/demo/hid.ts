// Drive a real Stream Deck+ from the page over WebHID (Chrome / Edge). Frames come from the
// DemoEngine; the device's input goes back into the same handlers the simulated deck uses.
import { requestStreamDecks, type StreamDeckWeb } from "@elgato-stream-deck/webhid"
import type { DemoEngine } from "./engine"

// minimal WebHID typing (TS's DOM lib doesn't ship it)
type HidConnectionEvent = Event & { device: unknown }
type HidApi = { addEventListener(t: "disconnect", fn: (e: HidConnectionEvent) => void): void; removeEventListener(t: "disconnect", fn: (e: HidConnectionEvent) => void): void }
const hid = () => (navigator as unknown as { hid: HidApi }).hid

export const hidSupported = () => typeof navigator !== "undefined" && "hid" in navigator

let current: { dev: StreamDeckWeb; engine: DemoEngine; onDisconnect: (e: HidConnectionEvent) => void } | null = null
export const deckConnected = () => !!current

function detach(reason: string) {
  const c = current
  if (!c) return
  current = null
  hid().removeEventListener("disconnect", c.onDisconnect)
  c.engine.sink = null
  c.engine.releaseAll()
  c.engine.setStatus("demo", reason)
  c.dev.removeAllListeners()
  return c
}

export async function connectDeck(engine: DemoEngine) {
  if (!hidSupported()) throw new Error("this browser has no WebHID — use Chrome or Edge on desktop")
  if (current) return
  let list: StreamDeckWeb[]
  try {
    list = await requestStreamDecks()
  } catch (e) {
    throw new Error(`couldn't open the stream deck (${(e as Error).message}). on macOS, quit the Elgato Stream Deck app first — it holds the device.`)
  }
  if (!list.length) return // picker cancelled
  const dev = list.find((d) => d.MODEL === "plus")
  if (!dev) {
    await Promise.all(list.map((d) => d.close().catch(() => {})))
    throw new Error("that's not a Stream Deck + — the demo drives the + (8 keys, 4 dials, touch strip)")
  }
  for (const d of list) if (d !== dev) d.close().catch(() => {})
  const hidDev = (dev as unknown as { hid?: { device?: unknown } }).hid?.device
  const onDisconnect = (e: HidConnectionEvent) => {
    if (!hidDev || e.device === hidDev) detach("device unplugged — back to the simulated deck")
  }
  current = { dev, engine, onDisconnect }
  hid().addEventListener("disconnect", onDisconnect)
  const safe = <A extends unknown[]>(fn: (...a: A) => unknown) => (...a: A) => {
    try {
      const r = fn(...a)
      if (r instanceof Promise) r.catch(() => {})
    } catch {
      /* one bad event never takes the device down */
    }
  }
  dev.on("down", safe((c) => (c.type === "button" ? engine.keyDown(c.index) : engine.dialDown(c.index))))
  dev.on("up", safe((c) => (c.type === "button" ? engine.keyUp(c.index) : engine.dialUp(c.index))))
  dev.on("rotate", safe((c, amount) => engine.dialRotate(c.index, amount)))
  dev.on("lcdShortPress", safe((_c, p) => engine.stripTap(p.x, p.y, false)))
  dev.on("lcdLongPress", safe((_c, p) => engine.stripTap(p.x, p.y, true)))
  dev.on("lcdSwipe", safe((_c, a, b) => engine.stripSwipe(a, b)))
  dev.on("error", (e) => {
    engine.notify(`device: ${(e as Error)?.message || e}`, "error")
    const c = detach("device error — back to the simulated deck")
    c?.dev.close().catch(() => {})
  })
  try {
    await dev.setBrightness(engine.brightness)
    await dev.clearPanel()
  } catch (e) {
    detach("couldn't talk to the device")
    await dev.close().catch(() => {})
    throw new Error(`couldn't talk to the stream deck (${(e as Error).message}). on macOS, quit the Elgato Stream Deck app first.`)
  }
  engine.sink = {
    key: (i, rgba) => dev.fillKeyBuffer(i, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), { format: "rgba" }),
    strip: (rgba) => dev.fillLcdRegion(0, 0, 0, new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength), { format: "rgba", width: 800, height: 100 }),
    brightness: (v) => dev.setBrightness(v),
  }
  engine.setStatus("connected", `${dev.PRODUCT_NAME} · over WebHID`)
  engine.resync()
}

export async function disconnectDeck() {
  const c = detach("device released — simulated in your browser")
  if (!c) return
  await c.dev.resetToLogo().catch(() => {})
  await c.dev.close().catch(() => {})
}
