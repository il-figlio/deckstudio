// Plugin registry + install / uninstall / link (docs/PLUGINS.md). Shared by the server
// (GET /api/plugins/registry, POST /api/plugins/install | uninstall) and bin/deckctl, so the
// same checks apply whether a plugin comes from the editor's marketplace or the command line.
//
// A registry is a folder or an https URL to its index.json. The default is the registry that ships in this repo,
// <repo>/registry (found from this file's location, not the cwd), so a clone works offline and `git pull` updates
// it; env DECKSTUDIO_REGISTRY overrides it with another folder or URL. Either way it holds:
//   index.json = { "deckstudio": "registry/v1", "plugins": [{ id, name, version, description, author, homepage,
//                  icon, path: "plugins/<id>", sha256 (of its deckstudio.json), files: { "<relpath>": sha256 } (every file
//                  in the folder), tags, needs: { bundle?, bin?, brew? } }] }
//   plugins/<id>/deckstudio.json (+ an icon, README.md …)
//
// Installing copies plugins/<id>/ into ~/.deckstudio/plugins/<id> (dir 0700, files 0600, or 0700 when the
// source file is executable, like a status script). Refused: symlinks, anything that is not a plain file or
// folder, paths outside the registry, files over 2 MB, more than 50 files, a manifest whose sha256 differs
// from the index or that doesn't validate, an id that differs from the folder's, an entry without per-file
// hashes, and any file that is missing from the index's `files`, not listed there, or differs from its hash.
// URL registries: the entry's path must stay under index.json's folder on the same origin, and exactly the
// files listed in `files` are fetched, each checked against its hash. Installed plugins start off
// (user source); the caller also switches off a previous install's "enabled" so an update is reviewed again.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { MANIFEST, PLUGIN_ID_RE, validateManifest } from './plugin-schema.mjs'

export const REGISTRY_SCHEMA = 'registry/v1'
export const INSTALL_LIMITS = { files: 50, fileBytes: 2 << 20, depth: 6, index: 1 << 20 }
const HOME = os.homedir()
const HOME_DIR = process.env.DECKSTUDIO_HOME || path.join(HOME, '.deckstudio')
export const USER_PLUGINS = path.join(HOME_DIR, 'plugins')
const errOf = (msg, code = 400) => Object.assign(new Error(msg), { code })
export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

/**
 * The registry folder that ships with DeckStudio (registry/ next to src/). Its plugins are only offered in the
 * marketplace: plugin discovery (src/plugins.mjs) reads <repo>/plugins, never registry/plugins.
 */
export const BUNDLED_REGISTRY = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'registry')

/** Where the registry is: an https URL or a folder (~ expanded); unset or blank → BUNDLED_REGISTRY. */
export function registrySource(src = process.env.DECKSTUDIO_REGISTRY) {
  const s = String(src || '').trim() || BUNDLED_REGISTRY
  if (/^https:\/\//i.test(s)) return { kind: 'url', url: s.endsWith('.json') ? s : s.replace(/\/?$/, '/index.json') }
  if (/^[a-z]+:/i.test(s)) throw errOf('registry: a folder or an https url to index.json')
  return { kind: 'dir', dir: path.resolve(s.startsWith('~/') ? path.join(HOME, s.slice(2)) : s) }
}

async function fetchCapped(url, max = INSTALL_LIMITS.fileBytes) {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15e3) })
  if (!res.ok) { res.body?.cancel().catch(() => {}); throw new Error(`${url}: http ${res.status}`) }
  const chunks = []
  let n = 0
  for await (const c of res.body) { n += c.length; if (n > max) throw new Error(`${url}: over ${max >> 10} KB`); chunks.push(c) }
  return Buffer.concat(chunks)
}
const safeRel = p => typeof p === 'string' && p.length <= 200 && !p.startsWith('/') && !p.includes('\\') && !p.split('/').some(s => s === '..' || s === '.' || s === '') && /^[\w./-]+$/.test(p)
const inside = (root, p) => p === root || p.startsWith(root + path.sep)
const HEX64 = /^[0-9a-f]{64}$/
/** The index's per-file hashes, checked: { relpath: sha256 } with safe relative paths, ≤ INSTALL_LIMITS.files; null if absent or malformed. */
function cleanFileMap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const ent = Object.entries(v)
  if (!ent.length || ent.length > INSTALL_LIMITS.files || !ent.every(([k, h]) => safeRel(k) && typeof h === 'string' && HEX64.test(h))) return null
  return Object.fromEntries(ent)
}
const NO_FILES = 'the index has no per-file hashes for this plugin: rebuild the registry (node registry/scripts/build-index.mjs)'
/** Problems between a plugin's files ([{ rel, data }]) and the index's map: unlisted, different, or listed but missing. */
export function fileMapErrors(files, map) {
  if (!map) return [NO_FILES]
  const errors = []
  const seen = new Set()
  for (const f of files) {
    seen.add(f.rel)
    if (!Object.hasOwn(map, f.rel)) errors.push(`${f.rel}: not listed in the index (refused)`)
    else if (sha256(f.data) !== map[f.rel]) errors.push(`${f.rel}: sha256 mismatch with the index (refused)`)
  }
  for (const k of Object.keys(map)) if (!seen.has(k)) errors.push(`${k}: listed in the index but missing`)
  return errors
}
/**
 * A URL registry entry's file url: e.path (default plugins/<id>) and rel must be safe relative paths, and the result must be
 * on index.json's origin, under index.json's folder (no "../", no other host). Throws otherwise.
 */
export function entryUrl(src, e, rel) {
  const p = e.path ?? `plugins/${e.id}`
  if (!safeRel(p)) throw errOf(`${e.id}: bad path "${String(p).slice(0, 60)}"`)
  if (!safeRel(rel)) throw errOf(`${e.id}: bad file path "${String(rel).slice(0, 60)}"`)
  const base = new URL('./', src.url)
  const u = new URL(`${p}/${rel}`, base)
  if (u.origin !== base.origin || !u.pathname.startsWith(base.pathname) || u.search || u.hash) throw errOf(`${e.id}: ${p}/${rel} points outside the registry`)
  return u.href
}

/** The entry's plugin folder inside a dir registry (real path, never outside the registry, never a symlink). */
function entryDir(src, e) {
  const rel = e.path ?? `plugins/${e.id}`
  if (!safeRel(rel)) throw errOf(`${e.id}: bad path "${String(rel).slice(0, 60)}"`)
  const root = fs.realpathSync(src.dir)
  const p = path.join(root, rel)
  let st
  try { st = fs.lstatSync(p) } catch { throw errOf(`${e.id}: ${rel} is missing from the registry`) }
  if (st.isSymbolicLink()) throw errOf(`${e.id}: ${rel} is a symlink (refused)`)
  if (!st.isDirectory()) throw errOf(`${e.id}: ${rel} is not a folder`)
  const real = fs.realpathSync(p)
  if (!inside(root, real) || real === root) throw errOf(`${e.id}: ${rel} points outside the registry`)
  return real
}

/** Read and sanity-check index.json. Returns { source, entries } (entries: plain index fields, unverified). */
export async function readIndex(src = registrySource()) {
  let text
  if (src.kind === 'url') text = String(await fetchCapped(src.url, INSTALL_LIMITS.index))
  else {
    const f = path.join(src.dir, 'index.json')
    let st
    try { st = fs.lstatSync(f) } catch { throw errOf(`no registry at ${src.dir} (index.json missing)`, 404) }
    if (!st.isFile() || st.size > INSTALL_LIMITS.index) throw errOf('index.json: not a file (or over 1 MB)')
    text = fs.readFileSync(f, 'utf8')
  }
  let d
  try { d = JSON.parse(text) } catch (x) { throw errOf(`index.json: not json (${x.message})`) }
  if (d?.deckstudio !== REGISTRY_SCHEMA || !Array.isArray(d.plugins)) throw errOf(`index.json: expected { "deckstudio": "${REGISTRY_SCHEMA}", "plugins": [...] }`)
  const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : undefined)
  const seen = new Set()
  const entries = d.plugins.slice(0, 500).filter(e => e && PLUGIN_ID_RE.test(String(e.id)) && !seen.has(e.id) && seen.add(e.id)).map(e => ({
    id: e.id, name: str(e.name, 40) || e.id, version: str(e.version, 20) || '0.0.0', description: str(e.description, 300), author: str(e.author, 80),
    homepage: /^https:\/\//.test(String(e.homepage || '')) ? str(e.homepage, 300) : undefined, icon: str(e.icon, 80), path: e.path, sha256: HEX64.test(String(e.sha256)) ? e.sha256 : null, files: cleanFileMap(e.files),
    tags: Array.isArray(e.tags) ? e.tags.filter(t => typeof t === 'string' && /^[\w-]{1,24}$/.test(t)).slice(0, 12).map(t => t.toLowerCase()) : [],
    needs: e.needs && typeof e.needs === 'object' ? { bundle: str(e.needs.bundle, 120), bin: str(e.needs.bin, 120), brew: str(e.needs.brew, 120) } : {},
  }))
  return { source: src, entries }
}

/** An entry's manifest bytes (dir: from its folder; url: fetched next to index.json). */
async function manifestBytes(src, e) {
  if (src.kind === 'url') return fetchCapped(entryUrl(src, e, MANIFEST), 256 << 10)
  const f = path.join(entryDir(src, e), MANIFEST)
  const st = fs.lstatSync(f)
  if (!st.isFile()) throw errOf(`${e.id}: ${MANIFEST} is not a plain file`)
  if (st.size > 256 << 10) throw errOf(`${e.id}: ${MANIFEST} over 256 KB`)
  return fs.readFileSync(f)
}
/** Verify one entry: its manifest's sha256 matches the index, it validates, and its id matches. */
export async function verifyEntry(src, e) {
  try {
    const buf = await manifestBytes(src, e)
    const sha = sha256(buf)
    const v = validateManifest(buf.toString('utf8'), { source: 'user' })
    const errors = [...v.errors]
    if (v.manifest && v.manifest.id !== e.id) errors.unshift(`manifest id "${v.manifest.id}" differs from the index's "${e.id}"`)
    const verified = !!e.sha256 && sha === e.sha256
    if (!verified) errors.unshift(e.sha256 ? 'sha256 mismatch: the manifest differs from what the index lists' : 'no sha256 in the index')
    let treeOk = true
    // symlinks, sizes, file count and per-file hashes: refused at install, shown now
    if (src.kind === 'dir') try { const fe = fileMapErrors(scanTree(entryDir(src, e)).map(f => ({ rel: f.rel, data: fs.readFileSync(f.abs) })), e.files); if (fe.length) { treeOk = false; errors.push(...fe) } } catch (x) { treeOk = false; errors.push(x.message) }
    else if (!e.files) { treeOk = false; errors.push(NO_FILES) }
    else if (e.files[MANIFEST] !== sha) { treeOk = false; errors.push(`${MANIFEST}: its files hash differs from the manifest sha256`) }
    const ic = v.manifest?.icon
    let iconUrl = ic?.glyph ? `/glyphs/${ic.glyph}.svg` : ic?.logo ? `/logos/${ic.logo}.png` : undefined
    if (ic?.file && src.kind === 'dir') { // a small png / svg from the registry folder, inline (the editor's CSP allows data: images)
      try { const f = path.join(entryDir(src, e), ic.file), st = fs.lstatSync(f); if (st.isFile() && st.size <= 64 << 10) iconUrl = `data:image/${ic.file.endsWith('.svg') ? 'svg+xml' : 'png'};base64,${fs.readFileSync(f).toString('base64')}` } catch {}
    }
    return { ...e, sha, iconUrl, verified, valid: v.ok && v.manifest?.id === e.id && treeOk, errors, warnings: v.warnings, permissions: v.manifest?.permissions, install: v.manifest?.install, manifestVersion: v.manifest?.version, buf }
  } catch (x) {
    return { ...e, verified: false, valid: false, errors: [x.message], warnings: [] }
  }
}

/** Every registry entry, verified, with what's installed now. installed(id) → { source, version, sha } | null */
export async function listRegistry({ installed = () => null, src } = {}) {
  let source
  try { source = src || registrySource() } catch (x) { return { ok: false, error: x.message, source: null, plugins: [], tags: [] } }
  const where = source.kind === 'url' ? source.url : source.dir
  let idx
  try { idx = await readIndex(source) } catch (x) { return { ok: false, error: x.message, source: where, plugins: [], tags: [] } }
  // at most 8 entries verified at once: a URL registry may list hundreds, each a fetch
  const out = new Array(idx.entries.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(8, idx.entries.length) }, async () => {
    while (next < idx.entries.length) {
      const i = next++, e = idx.entries[i]
      const { buf, ...v } = await verifyEntry(source, e)
      const inst = installed(e.id)
      const update = !!inst && inst.source === 'user' && v.verified && (inst.version !== v.version || inst.sha !== v.sha)
      out[i] = { ...v, installed: inst, update, conflict: inst && inst.source !== 'user' ? `"${e.id}" is already a ${inst.source} plugin` : null }
    }
  }))
  return { ok: true, source: where, plugins: out, tags: [...new Set(out.flatMap(p => p.tags))].sort() }
}

/** sha256 + version of an installed manifest file. */
export function fileSha(file) { try { return sha256(fs.readFileSync(file)) } catch { return null } }

// ---------- copying ----------
/** Every file under a plugin folder, checked: no symlinks, plain files only, ≤ 50 files, each ≤ 2 MB. */
export function scanTree(dir) {
  const files = []
  const walk = (d, rel, depth) => {
    if (depth > INSTALL_LIMITS.depth) throw errOf(`${rel}: folders nested too deep`)
    for (const n of fs.readdirSync(d).sort()) {
      if (n === '.git' || n === '.DS_Store') continue
      const p = path.join(d, n), r = rel ? `${rel}/${n}` : n
      if (!/^[\w.@+ -]{1,100}$/.test(n) || n === '.' || n === '..') throw errOf(`${r}: unusual file name (refused)`)
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) throw errOf(`${r}: symlinks are refused`)
      if (st.isDirectory()) { walk(p, r, depth + 1); continue }
      if (!st.isFile()) throw errOf(`${r}: not a plain file (refused)`)
      if (st.size > INSTALL_LIMITS.fileBytes) throw errOf(`${r}: over ${INSTALL_LIMITS.fileBytes >> 20} MB (refused)`)
      files.push({ rel: r, abs: p, exec: (st.mode & 0o111) !== 0, size: st.size })
      if (files.length > INSTALL_LIMITS.files) throw errOf(`more than ${INSTALL_LIMITS.files} files (refused)`)
    }
  }
  walk(dir, '', 0)
  return files
}
/** Copy checked files into a fresh staging folder under userDir, then swap it in for userDir/<id>. */
function placeFiles(userDir, id, files /* [{ rel, data, exec }] */) {
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 })
  const target = path.join(userDir, id)
  let prev = null
  try { prev = fs.lstatSync(target) } catch {}
  if (prev?.isSymbolicLink()) throw errOf(`${id} is linked to a dev folder: deckctl plugin unlink ${id} first`)
  if (prev && !prev.isDirectory()) throw errOf(`${target} exists and is not a folder`)
  const stage = path.join(userDir, `.staging-${id}-${crypto.randomBytes(4).toString('hex')}`)
  fs.mkdirSync(stage, { mode: 0o700 })
  try {
    for (const f of files) {
      const dest = path.join(stage, f.rel)
      if (!inside(stage, path.resolve(dest))) throw errOf(`${f.rel}: outside the plugin folder (refused)`)
      fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 })
      fs.writeFileSync(dest, f.data, { mode: f.exec ? 0o700 : 0o600, flag: 'wx' })
    }
    let moved = null
    if (prev) moved = removeToTrash(userDir, id)
    fs.renameSync(stage, target)
    return { dir: target, replaced: !!prev, previous: moved }
  } catch (x) {
    fs.rmSync(stage, { recursive: true, force: true })
    throw x
  }
}
/** Move userDir/<id> into userDir/.removed/<id>-<time> (never deleted outright). */
function removeToTrash(userDir, id) {
  const trash = path.join(userDir, '.removed')
  fs.mkdirSync(trash, { recursive: true, mode: 0o700 })
  const to = path.join(trash, `${id}-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`)
  fs.renameSync(path.join(userDir, id), to)
  return to
}

/** Install from a local folder (deckctl plugin install <path>): validated, same file rules, no index / sha. */
export function installFromDir(dir, { userDir = USER_PLUGINS, expectId } = {}) {
  const src = path.resolve(dir)
  const st = fs.lstatSync(src)
  if (st.isSymbolicLink() || !st.isDirectory()) throw errOf(`${dir}: not a plain folder (symlinks are refused; use deckctl plugin link for dev folders)`)
  const files = scanTree(src)
  const mf = files.find(f => f.rel === MANIFEST)
  if (!mf) throw errOf(`${dir}: no ${MANIFEST}`)
  const v = validateManifest(fs.readFileSync(mf.abs, 'utf8'), { source: 'user' })
  if (!v.ok) throw errOf(`${MANIFEST} is invalid: ${v.errors.join('; ')}`)
  const id = v.manifest.id
  if (expectId && id !== expectId) throw errOf(`manifest id "${id}" differs from "${expectId}"`)
  const placed = placeFiles(userDir, id, files.map(f => ({ rel: f.rel, exec: f.exec, data: fs.readFileSync(f.abs) })))
  return { id, version: v.manifest.version, sha256: sha256(fs.readFileSync(mf.abs)), warnings: v.warnings, ...placed }
}

/** Install a registry entry by id: sha256-verified manifest, then its folder (dir registry) or manifest + icon + README (url registry). */
export async function installFromRegistry(id, { userDir = USER_PLUGINS, src = registrySource() } = {}) {
  if (!PLUGIN_ID_RE.test(String(id))) throw errOf('bad plugin id')
  const { entries } = await readIndex(src)
  const e = entries.find(x => x.id === id)
  if (!e) throw errOf(`"${id}" is not in the registry`, 404)
  const v = await verifyEntry(src, e)
  if (!v.verified || !v.valid) throw errOf(v.errors[0]?.startsWith(`${id}:`) ? v.errors[0] : `${id}: ${v.errors[0] || 'not verified'}`)
  let files
  if (src.kind === 'dir') {
    const dir = entryDir(src, e)
    // read once: the bytes checked against the index are the bytes written
    files = scanTree(dir).map(f => ({ rel: f.rel, exec: f.exec, data: fs.readFileSync(f.abs) }))
    const mf = files.find(f => f.rel === MANIFEST)
    if (!mf || sha256(mf.data) !== e.sha256) throw errOf(`${id}: manifest changed while installing`)
  } else {
    // exactly the files the index lists, each checked against its hash (no executables: a url carries no file mode)
    if (!e.files) throw errOf(`${id}: ${NO_FILES}`)
    files = []
    for (const [rel, h] of Object.entries(e.files)) {
      const data = rel === MANIFEST ? v.buf : await fetchCapped(entryUrl(src, e, rel))
      if (sha256(data) !== h) throw errOf(`${id}: ${rel}: sha256 mismatch with the index (refused)`)
      files.push({ rel, data, exec: false })
    }
  }
  const fe = fileMapErrors(files, e.files)
  if (fe.length) throw errOf(`${id}: ${fe[0]}`)
  const placed = placeFiles(userDir, id, files)
  return { id, version: v.version, sha256: v.sha, files: files.length, ...placed }
}

/** Uninstall a user plugin (a real folder in userDir, never a link or a built-in): moved to .removed/. */
export function uninstall(id, { userDir = USER_PLUGINS } = {}) {
  if (!PLUGIN_ID_RE.test(String(id))) throw errOf('bad plugin id')
  const p = path.join(userDir, id)
  let st
  try { st = fs.lstatSync(p) } catch { throw errOf(`${id} is not installed in ${userDir}`, 404) }
  if (st.isSymbolicLink()) throw errOf(`${id} is a linked dev folder: use deckctl plugin unlink ${id}`)
  if (!st.isDirectory()) throw errOf(`${p} is not a folder`)
  return { id, movedTo: removeToTrash(userDir, id) }
}

/** deckctl plugin link <dir>: userDir/<id> → the dev folder (a "linked" plugin, off until switched on). */
export function link(dir, { userDir = USER_PLUGINS } = {}) {
  const real = fs.realpathSync(path.resolve(dir))
  if (!fs.statSync(real).isDirectory()) throw errOf(`${dir} is not a folder`)
  let raw
  try { raw = fs.readFileSync(path.join(real, MANIFEST), 'utf8') } catch { throw errOf(`${dir}: no ${MANIFEST}`) }
  const v = validateManifest(raw, { source: 'linked' })
  if (!v.manifest || !PLUGIN_ID_RE.test(v.manifest.id)) throw errOf(`${MANIFEST}: ${v.errors[0] || 'no id'}`)
  fs.mkdirSync(userDir, { recursive: true, mode: 0o700 })
  const p = path.join(userDir, v.manifest.id)
  let exists = false
  try { fs.lstatSync(p); exists = true } catch {}
  if (exists) throw errOf(`${p} already exists (unlink or uninstall it first)`)
  fs.symlinkSync(real, p, 'dir')
  return { id: v.manifest.id, link: p, target: real, ok: v.ok, errors: v.errors, warnings: v.warnings }
}
export function unlink(id, { userDir = USER_PLUGINS } = {}) {
  if (!PLUGIN_ID_RE.test(String(id))) throw errOf('bad plugin id')
  const p = path.join(userDir, id)
  let st
  try { st = fs.lstatSync(p) } catch { throw errOf(`${id} is not linked`, 404) }
  if (!st.isSymbolicLink()) throw errOf(`${p} is not a link (installed plugins: deckctl plugin uninstall ${id})`)
  const target = fs.readlinkSync(p)
  fs.unlinkSync(p)
  return { id, target }
}
