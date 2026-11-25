// Boots the server's renderer in the browser: Buffer global, asset root, Plex Mono via FontFace,
// then src/render.mjs (which dispatches to src/render-spec.mjs). Assets are fetched on demand
// into the in-memory fs (shims/fs.ts) right before a page renders.
import { Buffer } from "buffer"
import catalog from "virtual:deck-catalog"
import { hasFile, putFile } from "./shims/fs"
import w200 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-200-normal.woff2?url"
import w300 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-300-normal.woff2?url"
import w400 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url"
import w500 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-500-normal.woff2?url"
import w600 from "@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2?url"

/* eslint-disable @typescript-eslint/no-explicit-any */
export const ASSET_ROOT = "/deck"
export const CUSTOM_GLYPHS = new Set(catalog.custom)
export const CARBON_GLYPHS = new Set(catalog.carbon)
export const ALL_GLYPHS = [...catalog.custom, ...catalog.carbon.filter((n) => !CUSTOM_GLYPHS.has(n))]
export const LOGO_FILES = catalog.logos
const LOGOS = new Map(catalog.logos.map((f) => [f.replace(/\.(png|svg)$/, ""), f]))
const SPRITES = new Set(catalog.sprites)

// Logos saved from the icon studio in the browser demo: kept in localStorage, fed to the renderer from memory.
const USER_LOGOS_KEY = "deckDemoLogos"
export const userLogos = new Map<string, string>() // name -> data URL
function dataUrlBytes(u: string) {
  const bin = atob(u.slice(u.indexOf(",") + 1))
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}
export function addUserLogo(name: string, dataUrl: string, persist = true) {
  userLogos.set(name, dataUrl)
  LOGOS.set(name, `${name}.png`)
  putFile(`/deck/assets/logos/${name}.png`, dataUrlBytes(dataUrl))
  if (persist) try { localStorage.setItem(USER_LOGOS_KEY, JSON.stringify(Object.fromEntries(userLogos))) } catch { /* storage full or blocked */ }
}
try {
  for (const [n, u] of Object.entries(JSON.parse(localStorage.getItem(USER_LOGOS_KEY) || "{}") as Record<string, string>)) addUserLogo(n, u, false)
} catch { /* ignore */ }

async function loadFonts() {
  const faces = Object.entries({ 200: w200, 300: w300, 400: w400, 500: w500, 600: w600 }).map(
    ([weight, url]) => new FontFace("Plex Mono", `url(${url}) format("woff2")`, { weight }),
  )
  await Promise.all(
    faces.map(async (f) => {
      try {
        document.fonts.add(await f.load())
      } catch {
        /* falls back to the system mono */
      }
    }),
  )
}

export type Renderer = typeof import("@deck/render.mjs")
let renderer: Promise<Renderer> | null = null
export function loadRenderer(): Promise<Renderer> {
  return (renderer ??= (async () => {
    const g = globalThis as any
    g.Buffer ??= Buffer
    g.__DECK_ASSET_ROOT__ = ASSET_ROOT // must be set before render-spec is evaluated
    await loadFonts()
    return await import("@deck/render.mjs")
  })())
}

// ---- assets: fetch exactly what a page draws, once ----
const inflight = new Map<string, Promise<void>>()
function fetchInto(fsPath: string, url: string) {
  if (hasFile(fsPath)) return Promise.resolve()
  let p = inflight.get(fsPath)
  if (!p) {
    p = fetch(url)
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
      .then((b) => putFile(fsPath, new Uint8Array(b)))
      .catch(() => {
        // renders without it; a later render may try again (not in a tight loop)
        setTimeout(() => inflight.delete(fsPath), 5000)
      })
    inflight.set(fsPath, p)
  }
  return p
}
export function preloadGlyph(name: unknown) {
  if (typeof name !== "string" || !/^[A-Za-z0-9-]{1,80}$/.test(name)) return // exact names: Carbon has 4K, AI…
  if (CUSTOM_GLYPHS.has(name)) return fetchInto(`${ASSET_ROOT}/assets/glyphs/${name}.svg`, `/deck/assets/glyphs/${name}.svg`)
  if (CARBON_GLYPHS.has(name)) return fetchInto(`/vendor/@carbon/icons/svg/32/${name}.svg`, `/vendor/@carbon/icons/svg/32/${name}.svg`)
}
export function preloadLogo(name: unknown) {
  const f = typeof name === "string" ? LOGOS.get(name) : undefined
  if (f) return fetchInto(`${ASSET_ROOT}/assets/logos/${f}`, `/deck/assets/logos/${f}`)
}
export function preloadSprite(name: unknown) {
  if (typeof name === "string" && SPRITES.has(name)) return fetchInto(`${ASSET_ROOT}/assets/${name}.png`, `/deck/assets/${name}.png`)
}
/** Everything the resolved page view (keys + dials) will draw. */
export async function preloadView(view: { keys: any[]; dials: any[] }) {
  const jobs: (Promise<void> | undefined)[] = []
  for (const k of view.keys) {
    if (!k) continue
    jobs.push(preloadGlyph(k.glyph), preloadGlyph(k.topic), preloadLogo(k.logo), preloadSprite(k.sprite))
  }
  for (const d of view.dials) if (d) jobs.push(preloadGlyph(d.glyph))
  await Promise.all(jobs)
}
