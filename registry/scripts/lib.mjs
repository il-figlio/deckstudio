// Shared helpers for build-index.mjs and check.mjs. No dependencies beyond Node (>= 22) and DeckStudio's
// own validator, imported from this repo (registry/ lives inside DeckStudio: ../../src/plugin-schema.mjs), so the
// registry checks always run against the app's code in the same commit.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const PLUGINS = path.join(ROOT, 'plugins')
export const INDEX = path.join(ROOT, 'index.json')
export const REGISTRY_SCHEMA = 'registry/v1'

/** DeckStudio's src/ in this checkout (plugin-schema.mjs for validation, plugins.mjs for the host dry-run). */
export function deckstudioSrc() {
  const srcDir = path.resolve(ROOT, '..', 'src')
  const p = path.join(srcDir, 'plugin-schema.mjs')
  if (!fs.existsSync(p)) throw new Error(`DeckStudio's validator not found at ${p}: run the registry scripts from a DeckStudio checkout`)
  return { schemaFile: p, srcDir }
}
export async function loadSchema() {
  const { schemaFile } = deckstudioSrc()
  const S = await import(pathToFileURL(schemaFile).href)
  if (typeof S.validateManifest !== 'function') throw new Error(`${schemaFile} doesn't export validateManifest`)
  return S
}

export const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')

/** Every plugins/<id>/ folder, sorted, with its manifest bytes (or a read error). */
export function pluginFolders() {
  if (!fs.existsSync(PLUGINS)) return []
  return fs.readdirSync(PLUGINS, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name).sort()
    .map(name => {
      const dir = path.join(PLUGINS, name)
      const file = path.join(dir, 'deckstudio.json')
      let bytes = null, error = null
      try { bytes = fs.readFileSync(file) } catch { error = 'missing deckstudio.json' }
      return { name, dir, file, bytes, error }
    })
}

/** Registry-side metadata that isn't part of the manifest (plugins/<id>/registry.json: { tags }). */
export function registryMeta(dir) {
  const f = path.join(dir, 'registry.json')
  if (!fs.existsSync(f)) return { tags: [] }
  const m = JSON.parse(fs.readFileSync(f, 'utf8'))
  return { tags: Array.isArray(m.tags) ? m.tags.filter(t => typeof t === 'string' && /^[a-z0-9-]{1,24}$/.test(t)).slice(0, 8) : [] }
}

/** Ids the registry refuses outright (private / this-Mac-only tool families). */
export const REFUSED_IDS = [/^ante(-|$)/]

/**
 * Validate one folder. Returns { id, manifest, errors, warnings } — registry rules on top of validateManifest:
 * folder name = id, no warnings, README.md and at least one fixture, no shell / network without a README section,
 * no refused ids.
 */
export function checkFolder(S, f) {
  const errors = [], warnings = []
  if (f.error) return { id: f.name, manifest: null, errors: [f.error], warnings }
  const r = S.validateManifest(f.bytes.toString('utf8'), { source: 'user' })
  errors.push(...r.errors)
  warnings.push(...r.warnings)
  const m = r.manifest
  if (!m) return { id: f.name, manifest: null, errors, warnings }
  if (m.id !== f.name) errors.push(`folder "${f.name}" must be named after the id "${m.id}"`)
  if (REFUSED_IDS.some(re => re.test(m.id))) errors.push(`id "${m.id}" isn't accepted in this registry`)
  const readme = path.join(f.dir, 'README.md')
  const readmeText = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8') : ''
  if (!readmeText) errors.push('README.md is required')
  if (!fixtureFiles(f.dir).length) errors.push('fixtures/*.json is required (a sample of the status output, plus <name>.expect.json)')
  if (m.permissions.shell && !/^#+\s*why shell/im.test(readmeText)) errors.push('permissions.shell needs a "## Why shell" section in README.md')
  if (m.permissions.network.length && !/^#+\s*network/im.test(readmeText)) errors.push('permissions.network needs a "## Network" section in README.md listing every host')
  if (m.icon?.file) {
    const p = path.join(f.dir, m.icon.file)
    if (!fs.existsSync(p)) errors.push(`icon ${m.icon.file} is missing`)
  }
  return { id: m.id, manifest: m, errors, warnings }
}

/** fixtures/*.json status samples (not the .expect.json files). */
export function fixtureFiles(dir) {
  const d = path.join(dir, 'fixtures')
  if (!fs.existsSync(d)) return []
  return fs.readdirSync(d).filter(n => n.endsWith('.json') && !n.endsWith('.expect.json')).sort().map(n => path.join(d, n))
}

/** The index entry for one valid manifest. */
export function indexEntry(f, m) {
  const bare = m.detect.bin.find(b => !b.includes('/'))
  const needs = {}
  if (m.detect.bundle[0]) needs.bundle = m.detect.bundle[0]
  if (bare) needs.bin = bare
  if (m.install?.brew) needs.brew = m.install.brew
  return {
    id: m.id,
    name: m.name,
    version: m.version,
    description: m.description ?? '',
    author: m.author ?? '',
    homepage: m.homepage ?? '',
    icon: m.icon ?? null,
    path: `plugins/${m.id}`,
    sha256: sha256(f.bytes),
    files: fileHashes(f.dir),
    tags: registryMeta(f.dir).tags,
    needs,
  }
}

/**
 * { "<relpath>": sha256 } for every file DeckStudio's installer copies from a plugin folder (same walk as
 * scanTree in DeckStudio's src/plugin-install.mjs: .git and .DS_Store skipped, symlinks and non-files refused).
 * The installer refuses any file that is missing from this map, extra, or different.
 */
export function fileHashes(dir) {
  const out = {}
  const walk = (d, rel) => {
    for (const n of fs.readdirSync(d).sort()) {
      if (n === '.git' || n === '.DS_Store') continue
      const p = path.join(d, n), r = rel ? `${rel}/${n}` : n
      const st = fs.lstatSync(p)
      if (st.isSymbolicLink()) throw new Error(`${r}: symlinks aren't allowed in a plugin folder`)
      if (st.isDirectory()) { walk(p, r); continue }
      if (!st.isFile()) throw new Error(`${r}: not a plain file`)
      out[r] = sha256(fs.readFileSync(p))
    }
  }
  walk(dir, '')
  return out
}

export function buildIndex(entries) {
  return JSON.stringify({ deckstudio: REGISTRY_SCHEMA, plugins: entries }, null, 2) + '\n'
}
