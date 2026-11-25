// Copies DeckStudio's docs/plugin.schema.json into this package (run before publishing). The package itself never
// imports DeckStudio: validate() is a hand validator that mirrors validateManifest; test/parity.test.js checks they agree.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const here = path.dirname(fileURLToPath(import.meta.url))
const src = process.env.DECKSTUDIO_SCHEMA || path.resolve(here, '../../../../docs/plugin.schema.json')
if (!fs.existsSync(src)) { console.log(`sync-schema: ${src} not found, keeping the bundled copy`); process.exit(0) }
fs.mkdirSync(path.join(here, '../schema'), { recursive: true })
fs.copyFileSync(src, path.join(here, '../schema/plugin.schema.json'))
console.log(`sync-schema: copied ${src}`)
