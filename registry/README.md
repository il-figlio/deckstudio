# DeckStudio plugin registry

Community plugins for DeckStudio, kept in this folder of the DeckStudio repo. Each plugin is one `deckstudio.json` manifest in the `plugin/v1` format. It wraps a Mac tool's CLI, loopback HTTP endpoint or status file, and offers ready-made keys, dials and pages for it. DeckStudio never loads plugin code. It runs only the commands a manifest declares, and only while you have that plugin switched on with the permissions you granted. The format is specified in [`docs/PLUGINS.md`](../docs/PLUGINS.md).

| plugin | what | needs |
|---|---|---|
| [`codexbar`](plugins/codexbar) | Claude and Codex usage limits (5 h and weekly %), resets, incidents, spend | CodexBar (`brew install --cask codexbar`) |
| [`repobar`](plugins/repobar) | Pinned GitHub repos: open PRs and issues, press to open PRs | RepoBar (`brew install --cask repobar`) |
| [`poltergeist`](plugins/poltergeist) | Per-target build state and build-now keys for a Poltergeist project | Poltergeist (`brew install steipete/tap/poltergeist`) |
| [`hello`](plugins/hello) | Minimal example to copy | nothing |

The adapters for third-party apps are unofficial wrappers. Their apps' authors don't make or endorse them.

## How DeckStudio uses it

This folder is the marketplace's default registry (editor → plugins → marketplace, `deckctl plugin registry`). DeckStudio finds it next to its own `src/`, so a clone works offline and `git pull` brings new plugins and updates. Set `DECKSTUDIO_REGISTRY` to use another registry instead: a folder with the same layout, or an https URL to its `index.json`.

Plugins here are only offered, never loaded from here. Plugin discovery reads `plugins/` (DeckStudio's built-ins), `plugins/local/` and `~/.deckstudio/plugins/`, never `registry/plugins/`. Installing one copies its folder into `~/.deckstudio/plugins/<id>` after checking every file against `index.json`; it starts switched off, and an update switches it off again for review.

## Layout

```
registry/index.json                       generated: { "deckstudio": "registry/v1", "plugins": [ … ] }
registry/plugins/<id>/deckstudio.json     the manifest (folder name = id)
registry/plugins/<id>/README.md           what it shows, setup, where the data format comes from
registry/plugins/<id>/fixtures/*.json     sample status output + <name>.expect.json (expected values)
registry/plugins/<id>/registry.json       registry-only metadata: { "tags": [ … ] }
registry/scripts/build-index.mjs          validates every manifest and regenerates index.json
registry/scripts/check.mjs                validation + fixtures dry-run + PluginHost dry-run + index check
```

Each `index.json` entry has these fields:

```json
{ "id": "…", "name": "…", "version": "…", "description": "…", "author": "…", "homepage": "https://…",
  "icon": { "glyph": "…" }, "path": "plugins/<id>", "sha256": "<hex sha256 of deckstudio.json's bytes>",
  "files": { "<relpath>": "<sha256>" }, "tags": ["…"], "needs": { "bundle": "…", "bin": "…", "brew": "…" } }
```

`path` is relative to `index.json`. A client checks the manifest's `sha256` and every file's hash in `files` before installing; an extra, missing or changed file is refused. `needs` lists only what the manifest's `detect` and `install` say.

## Scripts

Both scripts need Node 22+ and nothing else: they import the validator and `PluginHost` from this repo's `src/`, so the registry never drifts from the app. Run them from the repo root:

```sh
npm run registry:check                          # both checks below, as CI runs them
node registry/scripts/build-index.mjs           # validate everything, rewrite index.json
node registry/scripts/build-index.mjs --check   # fail if index.json is stale
node registry/scripts/check.mjs                 # everything below
node registry/scripts/check.mjs repobar         # one plugin (skips the index check)
node registry/scripts/check.mjs --no-host       # skip the PluginHost dry-run
```

`check.mjs` runs these checks:

1. **Validation:** every manifest passes `validateManifest` with no errors and no warnings, plus the registry rules below.
2. **Fixtures dry-run:** each `fixtures/<name>.json` is parsed like real output, and its values must equal `fixtures/<name>.expect.json`.
3. **Templates:** every `{<id>.value}` a template shows is declared, every action it presses exists, and it passes only that action's `params`. Every placeholder in every action resolves.
4. **Host dry-run:** each plugin runs inside DeckStudio's real `PluginHost`, in a throwaway `DECKSTUDIO_HOME`. Its program is replaced by a fake that prints the fixture and records its argv. The check compares values and status argv, runs `cmd` actions against the fake, and resolves `app` actions through a stub. `url` actions are resolved but never opened. A real tool is never run: a plugin whose program isn't the fake is skipped and reported.
5. **Index:** `index.json` matches what `build-index.mjs` would write, including sha256 hashes.

## Contributing a plugin

Plugins arrive as pull requests to the DeckStudio repo that touch only `registry/` (plus the README table above). The general rules in [`CONTRIBUTING.md`](../CONTRIBUTING.md) apply too.

1. Fork DeckStudio and branch: `git switch -c plugin/<id>`.
2. Copy `registry/plugins/hello` to `registry/plugins/<id>`, then edit:
   - `deckstudio.json`;
   - `README.md`;
   - `fixtures/<name>.json` and `<name>.expect.json`;
   - optionally `registry.json` with tags.
3. Develop against a real DeckStudio, in one of two ways:
   - `deckctl plugin link registry/plugins/<id>`, then switch the plugin on in the editor's Plugins tab;
   - `deckctl plugin validate registry/plugins/<id>` or `POST /api/plugins/validate`.
4. Make the fixtures. Capture real output from the tool, or write it from its documented format, citing the source. Remove anything personal (emails, tokens, private repo names). Then write `<name>.expect.json` with the values the plugin should show.
5. Run the checks. They must pass with no warnings:

   ```sh
   node registry/scripts/build-index.mjs
   node registry/scripts/check.mjs
   ```

6. Commit the plugin folder **and** the regenerated `registry/index.json` together, then open a PR. CI runs the same checks, and a maintainer reviews it against the checklist below. In the PR, list:
   - what the plugin runs (every `cmd`, URL and host);
   - which permissions it declares and why;
   - where the status format comes from;
   - which fields you could not confirm.

### Updating a plugin

- Bump `version` with every change to `deckstudio.json`, and regenerate `index.json` so the hashes match. Installed copies are compared by `sha256`.
- Keep the fixtures in step with the tool. When the tool's output format changes, update the fixture and the README citation in the same PR.

### Manifest rules

- **Format:** `"deckstudio": "plugin/v1"`.
- **Id:** the folder name equals `id` (`a-z 0-9 -`, ≤ 32). An id is never reused for a different tool.
- **Validation:** no validator errors **or warnings**. Unknown fields are warnings, so put registry metadata in `registry.json`.
- **Not here:** built-in plugins (`builtin`, which live in DeckStudio's `plugins/`), and plugins for private or internal tools, which belong in DeckStudio's gitignored `plugins/local/`. Ids starting with `ante` are refused.

### Review checklist

- **Least privilege.** Ask only for what the templates need:
  - read-only status over a CLI, loopback HTTP or a file;
  - actions that do what their title says.

  No `cmd` deletes data, pushes, publishes or signs in.
- **No shell unless needed.** Use argv arrays (`["$bin", "verb", "{param}"]`), never `zsh -lc` strings. Never put an interpreter (`sh`, `node`, `python`, `osascript`, `open`, …) in argv[0]. `"shell": true` requires a `## Why shell` section in the plugin README, and the reviewer must agree that nothing else works. Bundled `$dir/` scripts are code too: keep them short and readable.
- **No network beyond what's declared.** HTTP goes to loopback. Any other host must be in `permissions.network` and named in a `## Network` README section. URL actions are `https:` unless a scheme is declared and justified. The plugin must not send your data anywhere the tool itself doesn't.
- **No branding without permission.** Don't copy an app's icon, logo, screenshots or name styling into the repo. Use a Carbon glyph (`"icon": { "glyph": "…" }`) or a logo DeckStudio already ships (`{ "logo": "…" }`), or include written permission from the owner in the PR. Say in the README that the plugin is a third-party wrapper, unless you are the tool's author.
- **Fixtures required.** They must be real output, or follow its documented format exactly: same field names, types, nesting and date encoding. Cite the source the format comes from (docs page or source file) in the README. Anonymize personal data. Flag every field you could not confirm.
- **Honest README.** Cover what it shows, setup (install, sign-in, CLI install), the exact command, the data source, and known caveats, such as array order or fields that may be missing.
- **Detect and install.** `detect` finds the tool where its installer puts it, by bundle id and/or bin. `install` gives the brew formula or cask and the official URL. DeckStudio shows `install` and never runs it.
- **Sensible polling.** The interval matches how often the data changes, and the timeout is small. Commands must not prompt (no Keychain or browser dialogs) and must exit 0 with JSON on success.

### Things we won't merge

- **Code dressed as data:** a plugin that runs a shell or interpreter without a reason it can't avoid, or that fetches and runs anything.
- **Undeclared data flows:** network access the manifest doesn't declare, or data sent anywhere the wrapped tool doesn't send it already.
- **Unlicensed branding:** an app's icons, logos or screenshots without permission from its owner.
- **Private tools:** plugins for private or internal tools, which stay in DeckStudio's gitignored `plugins/local/`. Built-in plugins don't belong here either.
- **Missing fixtures:** a plugin without fixtures, or with fixtures that don't match the real format.

Review the manifest, not the person (see [`CODE_OF_CONDUCT.md`](../CODE_OF_CONDUCT.md)).

## License

MIT, like the rest of DeckStudio (see [`LICENSE`](../LICENSE)). Plugins here are under the same license, unless their folder says otherwise. The tools they wrap keep their own licenses and trademarks (see [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md)).
