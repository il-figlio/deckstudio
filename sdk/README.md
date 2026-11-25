# DeckStudio SDK

Put your macOS tool on a Stream Deck+ through [DeckStudio](../README.md). Your tool doesn't link against DeckStudio or run inside it. You ship one file, `deckstudio.json`, and DeckStudio does the rest:

- it reads your tool's **status** (a JSON file, a command, or a loopback URL) and shows its values on keys, dials and the touch strip;
- it runs your tool's **actions** (argv commands, loopback HTTP, URLs, opening your app) when a key is pressed;
- it offers your **templates** (ready-made keys, dials and pages) as one-click recipes.

This SDK covers the parts that are easy to get subtly wrong: atomic status files with a heartbeat, staleness that matches DeckStudio's, a control token, and a manifest that validates.

| package | for | install |
|---|---|---|
| [`swift/DeckKit`](swift/DeckKit/README.md) | Swift CLIs and apps (macOS 13+, Foundation only) | SwiftPM: `.package(path:)` or a git URL |
| [`ts/deckkit`](ts/deckkit/README.md) | Node tools (Node 18+, ESM, no dependencies, `.d.ts` included) | `npm install @deckstudio/deckkit` |
| [`examples/`](examples) | `pomodoro` (Swift, status file) and `ticker` (Node, status command + control token) | |

The spec is [`docs/PLUGINS.md`](../docs/PLUGINS.md). Editors can use the JSON Schema in [`docs/plugin.schema.json`](../docs/plugin.schema.json). The authoritative validator is `validateManifest` in [`src/plugin-schema.mjs`](../src/plugin-schema.mjs), which `deckctl plugin validate` wraps. MIT licensed, like DeckStudio.

## Expose your tool in 5 minutes

### 1. Write a manifest

```sh
deckctl plugin init mytool ~/src/mytool/deck   # scaffolds deckstudio.json, a README and an example status script
```

You can also write the file by hand. A minimal manifest for a CLI called `mytool` that keeps a status file:

```json
{
  "deckstudio": "plugin/v1",
  "id": "mytool",
  "name": "My Tool",
  "version": "1.0.0",
  "detect": { "bin": ["mytool", "~/.local/bin/mytool"] },
  "status": { "file": "~/Library/Application Support/MyTool/deckstudio-status.json", "interval": 2, "stale": 95 },
  "values": {
    "state": { "path": "$.state", "default": "off", "stale": "off" },
    "jobs":  { "path": "$.values.jobs", "default": 0, "stale": 0 }
  },
  "actions": {
    "toggle": { "title": "Pause / resume", "cmd": ["$bin", "toggle"] }
  },
  "templates": {
    "keys": {
      "status": { "title": "My Tool", "what": "Shows the state; press pauses or resumes.",
        "template": { "label": "{self.state}", "title": "{self.jobs} jobs", "led": "{self.jobs}",
                      "onPress": { "type": "plugin", "action": "toggle" } } }
    }
  }
}
```

The manifest builders can generate this file for you: `DeckManifest` in Swift and `manifest()` in Node.

### 2. Emit status

Swift:

```swift
import DeckKit
let status = DeckStatus(app: "MyTool")            // ~/Library/Application Support/MyTool/deckstudio-status.json
status.set("working", values: ["jobs": 3])        // writes now, then a heartbeat every 30 s
status.update(["jobs": 2])                        // merge values
status.stop()                                     // on quit: state off, running false
```

Node:

```js
import { createStatus } from '@deckstudio/deckkit'
const status = createStatus({ app: 'MyTool' })
status.set('working', { jobs: 3 })
process.on('SIGTERM', () => { status.stop(); process.exit(0) })
```

### 3. Add `status --line|--json` to your CLI (optional, recommended)

Scripts, Shortcuts and a `cmd` status source can then ask your tool directly. The answer always exits 0, and it says `off` when the tool isn't running, even after a crash:

```swift
DeckCLI.handleStatusIfRequested(Array(CommandLine.arguments.dropFirst()), file: DeckPaths.statusFile(app: "MyTool"))
```

```js
if (process.argv[2] === 'status') process.exit(statusCli(process.argv.slice(3), { app: 'MyTool' }))
```

### 4. Add actions

Prefer argv commands that start with `"$bin"`, the program `detect.bin` found. They run without a shell, so the user only has to switch the plugin on. Arguments may use `{value}`, `{delta}` and any name listed in `params`:

```json
"start": { "title": "Start", "cmd": ["$bin", "start", "{minutes}"], "params": ["minutes"], "toast": true }
```

A key calls it with `{ "type": "plugin", "action": "start", "args": { "minutes": "25" } }`. If a verb must not be triggerable from a web page, read on to [the control token](#the-control-token).

### 5. Validate, link, switch on

```sh
deckctl plugin validate ~/src/mytool/deck     # offline check against DeckStudio's validator
deckctl plugin link ~/src/mytool/deck         # ~/.deckstudio/plugins/mytool → your folder; edits are picked up live
deckctl plugin enable mytool                  # linked and installed plugins start off
deckctl plugin info mytool                    # state, values, actions (and why one is blocked)
deckctl plugin run mytool toggle              # try an action without a key
```

Your templates then show up in the editor's recipes and in `deckctl recipe list` as `plugin-mytool-<name>`.

## Status semantics

The status file the SDK writes, rewritten atomically (temp file `0600` + `rename`) in a `0700` folder:

```json
{"schema":"status/v1","state":"working","running":true,"pid":4242,
 "since":"2026-11-24T09:41:07.120Z","updated_at":"2026-11-24T09:41:37.120Z","values":{"jobs":3}}
```

| field | meaning |
|---|---|
| `state` | One short word (`idle`, `working`, `paused`, …). `off` means not running. Map it with `"$.state"`. |
| `values` | Your numbers and words. Map them with `"$.values.<name>"`. |
| `updated_at` | ISO 8601 UTC with milliseconds. Rewritten at least every **30 s** while running (the heartbeat), even when nothing changed. |
| `pid`, `running` | The writing process. While `running` is true, DeckStudio checks that the pid is alive. |
| `since` | When `state` last changed. |

DeckStudio considers the status **stale** when:

- the process in `pid` is gone while `running` is true. This happens after a crash or `kill -9`, and is noticed on the next read (about 1 s);
- `updated_at` (or `updatedAt` / `heartbeat`; ISO or epoch seconds or ms) is older than the manifest's `status.stale`. Use **95 s**: three missed heartbeats plus slack. That is also DeckStudio's default (`max(95, 3 × interval)`);
- the document says `"stale": true`, which is what `status --json` prints for a dead tool;
- no read succeeded for `status.stale` seconds.

While the status is stale, each value shows its `stale` text, else its `default`, else nothing, and `{id._state}` is `stale`. **Give every value a `stale` text** (`"off"`, `"--:--"`, `0`), so a crashed tool never shows as busy.

Some other cases:

- **A clean exit:** `stop()` writes `running: false` and the final state (for example `off` or `done`). DeckStudio shows that state and those values however old the heartbeat gets, and `{id._state}` reads `stopped`, so a clean exit never looks like a crash (`stale`). The SDK readers (`readStatus`, `DeckStatusReader`) agree: a `running: false` document is never stale by age.
- **Never started:** if your tool has never run, a `file` status reads as `_state: stopped` (not an error) with every value at its `default`.
- **The pid check:** `kill(pid, 0)` must succeed. `EPERM` (another user's process that reused the pid) counts as gone, in DeckStudio and in the SDKs.
- **Status commands:** a `cmd` status (`["$bin", "status", "--json"]`) whose tool isn't running prints `{"state":"off","running":false}` and reads as `_state: stopped`, `state: off`; after a crash it prints `"stale": true` and reads as `_state: stale`.

**Keep user content out of the status.** Any local process can read the file, and keys show it on a physical device. Use counts, state words and booleans, never document titles, text, paths or URLs.

## Trust model

- **DeckStudio never loads your code.** It runs only what the manifest declares: argv commands, loopback HTTP, files and URLs. It does that only while the user has the plugin switched on.
- **Off by default.** Installed and linked plugins start disabled. Switching one on means trusting its declared argv commands, which run as the user. `deckctl plugin info` lists them.
- **Escape hatches need a grant.** Shell-string commands, interpreters as argv[0] (`sh`, `node`, `python`, `osascript`, `open`, …), URL schemes other than `https`, and non-loopback hosts must be declared in `permissions` *and* granted by the user (`deckctl plugin grant`). A manifest can't grant itself anything.
- **Files are fenced.** A `file` status can't point into `~/.ssh`, `~/.aws`, Keychains, browser cookies or DeckStudio's own token.
- **Ship a real executable.** This is why the Node example's `cmd` is `["$dir/ticker.mjs", …]` (an executable with a `#!/usr/bin/env node` line) rather than `["node", "ticker.mjs"]`: the former needs no shell grant.

## The control token

DeckStudio runs your CLI directly, and that's a trusted path. Your app's other doors are not: any web page can open `mytool://start` or POST to `http://127.0.0.1:<port>/start`. A verb that records, sends or acts on the user's behalf should require a **control token**:

1. The token is 64 hex characters in a `0600` file only this user can read: `~/Library/Application Support/<App>/control-token`.
2. Your **CLI** reads it (`ensure()` creates it) and attaches it: `appendToken(to: url)` for a URL scheme, or a header for loopback HTTP.
3. Your **app or service** checks it with a constant-time compare (`verify(url:)` / `verify(token)`). A missing, wrong, loose-permission or symlinked token file means "untrusted". Without the token, do only harmless things, like showing a window.
4. The manifest's action calls the CLI (`["$bin", "start"]`), never the bare URL. The token never appears in `deckstudio.json`.
5. **Keep the token out of argv.** Every user on the Mac can see a process's arguments (`ps -o args`), so don't run `/usr/bin/open "mytool://start?token=…"` or pass the token on any command line. Open a tokened URL in-process (`NSWorkspace.shared.open(url)` in Swift), or prefer the loopback HTTP header, which never touches argv. From Node there's no in-process `open`: use the header.

```swift
// CLI
let url = try DeckControlToken(app: "MyTool").appendToken(to: URL(string: "mytool://start")!)
NSWorkspace.shared.open(url)          // in-process: the token never shows up in another process's argv
// App, in your URL handler
let trusted = DeckControlToken(app: "MyTool").verify(url: url)
```

```js
// CLI
await fetch(`http://127.0.0.1:${port}/bump`, { method: 'POST', headers: { 'x-mytool-token': controlToken({ app: 'MyTool' }).ensure() } })
// service
if (!controlToken({ app: 'MyTool' }).verify(req.headers['x-mytool-token'])) return res.writeHead(403).end()
```

## Examples

| | what it shows |
|---|---|
| [`examples/pomodoro`](examples/pomodoro) | A Swift CLI (`run`, `start`, `stop`, `status`) using `DeckStatus` + `DeckCLI` with a **file** status. Includes key and dial templates. |
| [`examples/ticker`](examples/ticker) | A Node loopback service using `createStatus`, `statusCli` and `controlToken`, with a **cmd** status. Its `deckstudio.json` is generated by `make-manifest.mjs` with the builder. |
| [`examples/e2e.mjs`](examples/e2e.mjs) | Loads both examples through DeckStudio's real `PluginHost` in a scratch `HOME` / `DECKSTUDIO_HOME`. It runs their actions and checks values, a `kill -9` (stale via pid), an old heartbeat, a clean finish, and that the token refuses forged requests. |

```sh
node sdk/examples/e2e.mjs            # builds pomodoro (swift build -c release); KEEP=1 keeps the scratch folder
```

To try an example on your own deck:

```sh
cd sdk/examples/pomodoro && swift build -c release && cp .build/release/pomodoro ~/.local/bin/
deckctl plugin link . && deckctl plugin enable pomodoro
```

## Tests

```sh
cd sdk/swift/DeckKit && swift test       # swift-testing (works with Command Line Tools alone, no Xcode needed)
cd sdk/ts/deckkit && npm test            # node --test, including parity with DeckStudio's validateManifest
node sdk/examples/e2e.mjs
```
