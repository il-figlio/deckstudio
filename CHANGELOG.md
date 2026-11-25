# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versioning: [SemVer](https://semver.org/).

## [Unreleased]

## [0.1.0]

First public release.

### Added
- Direct-HID driver for the Stream Deck+ (8 keys, 4 dials, 800x100 touch strip) with a full-width strip canvas
  and raw swipe events; works without the Elgato app, which is quit while DeckStudio owns the device.
- Browser editor with a live mirror of the hardware, interactive dials, undo/redo, themes, pages and
  import/export; the SPEC-01 hardware look on the editor and on the device.
- Actions: pages, shell, URL/app/file, keyboard shortcut and type text, AppleScript, Shortcuts, HTTP, media keys,
  volume and brightness, hold-to-talk, sequences. Live data from polled commands, shown as `{vars}`.
- App-aware pages that switch while chosen apps are in front.
- Agent alerting: a page and strip alerts for agents that need you, finished or working. Rex terminal sessions
  are read live; Claude Code, Codex and any agent can report through `bin/deck-agent-hook` or the HTTP API.
- Bring-your-own bots, with Grok Bot support built in; bots page, per-key bot binding, pinned slots.
- Capture: screenshots and screen recording with correct permission and error handling.
- Audio and camera page: switch mic and output, mic mute, camera-in-use lamp.
- Icon Studio: turn logos, glyphs, app icons and uploads into pixel art.
- Recipes: 31 ready-made keys, dials and pages, each with a copyable agent setup prompt.
- Plugins (`plugin/v1`): manifest-only, permissioned, with a marketplace installer that verifies SHA-256; a plugin
  registry in `registry/` with third-party adapters (CodexBar, RepoBar, Poltergeist) and a `hello` example.
- SDKs: Swift (`sdk/swift/DeckKit`) and TypeScript (`sdk/ts/deckkit`) with examples; JSON Schema for manifests.
- MCP server (`bin/deckstudio-mcp`) and `deckctl` CLI.
- Static browser demo (`npm run build:demo`), no server needed.
- Tests: unit, mock-server MCP, browser audits (Playwright), Swift SDK tests; CI on Linux and macOS.

[Unreleased]: https://github.com/il-figlio/deckstudio/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/il-figlio/deckstudio/releases/tag/v0.1.0
