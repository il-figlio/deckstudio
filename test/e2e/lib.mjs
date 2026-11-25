// Shared by the browser audits: pick a browser and parse "<url> <screenshot-dir>" args.
import fs from 'node:fs'
import { chromium } from 'playwright'

/** Playwright's bundled Chromium; falls back to installed Google Chrome. PW_CHANNEL=chrome forces Chrome. */
export async function launch(opts = {}) {
  if (process.env.PW_CHANNEL) return chromium.launch({ channel: process.env.PW_CHANNEL, ...opts })
  try { return await chromium.launch(opts) } catch (e) {
    try { return await chromium.launch({ channel: 'chrome', ...opts }) } catch { throw e }
  }
}
/** argv: <url> [screenshot-dir] [headed] */
export function args() {
  const [, , url, sp] = process.argv
  if (!url) { console.error('usage: node <audit>.mjs <demo-url> [screenshot-dir]'); process.exit(2) }
  const dir = sp || process.env.E2E_SHOTS || ''
  if (dir) fs.mkdirSync(dir, { recursive: true })
  return { url, sp: dir }
}
export const shotPath = (sp, name) => (sp ? `${sp}/${name}` : undefined)
