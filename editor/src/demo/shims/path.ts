// Browser stand-in for node:path (posix): join / dirname / basename / extname / resolve.
export const sep = "/"
export function normalize(p: string) {
  const abs = p.startsWith("/")
  const out: string[] = []
  for (const part of p.split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop()
      else if (!abs) out.push("..")
    } else out.push(part)
  }
  const s = out.join("/")
  return abs ? "/" + s : s || "."
}
export const join = (...parts: string[]) => normalize(parts.filter((x) => x !== "").join("/"))
export const resolve = (...parts: string[]) => {
  let p = ""
  for (const part of parts) p = part.startsWith("/") ? part : p + "/" + part
  return normalize(p.startsWith("/") ? p : "/" + p)
}
export function dirname(p: string) {
  const n = normalize(p)
  const i = n.lastIndexOf("/")
  return i < 0 ? "." : i === 0 ? "/" : n.slice(0, i)
}
export const basename = (p: string, ext?: string) => {
  const b = normalize(p).split("/").pop() || ""
  return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b
}
export const extname = (p: string) => {
  const b = basename(p)
  const i = b.lastIndexOf(".")
  return i > 0 ? b.slice(i) : ""
}
export default { sep, normalize, join, resolve, dirname, basename, extname }
