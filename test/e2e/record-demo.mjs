// Records the README demo: a ~25 s walkthrough of the public browser demo (demo/sample data only), plus a hero screenshot.
//   npm run build:demo:public && node test/e2e/record-demo.mjs [out-dir] [--stills]     (or: npm run record:demo)
//   --stills: only the hero and the device stills docs/media/page-{home,agents,bots,capture}.png, no GIF.
// Serves web/site with the hosting headers (static.mjs) on a free port, drives it with Playwright's recordVideo at
// 1280x800, trims the setup, and converts to docs/media/demo.gif (2-pass palette, <8 MB) with ffmpeg. Also docs/media/hero.png and the page stills.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { launch } from './lib.mjs'
import { serve } from './static.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const out = path.resolve(process.argv.slice(2).find(a => !a.startsWith('--')) || path.join(root, 'docs/media'))
const work = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ds-rec-'))
fs.mkdirSync(out, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))
const BEAT = 800
const ZOOM = 'html{zoom:.68}' // fits the whole device + inspector header into a 1280x800 frame
const NOCURSOR = '*{cursor:none!important}'

const STILLS_ONLY = process.argv.includes('--stills')
const TOAST_CLEAR = 4800
const STILLS = [['home', 'home'], ['agents', 'agents'], ['grokbots', 'bots', 2], ['capture', 'capture']] // [page id, file name, key to press first (the Bots page's samples key)]
const ffq = (...a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a], { stdio: 'inherit' })
// downscale a 2x raw capture to `w` px wide, then pngquant it when available (else keep the plain PNG)
function png(raw, dest, w) {
  const tmp = path.join(work, 'scaled-' + path.basename(dest))
  ffq('-i', raw, '-vf', `scale=${w}:-1:flags=lanczos`, tmp)
  try { execFileSync('pngquant', ['--force', '--quality=80-95', '--output', dest, tmp]) } catch { fs.copyFileSync(tmp, dest) }
}
function writeStills() {
  png(path.join(work, 'hero-raw.png'), path.join(out, 'hero.png'), 1600)
  for (const [, name] of STILLS) png(path.join(work, `page-${name}-raw.png`), path.join(out, `page-${name}.png`), 1000)
  console.log('wrote', path.join(out, 'hero.png'), 'and', STILLS.map(([, n]) => `page-${n}.png`).join(', '))
}

const srv = await serve(path.join(root, 'web/site'), 0)
const URL0 = `http://127.0.0.1:${srv.address().port}/`
const b = await launch()
const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light', recordVideo: { dir: work, size: { width: 1280, height: 800 } } })
const page = await ctx.newPage()
const t0 = Date.now()
const errs = []; page.on('pageerror', e => errs.push(e.message))
const tab = id => page.locator(`[data-ds-tabs] [data-kit="segment"][data-value="${id}"]`).click()
const mode = m => page.locator(`[data-ds-topbar] [data-kit="segment"][data-value="${m}"]`).click()
const smooth = sel => page.evaluate(s => document.querySelector(s)?.scrollIntoView({ behavior: 'smooth', block: 'center' }), sel)
const top = () => page.evaluate(() => scrollTo({ top: 0, behavior: 'smooth' }))
const key = i => page.locator('[data-ds-key]').nth(i)

let start = 0
try {
  await page.goto(URL0)
  await page.evaluate(() => localStorage.clear()); await page.reload()
  await page.waitForSelector('[data-ds-key] img', { timeout: 15000 })
  await page.locator('[data-ds-demo-banner] button').last().click().catch(() => {})
  await page.addStyleTag({ content: ZOOM + NOCURSOR }); await sleep(1500)
  // hero still at 2x in its own context. Wait out the 4 s intro toast on the strip (src/demo/engine.ts) so it
  // doesn't cover the segments.
  const hc = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2, colorScheme: 'light' })
  const hp = await hc.newPage(); await hp.goto(URL0); await hp.waitForSelector('[data-ds-key] img')
  await hp.locator('[data-ds-demo-banner] button').last().click().catch(() => {})
  await hp.addStyleTag({ content: ZOOM + NOCURSOR }); await sleep(TOAST_CLEAR)
  await hp.screenshot({ path: path.join(work, 'hero-raw.png') })
  await hc.close()
  // device-only stills (page tabs + device + hint, like the README gallery) of a few live pages. A viewport tall and
  // wide enough that the stage never scrolls under the sticky top bar and the top bar stays on one row.
  const sc = await b.newContext({ viewport: { width: 1600, height: 1500 }, deviceScaleFactor: 2, colorScheme: 'light' })
  const sp = await sc.newPage(); await sp.goto(URL0); await sp.waitForSelector('[data-ds-key] img')
  await sp.locator('[data-ds-demo-banner] button').last().click().catch(() => {})
  await sp.addStyleTag({ content: NOCURSOR })
  await sp.locator('[data-ds-topbar] [data-kit="segment"][data-value="live"]').click(); await sleep(TOAST_CLEAR)
  for (const [id, name, press] of STILLS) {
    await sp.locator(`[data-ds-tabs] [data-kit="segment"][data-value="${id}"]`).click(); await sleep(1500)
    if (press != null) { await sp.locator('[data-ds-key]').nth(press).click(); await sleep(1500) }
    await sp.mouse.move(2, 2); await sleep(300) // no hover state (key numbers) in the shot
    await sp.locator('[data-ds-stage]').screenshot({ path: path.join(work, `page-${name}-raw.png`) })
  }
  await sc.close()
  if (STILLS_ONLY) { await ctx.close(); await b.close(); srv.close(); writeStills(); process.exit(0) }

  start = (Date.now() - t0) / 1000
  // 1. home
  await sleep(1000)
  // 2. dial: switch to live, turn volume
  await mode('live'); await sleep(500)
  const vol = (await page.locator('[data-ds-knob] [data-kit="knob-dial"]').nth(0).boundingBox())
  await page.mouse.move(vol.x + vol.width / 2, vol.y + vol.height / 2)
  for (let i = 0; i < 8; i++) { await page.mouse.wheel(0, -25); await sleep(90) }
  await sleep(300)
  for (let i = 0; i < 5; i++) { await page.mouse.wheel(0, 25); await sleep(90) }
  await sleep(BEAT)
  // 3. key: edit, select key 2, change label + logo
  await mode('edit'); await sleep(400)
  await key(1).click(); await sleep(500)
  const lab = page.locator('[data-ds-inspector] [data-kit="field"]:has([data-kit="label"]:text-is("label")) input')
  await page.evaluate(() => document.querySelector('[data-ds-inspector]').scrollIntoView({ behavior: 'smooth', block: 'start' })); await sleep(600)
  await lab.scrollIntoViewIfNeeded(); await lab.click(); await page.keyboard.press('Meta+a')
  await page.keyboard.type('review', { delay: 90 }); await sleep(500)
  await page.locator('[data-ds-inspector] [role="listbox"][aria-label="logos"] [role="option"]').nth(3).click().catch(async () => { await page.locator('[data-ds-inspector] [data-ds-glyph-grid] button').nth(3).click() })
  await sleep(600)
  await top(); await sleep(1100)
  // 4. agents
  await mode('live'); await sleep(300)
  await tab('agents'); await sleep(1500)
  // 5. bots (press the samples key)
  await tab('grokbots'); await sleep(900)
  await key(2).click(); await sleep(1400)
  // 6. capture
  await tab('capture'); await sleep(1500)
  // 7. icon studio on home key 4
  await tab('home'); await sleep(500)
  await mode('edit'); await sleep(300)
  await key(3).click(); await sleep(600)
  await page.locator('[data-ds-topbar] button:has-text("icons")').click(); await sleep(800)
  const stu = page.locator('[data-ds-studio]')
  await stu.locator('[role="listbox"][aria-label="logos"] [role="option"]').nth(2).click(); await sleep(900)
  await stu.getByRole('radio', { name: 'game boy' }).click(); await sleep(800)
  await stu.getByRole('radio', { name: /floyd|bayer|atkinson|dither/i }).first().click().catch(() => {}); await sleep(900)
  await stu.locator('input[data-kit="input"][placeholder="my-icon"]').fill('demo-art').catch(() => {}); await sleep(500)
  await stu.getByRole('button', { name: /save & put on key/i }).click(); await sleep(1500)
  // 8. plugins -> marketplace
  await page.locator('[data-ds-topbar] button:has-text("plugins")').click(); await sleep(1100)
  await page.locator('[data-ds-plugins] [data-kit="segment"][data-value="marketplace"]').click(); await sleep(1500)
  await page.keyboard.press('Escape'); await sleep(500)
  // 9. home
  await mode('live'); await sleep(1200)
} catch (e) { console.error('script failed:', e.message.split('\n')[0]); await page.screenshot({ path: path.join(work, 'error.png') }); process.exitCode = 1 }
const vpath = await page.video().path()
await ctx.close(); await b.close(); srv.close()
if (errs.length) console.log('page errors:', errs.slice(0, 3).join(' | '))
if (process.exitCode) { console.error('see', work); process.exit(1) }

// ---- convert ----
const ff = (...a) => execFileSync('ffmpeg', ['-y', '-v', 'error', ...a], { stdio: 'inherit' })
const gif = path.join(out, 'demo.gif'), pal = path.join(work, 'pal.png')
let fps = 15, width = 1200, colors = 256
for (;;) {
  const vf = `fps=${fps},scale=${width}:-1:flags=lanczos`
  ff('-ss', String(start), '-i', vpath, '-vf', `${vf},palettegen=stats_mode=diff:max_colors=${colors}`, pal)
  ff('-ss', String(start), '-i', vpath, '-i', pal, '-lavfi', `${vf}[x];[x][1:v]paletteuse=dither=sierra2_4a`, '-loop', '0', gif)
  const mb = fs.statSync(gif).size / 1048576
  console.log(`gif ${mb.toFixed(2)} MB @ ${fps}fps ${width}px ${colors} colors`)
  if (mb < 7.5) break
  if (width > 1100) width -= 50; else if (colors > 160) colors -= 32; else if (fps > 12) fps -= 1; else if (width > 800) width -= 100; else break
}
writeStills()
console.log('wrote', gif)
