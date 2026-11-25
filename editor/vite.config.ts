import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'

// Built into ../web/dist and served by DeckStudio's server (same origin as the API).
// `vite build --mode demo` (npm run build:demo) instead builds the browser-only demo into
// ../web/site: a static site with an in-browser engine (src/demo) and no server at all.
const ROOT = path.resolve(__dirname, '..')
const ASSETS = path.join(ROOT, 'assets')
const CARBON = path.join(path.dirname(createRequire(path.join(ROOT, 'package.json')).resolve('@carbon/icons/package.json')), 'svg/32')
const svgNames = (d: string) => { try { return fs.readdirSync(d).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort() } catch { return [] } }
// Only genuine app / provider logos ship with the demo, never user-made custom-* icon studio art.
// DECK_PUBLIC=1 (npm run build:demo:public): only assets committed to git ship. Local, gitignored art
// (your own app icons, Icon Studio saves) stays out of a site you publish.
const PUBLIC = process.env.DECK_PUBLIC === '1'
const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [e.name]))
const TRACKED = (() => {
  try { return new Set(execFileSync('git', ['ls-files', 'assets'], { cwd: ROOT }).toString().split('\n').filter(Boolean).map((f) => path.basename(f).replace(/\.(png|svg)$/, ''))) } catch {}
  // Vercel's Git builds check out the repo without .git. That checkout holds only committed files, so every asset
  // in it is tracked. Only trusted when Vercel says so (VERCEL=1, VERCEL_GIT_COMMIT_SHA set), never on a dev Mac.
  if (process.env.VERCEL === '1' && process.env.VERCEL_GIT_COMMIT_SHA) try { return new Set(walk(path.join(ROOT, 'assets')).filter((f) => !/^(custom-|app-ante-)/.test(f)).map((f) => f.replace(/\.(png|svg)$/, ''))) } catch {} // + the .gitignore personal patterns, in case of a CLI upload
  return null
})()
// A public build must know what's tracked: without git it would ship every local file, so it stops instead.
if (PUBLIC && !TRACKED?.size) throw new Error('DECK_PUBLIC=1: `git ls-files assets` failed or listed nothing, so the build can\'t tell shipped assets from local ones. Build from a git checkout.')
const local = (name: string) => PUBLIC && !TRACKED!.has(name.replace(/\.(png|svg)$/, ''))
const logoFiles = () => { try { return fs.readdirSync(path.join(ASSETS, 'logos')).filter((f) => /^(app|provider)-[a-z0-9-]+\.(png|svg)$/.test(f) && !local(f)).sort() } catch { return [] } }
const SHAPES = () => { try { return fs.readdirSync(path.join(ASSETS, 'grokbot')).map((f) => /^bot-([a-z]+)-face\.png$/.exec(f)?.[1]).filter(Boolean) as string[] } catch { return [] } }
const BOT_COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'violet', 'magenta', 'brown', 'gray', 'black', 'white']

// What the demo can draw, so the in-browser fs knows which files exist without probing the network.
function catalog() {
  const custom = svgNames(path.join(ASSETS, 'glyphs')).filter((n) => !local(n))
  const carbon = svgNames(CARBON)
  const sprites = fs.readdirSync(path.join(ASSETS, 'grokbot')).filter((f) => f.endsWith('.png')).map((f) => 'grokbot/' + f.slice(0, -4)).sort()
  return { custom, carbon, logos: logoFiles(), sprites }
}

// The demo's marketplace: a static copy of the plugin registry (DECKSTUDIO_REGISTRY when it's a folder, else the
// registry/ folder in this repo), taken at build time. Only entries whose manifest matches the index's sha256 and validates,
// never ones tagged private / internal / local. No registry: the demo shows an empty marketplace.
const REGISTRY = 'virtual:deck-registry'
async function registrySnapshot() {
  const env = process.env.DECKSTUDIO_REGISTRY || ''
  const dir = env && !/^https?:/i.test(env) ? path.resolve(env) : path.join(ROOT, 'registry')
  if (!fs.existsSync(path.join(dir, 'index.json'))) return { ok: false, source: null, plugins: [] }
  try {
    const I = await import(path.join(ROOT, 'src/plugin-install.mjs'))
    const src = { kind: 'dir', dir }
    const { entries } = await I.readIndex(src)
    const plugins = []
    for (const e of entries) {
      if (e.tags.some((t: string) => ['private', 'internal', 'local'].includes(t))) continue
      const v = await I.verifyEntry(src, e)
      if (!v.verified || !v.valid || !v.buf) continue
      const { buf, ...rest } = v
      plugins.push({ ...rest, manifest: buf.toString('utf8') })
    }
    return { ok: true, source: 'deckstudio/registry', plugins }
  } catch (err) {
    console.warn('demo registry snapshot skipped:', (err as Error).message)
    return { ok: false, source: null, plugins: [] }
  }
}

const shim = (f: string) => path.resolve(__dirname, 'src/demo/shims', f)
function deckDemo(mode: string): Plugin {
  let outDir = path.resolve(__dirname, '../web/site')
  const VIRTUAL = 'virtual:deck-catalog'
  const botAvatar = async (shape: string, color: string): Promise<Buffer | null> => {
    const m = await import(path.join(ROOT, 'src/render-spec.mjs'))
    return m.spriteThumb(`grokbot/bot-${shape}-face`, color)
  }
  // public, user-data-free files the demo fetches: assets/, Carbon glyphs, logos, bot avatars
  const resolveStatic = (url: string): string | null => {
    const p = decodeURIComponent(url.split('?')[0])
    let m
    if ((m = /^\/deck\/assets\/((glyphs|grokbot|logos)\/[a-z0-9-]+\.(svg|png))$/.exec(p))) {
      if (m[2] === 'logos' && !logoFiles().includes(path.basename(m[1]))) return null
      return path.join(ASSETS, m[1])
    }
    if ((m = /^\/vendor\/@carbon\/icons\/svg\/32\/([A-Za-z0-9-]+\.svg)$/.exec(p))) return path.join(CARBON, m[1])
    if ((m = /^\/glyphs\/([A-Za-z0-9-]+)\.svg$/.exec(p))) {
      const own = path.join(ASSETS, 'glyphs', m[1] + '.svg')
      return fs.existsSync(own) ? own : path.join(CARBON, m[1] + '.svg')
    }
    if ((m = /^\/logos\/([a-z0-9-]+\.(png|svg))$/.exec(p)) && logoFiles().includes(m[1])) return path.join(ASSETS, 'logos', m[1])
    return null
  }
  return {
    name: 'deck-demo',
    resolveId: (id) => (id === VIRTUAL || id === REGISTRY ? '\0' + id : null),
    load: async (id) => (id === '\0' + VIRTUAL ? `export default ${JSON.stringify(catalog())}` : id === '\0' + REGISTRY ? `export default ${JSON.stringify(await registrySnapshot())}` : null),
    configureServer(server) {
      // `npm run dev` + ?demo: serve the same static files the demo build copies
      server.middlewares.use(async (req, res, next) => {
        const url = req.url || ''
        const am = /^\/botavatar\/([a-z]+)-([a-z]+)\.png$/.exec(url.split('?')[0])
        if (am) {
          const png = await botAvatar(am[1], am[2]).catch(() => null)
          if (!png) return next()
          res.setHeader('content-type', 'image/png')
          return res.end(png)
        }
        const file = resolveStatic(url)
        if (!file || !fs.existsSync(file)) return next()
        res.setHeader('content-type', file.endsWith('.svg') ? 'image/svg+xml' : 'image/png')
        res.end(fs.readFileSync(file))
      })
    },
    configResolved(c) { outDir = path.resolve(c.root, c.build.outDir) }, // honors `vite build --outDir` (the e2e tests build into a temp dir)
    async closeBundle() {
      if (mode !== 'demo') return
      const out = outDir
      const copy = (from: string, to: string) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to) }
      const cat = catalog()
      for (const n of cat.custom) copy(path.join(ASSETS, 'glyphs', n + '.svg'), path.join(out, 'deck/assets/glyphs', n + '.svg'))
      for (const s of cat.sprites) copy(path.join(ASSETS, s + '.png'), path.join(out, 'deck/assets', s + '.png'))
      for (const f of cat.logos) {
        copy(path.join(ASSETS, 'logos', f), path.join(out, 'deck/assets/logos', f))
        copy(path.join(ASSETS, 'logos', f), path.join(out, 'logos', f))
      }
      for (const n of cat.carbon) {
        copy(path.join(CARBON, n + '.svg'), path.join(out, 'vendor/@carbon/icons/svg/32', n + '.svg'))
        if (!cat.custom.includes(n)) copy(path.join(CARBON, n + '.svg'), path.join(out, 'glyphs', n + '.svg'))
      }
      for (const n of cat.custom) copy(path.join(ASSETS, 'glyphs', n + '.svg'), path.join(out, 'glyphs', n + '.svg'))
      // static-host config (vercel.json / _headers / netlify.toml) lives in editor/hosting and ships at the site root
      const hosting = path.resolve(__dirname, 'hosting')
      if (fs.existsSync(hosting)) for (const f of fs.readdirSync(hosting)) copy(path.join(hosting, f), path.join(out, f))
      // the editor's bot picker shows /botavatar/<shape>-<color>.png (shape + color only)
      fs.mkdirSync(path.join(out, 'botavatar'), { recursive: true })
      for (const shape of SHAPES()) for (const color of BOT_COLORS) {
        const png = await botAvatar(shape, color).catch(() => null)
        if (png) fs.writeFileSync(path.join(out, 'botavatar', `${shape}-${color}.png`), png)
      }
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), deckDemo(mode)],
  define: { 'import.meta.env.VITE_DEMO': JSON.stringify(mode === 'demo' ? '1' : ''), 'import.meta.env.VITE_PUBLIC': JSON.stringify(mode === 'demo' && PUBLIC ? '1' : ''), __DECK_SHIPPED_LOGOS__: JSON.stringify(mode === 'demo' ? logoFiles().map((f) => f.replace(/\.(png|svg)$/, '')) : []) },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // the demo renders with the server's own src/render-spec.mjs, through browser shims
      '@deck': path.join(ROOT, 'src'),
      'node:fs': shim('fs.ts'),
      'node:path': shim('path.ts'),
      'node:module': shim('module.ts'),
      '@napi-rs/canvas': shim('canvas.ts'),
    },
  },
  base: '/',
  build: mode === 'demo'
    ? { outDir: '../web/site', emptyOutDir: true, chunkSizeWarningLimit: 1200 }
    : { outDir: '../web/dist', emptyOutDir: true },
  server: {
    port: 5610,
    fs: { allow: [ROOT] },
    // The server only accepts its own Host/Origin (DNS-rebinding guard), so the proxy presents them:
    // changeOrigin rewrites Host, and Origin is rewritten by hand (POST /api/login and the WebSocket check it).
    // That makes the dev server a same-origin client of DeckStudio: it listens on localhost only (Vite's
    // default), and it still needs the token (bin/deckctl open --dev prints a one-time login link).
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:7337',
        changeOrigin: true,
        configure: (proxy) => proxy.on('proxyReq', (req) => { if (req.getHeader('origin')) req.setHeader('origin', 'http://127.0.0.1:7337') }),
      },
      '/ws': {
        target: 'ws://127.0.0.1:7337',
        ws: true,
        changeOrigin: true,
        configure: (proxy) => proxy.on('proxyReqWs', (req) => req.setHeader('origin', 'http://127.0.0.1:7337')),
      },
    },
  },
}))
