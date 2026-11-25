// Browser stand-in for @napi-rs/canvas, enough for src/render.mjs + src/render-spec.mjs.
import { Buffer } from "buffer"

export type DeckCanvas = HTMLCanvasElement & { toBuffer(mime?: string): Buffer }

export function createCanvas(w: number, h: number): DeckCanvas {
  const c = document.createElement("canvas") as DeckCanvas
  c.width = w
  c.height = h
  c.toBuffer = (mime = "image/png") => {
    const url = c.toDataURL(mime)
    return Buffer.from(url.slice(url.indexOf(",") + 1), "base64")
  }
  return c
}

function sniff(b: Uint8Array) {
  if (b[0] === 0x89 && b[1] === 0x50) return "image/png"
  if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg"
  if (b[0] === 0x47 && b[1] === 0x49) return "image/gif"
  if (b[0] === 0x52 && b[1] === 0x49) return "image/webp"
  return "image/svg+xml" // text: render-spec only hands us SVG markup otherwise
}

/** Decoded <img>. SVG goes through Image + an object URL (createImageBitmap can't take SVG blobs). */
export async function loadImage(src: string | Uint8Array | ArrayBuffer): Promise<HTMLImageElement> {
  const img = new Image()
  let url: string
  let revoke = false
  if (typeof src === "string") url = src
  else {
    const bytes = src instanceof Uint8Array ? src : new Uint8Array(src)
    url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: sniff(bytes) }))
    revoke = true
  }
  img.src = url
  try {
    await img.decode()
  } finally {
    if (revoke) URL.revokeObjectURL(url)
  }
  return img
}

// Fonts are registered once with the FontFace API (see demo/fonts.ts), not from file paths.
export const GlobalFonts = { registerFromPath: () => null, families: [] as unknown[] }

const ImageDataCtor = globalThis.ImageData
export { ImageDataCtor as ImageData }
export default { createCanvas, loadImage, GlobalFonts, ImageData: ImageDataCtor }
