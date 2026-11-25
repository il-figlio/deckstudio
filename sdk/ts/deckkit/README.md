# @deckstudio/deckkit (Node)

Expose a macOS tool to [DeckStudio](../../../README.md): a status file with a heartbeat, a status reader and CLI helper, a control token, and a `deckstudio.json` builder and validator. ESM, zero dependencies, Node 18+, with types in `src/index.d.ts`. MIT.

```sh
npm install @deckstudio/deckkit
```

The [SDK README](../../README.md) has the 5-minute guide, status semantics and the trust model.

## Status

```js
import { createStatus, readStatus, statusCli } from '@deckstudio/deckkit'

const status = createStatus({ app: 'MyTool' })   // ~/Library/Application Support/MyTool/deckstudio-status.json
// or { file, heartbeatMs (≤ 30000), keepAlive }
status.set('working', { jobs: 3 })                // write now; heartbeat every 30 s (an unref'd timer)
status.update({ jobs: 2, mode: null })            // merge; null / undefined removes
status.stop()                                     // final write: state 'off', running false
process.on('SIGTERM', () => { status.stop(); process.exit(0) })

const s = readStatus({ app: 'MyTool' })           // { state, stale, staleReason, values, pid, updatedAt, document, … }

// mytool status [--line|--json]: prints, returns the exit code (0; 2 for an unknown flag)
if (process.argv[2] === 'status') process.exit(statusCli(process.argv.slice(3), { app: 'MyTool' }))
```

- **Writes:** each write is atomic (a `0600` temp file with `O_EXCL`, then `rename`). The folder is created `0700` if it's missing.
- **Write errors** don't throw: the method returns `false` and sets `status.lastError`.
- **Fields:** the document is `{ schema: 'status/v1', state, running, pid, since, updated_at, values }`, with `updated_at` as ISO 8601 UTC with ms.
- **`readStatus` staleness:**
  - `"stale": true` in the document;
  - a dead `pid` while `running`;
  - a heartbeat (`updated_at` / `updatedAt` / `heartbeat`, ISO or epoch s/ms) older than `staleAfterMs` (default 95 000).

  When stale, `state` becomes `off`, and `document` (what `--json` prints) gets `state: 'off'` and `stale: true`. A missing file reads as `off` and not stale.
- **Paths:** `appDir(app)` is `~/Library/Application Support/<app>` on macOS, and `$XDG_STATE_HOME/<app>` or `~/.local/state/<app>` elsewhere. Also exported: `statusPath`, `tokenPath`, `heartbeatAt`, `isAlive`, `writeAtomic`, `STALE_MS`, `HEARTBEAT_MS`.

## Control token

```js
import { controlToken } from '@deckstudio/deckkit'
const token = controlToken({ app: 'MyTool' })     // ~/Library/Application Support/MyTool/control-token (0600)

// CLI (run by DeckStudio): attach it
await fetch(url, { method: 'POST', headers: { 'x-mytool-token': token.ensure() } })
const link = token.appendToken('mytool://start')  // mytool://start?token=…  (for a native app to open in-process)

// service / URL handler: check it (constant time)
token.verify(req.headers['x-mytool-token'])       // false for a missing, loose or symlinked token file
token.verifyUrl(link)
token.rotate()
```

Don't hand a tokened link to `open` (`spawn('open', [link])`): a process's argv is visible to every user on the Mac (`ps`). From Node, send the token in a loopback HTTP header instead; a Swift CLI can open the URL in-process with `NSWorkspace.shared.open`.

## Manifest

```js
import { manifest, validate } from '@deckstudio/deckkit'

manifest('mytool', { name: 'My Tool', version: '1.0.0' })
  .detect({ bin: ['mytool', '~/.local/bin/mytool'] })
  .statusFile('~/Library/Application Support/MyTool/deckstudio-status.json', { interval: 2 })   // stale: 95 by default
  .value('state', { path: '$.state', default: 'off', stale: 'off' })
  .value('jobs', '$.values.jobs')
  .cmd('toggle', ['$bin', 'toggle'], { title: 'Pause / resume' })
  .key('status', { label: '{self.state}', onPress: { type: 'plugin', action: 'toggle' } }, { title: 'My Tool' })
  .write('deck')                                   // validates, then writes deck/deckstudio.json

validate(JSON.parse(text))                         // { ok, errors, warnings }
```

Builder methods:

- **Fields:** `set`, `name`, `version`, `description`, `author`, `homepage`, `icon`, `detect`, `install`, `permissions`.
- **Status source:** `statusFile`, `statusCmd`, `statusHttp`.
- **Values, settings and actions:** `value` (paths, or tests like `{ path: '$.pct', atLeast: 80 }` for a lamp), `setting` (user-editable, `{settings.x}` in commands), `action` (`timeout` up to 1800 s, `detach: true` for long builds), `cmd`.
- **Templates:** `key`, `dial`, `page`.
- **Output:** `build`, `validate`, `write`.

`validate()` mirrors DeckStudio's `validateManifest` rule for rule, with the same messages, for a user-installed or linked plugin. It imports nothing from DeckStudio. `test/parity.test.js` runs both on about 100 manifests when DeckStudio is checked out next to the SDK. `deckctl plugin validate` remains the reference. The JSON Schema ships as `@deckstudio/deckkit/schema.json`; `npm run sync-schema` refreshes it from `docs/plugin.schema.json`.

`parsePath` and `jsonPath` evaluate DeckStudio's JSONPath-lite: `$`, `$.a.b`, `$.a[0]`, `$.a[-1]`, `$['k']`, `$.a.length`.

## Tests

```sh
npm test        # node --test
```
