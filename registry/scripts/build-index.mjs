#!/usr/bin/env node
// Regenerates registry/index.json from registry/plugins/<id>/deckstudio.json. Every manifest is validated with
// DeckStudio's own validateManifest (src/plugin-schema.mjs in this repo) plus the registry rules in lib.mjs; any
// error (or validator warning) fails the build and index.json is left untouched.
//
//   node registry/scripts/build-index.mjs           write registry/index.json
//   node registry/scripts/build-index.mjs --check   fail if registry/index.json is out of date (CI)
import fs from 'node:fs'
import { loadSchema, pluginFolders, checkFolder, indexEntry, buildIndex, INDEX } from './lib.mjs'

const checkOnly = process.argv.includes('--check')
const S = await loadSchema()
const entries = []
let failed = 0
for (const f of pluginFolders()) {
  const r = checkFolder(S, f)
  const problems = [...r.errors, ...r.warnings.map(w => `warning: ${w}`)]
  if (problems.length) {
    failed++
    console.error(`✗ ${f.name}\n${problems.map(p => `    ${p}`).join('\n')}`)
    continue
  }
  entries.push(indexEntry(f, r.manifest))
  console.log(`✓ ${r.id} ${r.manifest.version}`)
}
if (failed) {
  console.error(`\n${failed} plugin(s) failed validation; index.json not written.`)
  process.exit(1)
}
const next = buildIndex(entries)
if (checkOnly) {
  const cur = fs.existsSync(INDEX) ? fs.readFileSync(INDEX, 'utf8') : ''
  if (cur !== next) { console.error('\nregistry/index.json is out of date: run node registry/scripts/build-index.mjs and commit it.'); process.exit(1) }
  console.log(`\nindex.json is up to date (${entries.length} plugins).`)
} else {
  fs.writeFileSync(INDEX, next)
  console.log(`\nwrote index.json (${entries.length} plugins).`)
}
