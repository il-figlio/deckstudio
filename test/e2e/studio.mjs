// Open Icon Studio, screenshot each source tab, check thumbnails really render.
import { launch, args, shotPath } from './lib.mjs'
const { url: URL, sp: SP } = args(); const TAG = 'demo'
const sleep = ms => new Promise(r => setTimeout(r, ms))
const b = await launch({ headless: true })
const page = await b.newPage({ viewport: { width: 1500, height: 1000 } })
const errs = []; page.on('pageerror', e => errs.push(e.message)); page.on('console', m => m.type() === 'error' && errs.push('console: ' + m.text()))
const bad = []; page.on('response', r => { if (r.status() >= 400) bad.push(r.status() + ' ' + r.url()) })
await page.goto(URL); await page.waitForSelector('[data-ds-key]', { timeout: 15000 }); await sleep(1000)
await page.locator('button:has-text("icons")').first().click(); await sleep(800)
let fail = 0
const check = async tab => {
  const sel = '[data-ds-studio-sources] img, [data-ds-studio-sources] canvas'
  // scroll the grid so lazy images load
  await page.evaluate(() => { const g = document.querySelector('[data-ds-studio-sources] [data-ds-glyph-grid]'); if (g) { g.scrollTop = 1e6; g.scrollTop = 0 } })
  await sleep(1500)
  const res = await page.$$eval(sel, els => els.map(el => {
    if (el.tagName === 'IMG') {
      const r = el.getBoundingClientRect(); const vis = r.bottom > 0 && r.top < innerHeight
      let ink = -1
      if (el.complete && el.naturalWidth) { try { const c = document.createElement('canvas'); c.width = c.height = 32; const x = c.getContext('2d'); x.drawImage(el, 0, 0, 32, 32); const d = x.getImageData(0, 0, 32, 32).data; ink = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) ink++ } catch { ink = -2 } }
      return { kind: 'img', src: el.getAttribute('src').slice(0, 60), nw: el.naturalWidth, complete: el.complete, ink, vis }
    }
    const x = el.getContext('2d'); const d = x.getImageData(0, 0, el.width, el.height).data; let ink = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 20) ink++
    return { kind: 'canvas', ink }
  }))
  const broken = res.filter(r => r.kind === 'img' ? (r.vis && (!r.nw || r.ink === 0)) : r.ink === 0)
  console.log(`${tab}: ${res.length} thumbs, ${res.filter(r => r.kind === 'img' && r.nw).length} decoded, ${broken.length} blank/broken`)
  broken.slice(0, 8).forEach(r => console.log('   blank:', JSON.stringify(r)))
  if (!res.length || broken.length) fail++
  await page.screenshot({ path: shotPath(SP, `studio-${TAG}-${tab}.png`) })
}
for (const tab of ['logos', 'glyphs', 'apps']) {
  await page.locator(`[data-ds-studio-sources] [data-kit="segment"][data-value="${tab}"]`).click(); await sleep(tab === 'apps' ? 3000 : 800)
  await check(tab)
}
// pick an app: preview must render
const appBtn = page.locator('[data-ds-studio-list] button').first()
if (await appBtn.count()) { await appBtn.click(); await sleep(2500); const ok = await page.locator('[data-ds-studio-big] img').count(); console.log('apps pick → preview', ok ? 'ok' : 'MISSING'); if (!ok) fail++; await page.screenshot({ path: shotPath(SP, `studio-${TAG}-apps-picked.png`) }) }
console.log('errors:', errs.slice(0, 5)); console.log('4xx/5xx:', bad.slice(0, 10))
console.log(fail ? 'FAIL' : 'PASS')
await b.close(); process.exit(fail ? 1 : 0)
