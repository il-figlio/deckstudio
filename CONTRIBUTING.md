# Contributing to DeckStudio

Thanks for helping. DeckStudio is a small, terse codebase; keeping it that way is the main style rule.

## Dev setup

Requirements: macOS 13+ (the device side), Node 22+, Xcode Command Line Tools (`xcode-select --install`).
Tests that don't need the device also run on Linux.

```sh
git clone https://github.com/il-figlio/deckstudio && cd deckstudio
npm install
(cd editor && npm install)
npm run build:helper        # Swift helper, bin/deckhelper (macOS)
npm run build               # helper + editor into web/dist
./bin/deckctl start --takeover && ./bin/deckctl open
```

Editor dev loop: `cd editor && npm run dev`, then `./bin/deckctl open --dev` (prints a `http://localhost:5610` link with a
one-time login code, to open while your dev server is the one on that port; the dev server proxies `/api` and `/ws` to the running server). The browser-only demo: `npm run build:demo` (output `web/site`).

## Tests

| Command | What |
|---|---|
| `npm test` | Unit tests in `test/unit/` (node:test). Hermetic: each uses a temp `DECKSTUDIO_HOME` and `HOME`. Capture tests use a fake `screencapture` and run on macOS only. |
| `npm run test:e2e` | Builds the demo into a temp dir, serves it, runs the Playwright audits in `test/e2e/`. First time: `npx playwright install chromium`. |
| `npm run test:swift` | Builds the helper and runs the DeckKit Swift package tests (macOS). |
| `npm run typecheck` | Editor TypeScript. |
| `npm run registry:check` | Plugin registry (`registry/`): manifest validation, fixtures and `PluginHost` dry-runs, `index.json` up to date. |
| `DECKSTUDIO_LIVE_TESTS=1 npm run test:live` | Opt-in: drives the MCP server against your running DeckStudio and real deck. Never in CI. |

Tests must never touch your real `~/.deckstudio`, deck or profile. Use `fs.mkdtemp` and set `DECKSTUDIO_HOME`
and `HOME` before importing from `src/`. Add a test with every behavior change and every bug fix.

## Pull requests

- Keep them focused; describe the problem and how you checked it (hardware photo or screenshot for visual changes).
- `npm test` and `npm run typecheck` must pass.
- No personal data in the repo: your paths, names, tokens, bot names or app profiles. Personal pages go in the
  gitignored `src/local-profile.mjs`; your own plugins in `plugins/local/`.

## Code style

- Terse and plain: small functions, comments only for the *why* or a non-obvious constraint.
- ESM, no build step for the server. Match the surrounding formatting.
- **No new dependency without a reason** that you state in the PR. The server has seven runtime dependencies on
  purpose.
- User-facing text: lowercase, short, no jargon.

## Plugins, recipes and the marketplace

- A plugin is one manifest: see [`docs/PLUGINS.md`](docs/PLUGINS.md) and [`sdk/README.md`](sdk/README.md);
  validate with `deckctl plugin validate`.
- Community plugins live in [`registry/`](registry/README.md): see "Contributing a plugin" below. Only the
  built-in plugins that ship enabled with DeckStudio belong in `plugins/`.
- Recipes live in `src/recipes.mjs`.

## Contributing a plugin

The plugin registry (the marketplace's default source) is the `registry/` folder of this repo. To add or update a
plugin, open a PR that touches only `registry/`:

1. Copy `registry/plugins/hello` to `registry/plugins/<id>` (folder name = the manifest's `id`), and fill in
   `deckstudio.json`, `README.md`, `fixtures/<name>.json` + `<name>.expect.json`, and optionally `registry.json` (tags).
2. Develop it in place with `deckctl plugin link registry/plugins/<id>`, or check it with `deckctl plugin validate`.
3. Regenerate the index and run the checks (no warnings allowed):

   ```sh
   node registry/scripts/build-index.mjs
   npm run registry:check
   ```

4. Commit the plugin folder and the regenerated `registry/index.json` together. Bump `version` on every change.
5. In the PR, list what the plugin runs (every `cmd`, URL and host), the permissions it declares and why, where
   its status format comes from, and any field you could not confirm.

Every plugin is reviewed against the checklist in [`registry/README.md`](registry/README.md#review-checklist): least
privilege, argv commands rather than a shell, no undeclared network access, no third-party branding without
permission, and fixtures that match the tool's real output.

## Logos and trademarks

App logos are third-party trademarks included for identification; see `THIRD_PARTY_NOTICES.md`. Owners can ask
for removal with the "logo takedown" issue template. Don't add logos you don't have a right to ship.

## License

By contributing you agree your work is licensed under the MIT License (`LICENSE`).
