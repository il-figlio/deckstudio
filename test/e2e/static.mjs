// A tiny static host for the e2e audits that behaves like the public demo's host: it applies the site's
// _headers file (editor/hosting/_headers, copied into the build; Netlify / Cloudflare Pages format, every
// matching block merged) and falls back to /index.html for extension-less paths, like the hosting rewrites.
// So the audits run under the real Content-Security-Policy and a CSP regression fails CI.
//   node test/e2e/static.mjs <dir> <port>
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.json': 'application/json', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.txt': 'text/plain', '.webmanifest': 'application/manifest+json' }

/** _headers → [{ re, headers: [[k, v]] }] */
export function parseHeaders(text) {
  const rules = []
  for (const line of text.split('\n')) {
    if (!line.trim() || line.trim().startsWith('#')) continue
    if (!/^\s/.test(line)) {
      const glob = line.trim()
      rules.push({ glob, re: new RegExp('^' + glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$'), headers: [] })
    } else if (rules.length) {
      const i = line.indexOf(':')
      if (i > 0) rules.at(-1).headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()])
    }
  }
  return rules
}
export const headersFor = (rules, pathname) => Object.fromEntries(rules.filter(r => r.re.test(pathname)).flatMap(r => r.headers))

export function serve(dir, port, host = '127.0.0.1') {
  const root = path.resolve(dir)
  const rules = fs.existsSync(path.join(root, '_headers')) ? parseHeaders(fs.readFileSync(path.join(root, '_headers'), 'utf8')) : []
  const srv = http.createServer((req, res) => {
    let p
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname) } catch { res.writeHead(400); return res.end() }
    let file = path.resolve(root, '.' + p)
    if (!file.startsWith(root)) { res.writeHead(403); return res.end() }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
    if (!fs.existsSync(file)) {
      if (path.extname(p)) { res.writeHead(404, headersFor(rules, p)); return res.end('not found') }
      file = path.join(root, 'index.html')
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', ...headersFor(rules, p) })
    res.end(fs.readFileSync(file))
  })
  return new Promise(r => srv.listen(port, host, () => r(srv)))
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, port] = process.argv.slice(2)
  await serve(dir, Number(port))
  console.log(`serving ${dir} on http://127.0.0.1:${port}/`)
}
