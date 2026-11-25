// Browser stand-in for node:fs, just enough for src/render-spec.mjs: an in-memory file map that
// the demo fills (assets.ts) with every glyph / logo / sprite a page needs before it renders.
import { Buffer } from "buffer"

const files = new Map<string, Uint8Array>()

export function putFile(p: string, bytes: Uint8Array) {
  files.set(p, bytes)
}
export function hasFile(p: string) {
  return files.has(p)
}
export function existsSync(p: string) {
  return files.has(String(p))
}
export function readFileSync(p: string, enc?: string | { encoding?: string }) {
  const b = files.get(String(p))
  if (!b) throw Object.assign(new Error(`ENOENT: no such file, open '${p}'`), { code: "ENOENT" })
  const encoding = typeof enc === "string" ? enc : enc?.encoding
  return encoding ? new TextDecoder().decode(b) : Buffer.from(b)
}
export function statSync(p: string) {
  if (!files.has(String(p))) throw Object.assign(new Error(`ENOENT: no such file, stat '${p}'`), { code: "ENOENT" })
  return { mtimeMs: 0 } // the demo's files never change once loaded
}
export default { existsSync, readFileSync, statSync }
