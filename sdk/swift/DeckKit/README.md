# DeckKit (Swift)

Expose a macOS tool to [DeckStudio](../../README.md): a status file with a heartbeat, a status reader for your CLI, a control token and the `deckstudio.json` manifest. Requires macOS 13+ and Foundation only. MIT.

```swift
// Package.swift
dependencies: [.package(path: "../deckstudio/sdk/swift/DeckKit")],   // or a git URL
targets: [.executableTarget(name: "mytool", dependencies: ["DeckKit"])]
```

The [SDK README](../../README.md) has the 5-minute guide, status semantics and the trust model.

## `DeckStatus`: write the status

```swift
let status = DeckStatus(app: "MyTool")                  // ~/Library/Application Support/MyTool/deckstudio-status.json
// or DeckStatus(file: url, heartbeat: 30)
status.set("working", values: ["jobs": 3, "mode": "fast"]) // write now; heartbeat starts (every 30 s)
status.update(["jobs": 2, "mode": nil])                  // merge; nil removes
status.stop()                                            // final write: state "off", running false; heartbeat stops
status.stop(finalState: "done", values: ["jobs": 0])
```

- Every write is atomic: a temp file created `0600` with `O_EXCL`, then `rename(2)`. A missing folder is created `0700`.
- Writing is best-effort. `set`, `update`, `stop` and `write` return `false` and set `lastError` instead of throwing.
- `state` is cleaned to one word (whitespace becomes `-`, 40 characters at most).
- Values are `DeckValue`, a JSON enum with literals (`3`, `"x"`, `true`, `[…]`, `[:]`, `nil`). Whole numbers encode as integers.
- Call `stop()` from your SIGTERM/SIGINT handlers (see `examples/pomodoro`).

The document it writes:

```json
{"pid":4242,"running":true,"schema":"status/v1","since":"2026-11-24T09:41:07.120Z","state":"working","updated_at":"2026-11-24T09:41:37.120Z","values":{"jobs":3}}
```

## `DeckStatusReader`: read it the way DeckStudio does

```swift
let s = DeckStatusReader.read(app: "MyTool")      // or read(file:staleAfter:offState:now:isAlive:)
s.state        // "working", or "off" when missing / stale
s.stale        // the tool crashed (pid gone), its heartbeat is older than 95 s, or it says "stale": true
s.staleReason  // "pid" | "heartbeat" | "flag" | nil
s.values["jobs"]
s.document     // what `status --json` prints (state "off", "stale": true when stale)
```

A cleanly stopped status (`running: false`, what `stop()` writes, whatever the final state) is never stale by age, matching DeckStudio's `_state: stopped`. The `pid` counts as alive only when `kill(pid, 0)` succeeds. `EPERM` means another user's process reused the pid, so it is not yours.

## `DeckCLI`: `mytool status [--line|--json]`

```swift
DeckCLI.handleStatusIfRequested(Array(CommandLine.arguments.dropFirst()), file: DeckPaths.statusFile(app: "MyTool"))
// or: exit(DeckCLI.status(["--line"], file: url))     // or DeckCLI.render(...) → (output, code) for tests
```

- `--line` prints exactly one word.
- `--json` prints one line of JSON.
- No flag prints pretty JSON.
- The exit code is always 0. An unknown flag exits 2 with usage on stderr.

## `DeckControlToken`: only your CLI can trigger sensitive verbs

```swift
let token = DeckControlToken(app: "MyTool")          // ~/Library/Application Support/MyTool/control-token
// CLI side
let url = try token.appendToken(to: URL(string: "mytool://start")!)   // creates the token (0600) if needed
// App side (URL handler)
if token.verify(url: url) { start() } else { showWindowOnly() }
token.verify(headerValue)                             // any other channel (loopback HTTP header, XPC message…)
try token.rotate()                                    // invalidate old URLs
```

- The token is 32 bytes from `arc4random_buf`, as 64 lowercase hex characters.
- `read()` only trusts a regular file (not a symlink) owned by the current user, with no group or other permission bits.
- `verify` compares in constant time.
- Never put the token in `deckstudio.json`. The manifest calls your CLI, and the CLI adds the token.
- Open a tokened URL with `NSWorkspace.shared.open(url)`, in-process. Don't run `/usr/bin/open` (or anything else) with the URL as an argument: every user on the Mac can read a process's argv with `ps`.

## `DeckManifest`: emit `deckstudio.json`

```swift
var m = DeckManifest(id: "mytool", name: "My Tool", version: "1.0.0", description: "…")
m.icon = .glyph("timer")
m.detect = .init(bin: ["mytool", "~/.local/bin/mytool"])
m.status = .file("~/Library/Application Support/MyTool/deckstudio-status.json", interval: 2)   // stale: 95 by default
m.values = ["state": .spec(path: "$.state", default: "off", stale: "off"), "jobs": "$.values.jobs"]
m.actions = ["toggle": .cmd(["$bin", "toggle"], title: "Pause / resume"),
             "open": .app("com.example.mytool"), "docs": .url("https://example.com")]
m.templates = .init(keys: ["status": ["title": "My Tool", "template": ["label": "{self.state}", "onPress": ["type": "plugin", "action": "toggle"]]]])
precondition(m.check().isEmpty, m.check().joined(separator: "\n"))   // common mistakes, offline
try m.write(to: URL(fileURLWithPath: "deck"))                         // deck/deckstudio.json (pretty, sorted keys)
let back = try DeckManifest.read(from: URL(fileURLWithPath: "deck"))
```

Also: `m.settings = ["config": .init(default: "~/app/config.json", title: "Config file")]` (user-editable, `{settings.config}` in commands), value tests (`.spec(path: "$.pct", atLeast: 80)` → `"on"` / `""` for a lamp), and `Action(cmd: …, timeout: 1200, detach: true)` for long builds.

`check()` covers a subset of DeckStudio's rules: id, value names and paths, a single transport, argv[0] and interpreter use, URL schemes, `$bin` / `bundle` requirements, settings (names, types, undeclared `{settings.x}`), value tests and `detach`. Run `deckctl plugin validate <dir>` for the full check.

## `DeckPaths`

`home` (honours `$HOME`, like Node's `os.homedir()`), `appSupport(app)`, `statusFile(app:)`, `tokenFile(app:)`, `expand("~/…")`.

## Tests

```sh
swift build && swift test
```

The tests use swift-testing. On a Mac with only the Command Line Tools (no Xcode), `Package.swift` points the test target at the CLT's `TestingMacros` plugin. Xcode toolchains don't need that, and the flag is skipped when the plugin isn't there.
