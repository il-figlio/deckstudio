# DeckStudio plugins (plugin/v1)

A plugin is a small macOS tool that gets onto the Stream Deck+ through one file, `deckstudio.json`. The manifest says:

- how to tell whether the tool is installed,
- where its status comes from,
- which values in that status keys can show,
- which actions keys can run,
- which settings the user can change (a config path, target names, …),
- which keys, dials and pages it offers as templates.

DeckStudio never loads plugin code. It only runs the commands, fetches the loopback URLs and reads the files a manifest declares. It does that only while the user has the plugin switched on, and only with the permissions the user granted. This is the same trust model as bring-your-own-bots (`src/bot-schema.mjs`): a manifest asks, the user decides, and the decision lives in the profile, never in the manifest.

| | |
|---|---|
| Validator (shared by the server, the browser demo and tools) | `src/plugin-schema.mjs` (`validateManifest`) |
| Host (discovery, detection, polling, actions) | `src/plugins.mjs` (`PluginHost`) |
| JSON Schema for editors | `docs/plugin.schema.json` (`"$schema": "…/docs/plugin.schema.json"` in a manifest) |
| Built-in examples | `plugins/capture`, `plugins/bots`, `plugins/grokbot` |

## Where plugins live

Each plugin is a folder holding `deckstudio.json` (plus any icon or helper scripts). The folder name should equal the `id`.

| source | folder | starts | notes |
|---|---|---|---|
| `builtin` | `<repo>/plugins/<id>/` | on | Ships with DeckStudio. Only these may set `"builtin"` and wrap DeckStudio's own actions. |
| `local` | `<repo>/plugins/local/<id>/` | on | This Mac's own plugins: internal tools, private paths. Gitignored. |
| `user` | `~/.deckstudio/plugins/<id>/` | off | Installed plugins. |
| `linked` | `~/.deckstudio/plugins/<name>` as a symlink to a dev folder | off | Development (`deckctl plugin link`). Edits are picked up live. |

- **Rescans:** folders are rescanned every 3 s, and a manifest is re-read when its mtime or size changes. `POST /api/plugins/rescan` forces a rescan.
- **Same id twice:** the first plugin found wins, in this order: builtin, local, then user/linked by folder name. Any later plugin with that id is listed with a `duplicate` error.
- **Size:** a manifest is at most 256 KB.

## The manifest

```jsonc
{
  "$schema": "../../docs/plugin.schema.json",
  "deckstudio": "plugin/v1",                    // required
  "id": "codexbar",                             // required: a-z 0-9 -, ≤ 32; template vars are {codexbar.<value>}
  "name": "CodexBar", "version": "1.0.0", "author": "…", "homepage": "https://…", "description": "…",
  "icon": "icon.png" | { "glyph": "<carbon icon>" } | { "logo": "<assets/logos name>" },
  "detect":  { "bundle": "com.x.codexbar", "bin": ["codexbar", "~/.local/bin/codexbar"], "paths": ["~/Library/Application Support/CodexBar"] },
  "install": { "brew": "--cask codexbar", "url": "https://…", "note": "…" },   // shown to the user, never run
  "settings": { "config": { "type": "string", "title": "Config file", "default": "~/Projects/app/tool.json" } },  // the user edits these
  "status":  { "cmd": ["$bin", "status", "--json", "--config", "{settings.config}"], "interval": 30, "timeout": 10, "stale": 95 }
           | { "http": "http://127.0.0.1:4242/status" } | { "file": "~/Library/Application Support/CodexBar/status.json" },
  "values":  { "claude_5h": "$.claude.session.pct", "state": { "path": "$.state", "default": "off", "stale": "off", "map": { "busy": "working" } },
               "claude_hot": { "path": "$.claude.session.pct", "atLeast": 80 } },        // "on" at ≥ 80, else ""
  "actions": {
    "open":   { "type": "app", "target": "bundle" },
    "toggle": { "cmd": ["$bin", "toggle"] },
    "site":   { "type": "url", "url": "https://example.com/{value}" },
    "repo":   { "type": "url", "url": "https://github.com/{repo|path}/pulls", "params": ["repo"] },
    "build":  { "cmd": ["$bin", "build"], "detach": true, "timeout": 1200, "toast": true },
    "ping":   { "http": "http://127.0.0.1:4242/ping", "method": "POST", "body": { "v": "{value}" } }
  },
  "templates": { "keys": { "usage": { "title": "Claude 5 h usage", "what": "…", "template": { "label": "{self.claude_5h}%", "onPress": { "type": "plugin", "action": "open" } } } },
                 "dials": { … }, "pages": { … } },
  "bots": { "cmd": ["$bin", "bots", "--json"], "interval": 15 },                  // optional: also a bots provider
  "permissions": { "shell": false, "schemes": [], "network": [] }
}
```

Unknown fields are warnings and are ignored. Anything that would be unsafe or ambiguous is an error. A plugin with errors is listed with them (state `invalid`) and does nothing.

### detect → installed

- **When it counts as installed:** when any entry matches. A plugin with no `detect` always counts as installed.
- **`bundle`:** bundle ids, checked with `deckhelper installed` (NSWorkspace). The first installed one becomes the plugin's app.
- **`bin`:** executables. Each entry is an absolute, `~/` or `$dir/` path (`$dir` is the plugin folder), or a bare name searched on PATH plus `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` and `~/bin`. The first one found is `$bin`.
- **`paths`:** a file or folder whose existence means installed.
- **Re-checks:** detection reruns every 60 s, so installing the tool makes the plugin come alive without a restart.

### status transports

There is one status source per plugin. Each successful read gives a document: JSON if the output parses as JSON (`"parse": "auto"`), otherwise the first line of text. `"parse": "json" | "text"` forces one or the other.

| transport | how | rules |
|---|---|---|
| `cmd` (argv) | `["$bin", "status", "--json"]` | Spawned directly, never through a shell. argv[0] is the plugin's own program: `"$bin"`, one of its `detect.bin` entries, or `"$dir/…"` (a file shipped in the plugin, which must really be inside the plugin folder, not a symlink out of it). Any other program needs the `shell` permission, and so do shells, interpreters and wrappers anywhere in argv[0] or `detect.bin` (`sh`, `zsh`, `env`, `osascript`, `python`, `node`, `open`, `arch`, `awk`, `find`, `caffeinate`, `script`, `nohup`, `git`, …): each can run arbitrary code through its arguments. `"$bin"` is replaced only as a whole argv element (a manifest that uses it needs `detect.bin`). Later elements may use `{settings.x}` and `{<id>.<value>}`; an element that then starts with `~/` is expanded. Output is capped at 1 MB. On `timeout` (default 10 s, max 60) the whole process group is killed (SIGKILL). Env: `DECK_PLUGIN`, `DECK_PLUGIN_DIR`, `DECK_BIN` (the detected program), `DECKSTUDIO_HOME`, `DECK_SETTINGS_<NAME>`. A non-zero exit is an error (first line of stderr). |
| `cmd` (string) | `"mytool status \| head -1"` | Runs with `zsh -lc`. Needs `"permissions": { "shell": true }` and the user's grant. Values are never templated into a shell string; they arrive only as env (`$DECK_VALUE`, `$DECK_SETTINGS_CONFIG`, …). `$bin` isn't replaced there (a warning): use `"$DECK_BIN"`. |
| `http` | `"http://127.0.0.1:4242/status"` | GET, http(s) only, no user info. `127.0.0.1`, `localhost` and `[::1]` always work. Any other host must be in `permissions.network` and granted. Redirects aren't followed, the body is capped at 1 MB, and the timeout applies. |
| `file` | `"~/Library/Application Support/X/status.json"` | Read when its mtime or size changes (≤ 1 MB). May start with a setting (`"{settings.status_file}"`); once filled it must be an absolute or `~/` path without `..`. **Allowed places:** the plugin's own folder, `~/.deckstudio/status/<id>/` (not the rest of `~/.deckstudio`: it holds the profile, its backups and the logs), `~/Library/Application Support/<dir>` for an app folder the manifest declares (in `detect.paths` or a literal `status.file` there), and the exact file a literal `status.file` names (the user sees it before switching the plugin on). A path from a setting must be inside one of those folders. The path is canonicalized (symlinks resolved, `realpath`) and compared case-insensitively, since APFS usually is (`~/.SSH` is `~/.ssh`). As a second line, `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.kube`, `~/.docker`, `~/.netrc`, `~/.config/gh`, `~/.config/gcloud`, `~/.git-credentials`, `~/.npmrc`, `~/.pypirc`, Keychains, Cookies, Messages, Mail, Contacts and, in `~/.deckstudio`, the `token`, `server.json`, `profile*.json*` (the profile, its backups and temp files) and every `*.log` are always off limits. A file that doesn't exist (the tool never ran, or removed it) is `stopped`, not an error. The tool should write a temp file and rename it. |
| `builtin` | `{ "builtin": "capture" }` | Built-in plugins only. DeckStudio's own state (`capture`, `bots`, `grokbot`). |

- **`interval`:** seconds between reads, at least 1 (defaults: cmd 30, http 10, file 2, builtin 1). The full rate applies only while the current page shows the plugin, meaning a `{id.…}` var or a `plugin: id` reference. Otherwise the plugin is read at most every 30 s.
- **Overlap:** reads never overlap.
- **Refresh after actions:** each action re-reads the status 150 ms later (`"refresh": false` turns that off).

### Stale and heartbeat

The status is **stale** (a crash, or a tool that stopped answering) when any of these is true:

- there was no successful read for `stale` seconds (default `max(95, 3 × interval)`: 95 s is the SDKs' window, three missed 30 s heartbeats plus slack);
- the document's heartbeat (`updated_at`, `updatedAt` or `heartbeat`: ISO or epoch s/ms) is older than that;
- for a `file` without a heartbeat field, the file's mtime is older than that;
- the document says `"stale": true`;
- the document has a `pid` (and `running` isn't `false`) and that process is gone. The tool runs as the user, so a pid that answers `EPERM` (another user's process that reused the number) counts as gone too, as in the SDKs.

While the status is stale, every value shows its `stale` text, else its `default`, else empty. A crashed tool therefore never shows as busy.

The status is **stopped** (the tool isn't running, cleanly) when:

- the document says `"running": false` (what the SDKs' `stop()` writes): its values show as written, however old the heartbeat, and `{id._state}` is `stopped`, so a clean exit reads differently from a crash. `"stale": true` still wins (that's what `status --json` prints for a dead tool);
- a `file` status doesn't exist: the tool has never run. Values show their `default`; it is not an error.

This is the contract the helper libraries (status file + heartbeat) write.

A failed read sets `error` and keeps the last values until they go stale.

### values → template vars (JSONPath-lite)

`values` maps names (a-z, 0-9, `_`; ≤ 32 values) to paths into the status document:

| path | means |
|---|---|
| `$` | the whole document (or the text line) |
| `$.a.b` | a field (`$.a-b` works too) |
| `$['odd key']` or `$["odd key"]` | a field with any name |
| `$.list[0]`, `$.list[-1]` | an array item |
| `$.list.length` | the length of an array or string |

There are no wildcards, filters or recursive descent.

Each value is either a path string or an object `{ path, default?, stale?, round?, map?, above?, below?, atLeast?, atMost?, equals?, then?, else? }`:

- `round`: decimals for numbers.
- `map`: exact text → shown text (`true`, `false` and numbers count as text, e.g. `{ "true": "on" }`).
- objects and arrays show as compact JSON (≤ 80 characters).
- **tests** turn a value into a lamp: `above` (>), `below` (<), `atLeast` (≥), `atMost` (≤) take numbers (numeric strings count), `equals` takes text, a number or a boolean. With tests the value shows `then` (default `"on"`) when every test holds, else `else` (default `""`), so `{ "path": "$.pct", "atLeast": 80 }` lights `led: "{codexbar.claude_hot}"` from 80 % and `{ "atLeast": 50, "below": 80 }` is a band. Nothing at the path → `default`; stale → `stale`. `map` then applies to the shown text.
- a path may contain a setting, in a bracket: `$['{settings.target}'].lastBuild.status`.

Every key, dial and strip can show these as `{<plugin id>.<value>}`, for example `title: "{codexbar.claude_5h}%"` or `led: "{my-tool.status}"`. A lamp is lit unless the value is empty, `0`, `false`, `off` or `no`.

| var | meaning |
|---|---|
| `{id.<value>}` | each declared value |
| `{id.status}` | with no `values` declared: the text line, or the document's `state` / `status` field |
| `{id._state}` | the lifecycle state (below), so a key can show e.g. `missing` or `stale` |
| `{id.settings.<name>}` | each setting's current value (e.g. a target name as a key label) |

A dial's needle can follow a value: give the dial `"value": "{codexbar.claude_session}"` (any template; a number, a trailing `%` ignored) instead of a `poll`. Such a dial is a read-only readout (turns are ignored unless `"readonly": false`), and `display` still sets its text.

### actions

Keys, dials and the strip call a plugin action with:

```jsonc
{ "type": "plugin", "plugin": "codexbar", "action": "toggle", "args": { "delay": "{value}" } }
```

`args` may only set the names the action lists in `params`. Arg strings are filled from the control's vars (`{value}`, `{delta}`, `{index}`, `{page}`, …) and **this plugin's own** values and settings (`{repobar.r1_owner}`, `{repobar.settings.x}`, `{settings.target}`), never another plugin's: a plugin can't read other plugins' data through its args. So one action serves every slot: `"args": { "repo": "{self.r1_owner}/{self.r1_repo}" }`.

| action | does |
|---|---|
| `{ "cmd": [argv…] }` | Same rules as the status `cmd`. Elements after argv[0] may use `{value} {delta} {index} {page} {x} {<param>} {<id>.<value>} {settings.<name>}`. Each element is one argument: no splitting, no shell. Env: `DECK_VALUE`, `DECK_DELTA`, …, `DECK_PLUGIN`, `DECK_PLUGIN_DIR`, `DECK_BIN`. `toast: true` shows the first line of output on the strip. `timeout`: default 15 s, up to 1800 (30 min); the process group is killed after it. A string `cmd` needs the shell permission and grant. |
| `{ "cmd": [argv…], "detach": true }` | For long jobs (builds): started in its own process group and reported as started at once. Output (stdout + stderr) goes to `~/.deckstudio/plugins-logs/<id>-<action>.log` (0600, rewritten each run, ends with `# exit <code>`). Default timeout 30 min. While it runs, a second press is refused ("still running"); `GET /api/plugins/:id` shows `running`. It survives a DeckStudio restart, not the plugin being switched off. When it ends the status is re-read and, with `toast: true`, the strip says `<title>: started`, then `done` or `failed (exit n)`. |
| `{ "type": "app", "target": "bundle" \| "<bundle id>" }` | Opens the detected app (`open -b`). |
| `{ "type": "url", "url": "…" }` | `https:` always. Another scheme must be declared in `permissions.schemes` and granted. `javascript: data: file: …` never open. Vars are URL-encoded (`/ ? # :` too, so a value can't change the url's shape). `{name\|path}` keeps `/` between segments for a url path (`https://github.com/{repo\|path}/pulls` with `owner/name`); each segment is still encoded, and a value with an empty, `.` or `..` segment is refused. |
| `{ "http": "…", "method": "POST", "body": {…} }` | Same host rules as the http status. Vars are JSON-escaped in the body and URL-encoded in the url. |
| `{ "builtin": { "type": "capture", "mode": "screen" } }` | Built-in plugins only, and only the DeckStudio action types their builtin allows (capture → `capture`, bots → `page`, grokbot → `app`). `args` are merged in. |

- **Logging:** every plugin action goes through the engine's action runner, so it logs ✓/✗ in `deckctl log` like any press, e.g. `plugin my-tool.toggle`.
- **Refusals:** a plugin that is off, missing or invalid refuses with the reason ("plugin X is off: switch it on…", "X isn't installed (brew install …)").
- **Dimmed keys:** a key with `plugin: "<id>"`, or with a plugin action on press, is dimmed with "not installed", "plugin off" or "plugin broken" when it can't work.

### templates → recipes

`templates.keys`, `.dials` and `.pages` map names to a key, dial or page object (`docs/AGENT-GUIDE.md`). Each entry may instead be `{ "title", "what", "template": {…} }`. Each template becomes a recipe with id `plugin-<id>-<name>`, category `plugin · <name>`, `plugin: <id>`, and `pluginEnabled` / `pluginInstalled`. It appears in `GET /api/recipes`, the editor's recipes and `deckctl recipe list`, and applies like any recipe, **but only while the plugin is switched on** (`POST /api/recipes/apply`, the editor and MCP refuse it otherwise).

A template may hold presentation fields (labels, glyphs, colors, `{id.value}` vars, `plugin`, …) and only these actions: `{ "type": "plugin" }` for **this** plugin, `page`, `back`, `none`, or a `multi` of those. Anything that runs code is a validation error: a `poll` or `browse` command, `shell`, `applescript`, `keys`, `hold-keys`, `type`, `http`, `shortcut`, `open`, `app`, another plugin's action, a `multi` holding any of them, and any field starting with `_` (`_press`, `_rotate`: DeckStudio's runtime-only fields, run before `onPress`; they are also dropped from saved profiles). So a template can't smuggle a command onto a key past the plugin's enable switch and grants: everything it does goes through the plugin's own declared, permission-checked actions.

When a template becomes a recipe:

- `{self.x}` becomes `{<id>.x}`, so templates stay portable;
- `{ "type": "plugin" }` without `plugin` gets this plugin's id;
- key and dial templates get `plugin: <id>`, so they dim when the plugin can't work.

Templates are limited to 32 per kind and 64 KB in total.

### settings (what the user can change)

`settings` maps names (a-z, 0-9, `_`; ≤ 32) to `{ type?, default?, title?, description?, secret? }`. `"secret": true` (string settings, no default) is for an API token or the like: its value reaches only the plugin's own commands, urls and env (`{settings.x}`, `$DECK_SETTINGS_X`) as the manifest writes them, never action args (they come from a key, the API or MCP: `{settings.x}` there stays literal for a secret); it is masked as `[secret]` in action and status errors; it is never a `{<id>.settings.x}` var, and `GET /api/plugins` and MCP show only whether it is set. `type` is `string` (default), `number` or `boolean`, and `default` must be of that type. The editor's plugins panel shows them as fields; the user's values live in the profile (`profile.plugins[id].settings`), never in the manifest, so an update keeps them.

Where a setting is used:

- `{settings.<name>}` in the plugin's own argv elements (status, bots and actions, after argv[0]), url / http templates, http bodies, action args (not `secret` ones), a status `file` path and value paths (`$['{settings.target}']`);
- `$DECK_SETTINGS_<NAME>` in the environment (shell strings get them only this way);
- `{<id>.settings.<name>}` on any key, dial or strip, and `{self.settings.<name>}` in templates (e.g. a target name as the label); not for `secret` settings.

Every `{settings.x}` must name a declared setting (an error otherwise). Changing a setting re-reads the status at once. A setting is the user's own text: it is substituted like any other var (one argv element, URL-encoded in urls), never shell-parsed, and never becomes argv[0].

### bots (a plugin as a bots provider)

`bots` takes the same transports as `status` (default interval 15 s for cmd, 3 s for file). It must yield a bots/v1 document (`docs/AGENT-GUIDE.md`, "Bring your own bots"), which DeckStudio files under provider id = plugin id.

- **Visibility:** the bots show while the plugin is enabled.
- **Presses:** non-https schemes open only if the bots document declares them and the user granted them to the plugin. Shell presses need the plugin's `shell` grant.
- **Listing:** `GET /api/bots` lists the provider with `kind: "plugin"`.
- **Failures:** a failed run keeps the last bots, marked stale.
- **Reserved:** no plugin can be `grokbot`.

## Trust and permissions

What a plugin may do is the user's decision, kept in the profile:

```jsonc
"plugins": {
  "codexbar": { "enabled": true, "approved": "<sha256 of the deckstudio.json the user switched on>", "grants": { "shell": false, "schemes": ["codexbar"], "network": [] } },
  "poltergeist": { "enabled": true, "grants": { … }, "settings": { "config": "~/src/app/poltergeist.config.json", "target1": "app" } }
}
```

- **enabled:** built-in and local plugins are on unless `"enabled": false`. User and linked plugins are off until the user switches them on.
- **approved:** switching an installed (`user`) plugin on records the sha256 of its `deckstudio.json`. When the manifest changes (an update, from the editor, `deckctl` or by hand), the plugin reads as off with no grants (`updated: true`, "updated — review changes" in the editor) until the user reviews it and switches it on again. Installing a plugin over an existing one also switches it off, with or without the server running (`deckctl plugin install` edits the profile itself when DeckStudio is down). Linked dev folders are the user's own and don't need re-approval.
- **Effective grants:** declared ∩ granted. A grant for something the manifest doesn't declare does nothing, and `POST /api/plugins/:id/grant` refuses it.
- **Granted only explicitly:**
  - `shell`: shell-string commands, and argv whose program isn't the plugin's own (`$bin`, `detect.bin`, `$dir/…`) or is a shell, interpreter or wrapper;
  - url schemes other than https;
  - network hosts other than loopback.
- **Enabling a plugin means trusting its argv commands to run as you.** The plugin's own program can do anything you can, and so can a script it ships. The permissions above gate the escape hatches (arbitrary shell, other programs, other schemes, the network); they are not a sandbox. Review a plugin's `cmd`s (and the scripts in its folder) before switching it on. `GET /api/plugins` lists them per action, with `blocked` reasons.
- **Out of reach for a manifest:** it can't change the profile, other plugins, the token or other plugins' grants, or read other plugins' values and settings. It also can't add actions to keys by itself: templates become recipes the user applies, and they can only call the plugin's own actions.
- **Sanitizing:** `normalizeProfile` keeps only `{ enabled: boolean, approved?: sha256, grants: { shell: boolean, schemes: string[], network: string[] }, settings?: { name: string | number | boolean } }` per valid plugin id. Settings aren't permissions: they only fill values into what the manifest already declares.

## Lifecycle

`{id._state}` and `state` in the API take one of these values:

| state | meaning |
|---|---|
| `invalid` | manifest errors (or a duplicate id) |
| `detecting` | first detection still running |
| `missing` | not installed (`install` tells the user how) |
| `disabled` | installed but switched off |
| `starting` | on, no status read yet |
| `ok` | fresh status (or no status source) |
| `stopped` | the tool isn't running, cleanly: its status says `running: false` (values as written), or its status file doesn't exist yet (values at their defaults) |
| `error` | the last read failed; values kept until stale |
| `stale` | no fresh status / heartbeat in time, a dead `pid`, or the tool says so: a crash |

Enabling, disabling and grant changes apply without a restart: pollers start and stop, and in-flight processes of a disabled plugin are killed. Installing the tool is noticed within 60 s, or at once with `POST /api/plugins/rescan`.

## HTTP API

Every route needs `x-deck-token` like all of `/api`.

| | |
|---|---|
| `GET /api/plugins` | `{ plugins: [info], dirs }`. info: `id name version author homepage description icon builtin source dir valid errors warnings installed bin app install enabled permissions grants needs state error values updatedAt vars settings[{name,type,default,title,description,value}] status bots actions[{name,title,kind,params,blocked,timeout?,detach?,running?}] templates{keys,dials,pages}` |
| `GET /api/plugins/:id` | info plus the normalized `manifest` |
| `POST /api/plugins/:id/enable` | `{ enabled: true \| false }`: saved in `profile.plugins`; switching on records the manifest's sha256 as `approved` |
| `POST /api/plugins/:id/grant` | `{ shell?, schemes?, network? }`: replaces the grants. Only declared permissions are accepted. |
| `POST /api/plugins/:id/settings` | `{ settings: { name: value \| null } }`: merged into `profile.plugins[id].settings` (`null` → back to the default). Only declared names, each of its type. |
| `POST /api/plugins/:id/action` | `{ action, args?, value? }`: runs it now, logged as `api plugin <id>` |
| `POST /api/plugins/:id/refresh` | re-reads the status now |
| `POST /api/plugins/rescan` | rescans the folders and re-detects |
| `POST /api/plugins/validate` | `{ manifest }` (object or JSON text) → `{ ok, errors, warnings, manifest }`. Nothing is installed. |
| `GET /api/plugins/registry` | the marketplace: entries of the registry (default: this repo's `registry/` folder; `DECKSTUDIO_REGISTRY`: another folder or an https url to `index.json`), each with `verified` (manifest sha256 matches the index), `valid`, `errors`, `installed`, `update`, `conflict`, `tags` |
| `POST /api/plugins/install` | `{ id }` from the registry, or `{ path }` to a local folder → copied into `~/.deckstudio/plugins/<id>` (dir 0700, files 0600, executables 0700). Refused: symlinks, paths outside the registry, files over 2 MB, more than 50 files, a sha256 mismatch, any file that is missing from the index's `files` map, not listed in it, or differs from its sha256, an entry without per-file hashes, an invalid manifest or a different id. It starts switched off; an update switches it off again for review. (`src/plugin-install.mjs`) |
| `POST /api/plugins/uninstall` | `{ id }`: installed (`user`) plugins only; the folder moves to `~/.deckstudio/plugins/.removed/` |
| `GET /plugin-icon/<id>.png\|svg` | the plugin's icon file (no token, like `/logos`; refused when the browser says another site asked: `Sec-Fetch-Site` other than `same-origin` / `none`) |
| `GET /api/recipes` | includes every valid plugin's templates |

## Built-in plugins

| id | what |
|---|---|
| `capture` | Wraps the `capture` action modes (`screen`, `selection`, `window`, `record`, `toolbar`, `folder`, `copy-last`, …, `check`) as plugin actions. Values `{capture.recording}`, `{capture.rec_time}`, `{capture.last}`. Templates: snip and record keys, and timed / recording dials. `src/capture.mjs` stays the implementation. |
| `bots` | Bring-your-own-bots as a plugin. Values `{bots.waiting}`, `{bots.count}`, `{bots.providers}`; a bots page template and a "waiting" key. `/api/bots` is unchanged. |
| `grokbot` | Grok Bot. Detects the app; values `{grokbot.calling}`, `{grokbot.count}`, `{grokbot.available}`; an open action; Grok bots page and key templates. The roster is still read live by the `grokbot` bots provider. |

Older profiles keep working unchanged:

- `{ "type": "capture", … }` and `{ "type": "shell", … }` actions;
- `poll` keys;
- `botProviders`.

Nothing is migrated automatically.

## Registry

Community plugins live in this repo, in [`registry/`](../registry) (see [`registry/README.md`](../registry/README.md)). It is the marketplace's default source, found next to `src/` (not from the working directory), so a clone works offline and `git pull` brings new plugins and updates. `DECKSTUDIO_REGISTRY` points DeckStudio at another registry instead: a folder, or an https url to its `index.json`.

Registry plugins are only offered, never loaded: plugin discovery reads `plugins/<id>/` (built-in), `plugins/local/<id>/` and `~/.deckstudio/plugins/<id>/`, never `registry/plugins/`. A registry plugin runs only after it is installed (copied, hash-checked, into `~/.deckstudio/plugins/<id>`) and then switched on by you, like a plugin from any other registry.

Each plugin is a folder `registry/plugins/<id>/` holding:

- `deckstudio.json`;
- `README.md`;
- `fixtures/` (sample status output plus the values it should show).

`registry/index.json` (`"deckstudio": "registry/v1"`) lists every plugin's `id`, `name`, `version`, `description`, `author`, `homepage`, `icon`, `path`, `tags` and `needs` (`bundle` / `bin` / `brew`), plus the `sha256` of its `deckstudio.json` and `files`: `{ "<path>": "<sha256>" }` for every file in the plugin folder (`.git` and `.DS_Store` aside). DeckStudio installs a plugin only if every file in it is listed and matches; an extra, missing or changed file, or an entry without `files`, is refused. From a URL registry it fetches exactly the listed files, each from under index.json's folder on the same origin (an entry `path` with `..`, a leading `/`, a scheme or another host is refused), and checks each hash. Files from a URL registry are installed without the executable bit.

The registry's scripts import the validator and `PluginHost` from this repo's `src/`, so the registry can't drift from the app. CI runs both (`npm run registry:check`):

- `registry/scripts/build-index.mjs` validates every manifest and regenerates `registry/index.json`, including each plugin's per-file hashes (rerun it after changing any file in a plugin).
- `registry/scripts/check.mjs` runs that validation, then a dry-run of each plugin's fixtures through the validator and through `PluginHost`, with fake programs.

The review checklist ([`registry/README.md`](../registry/README.md#review-checklist)) asks for:

- least privilege;
- argv commands rather than a shell;
- no undeclared network access;
- no third-party branding without permission;
- fixtures that match the real output format.

The registry starts with third-party adapters (CodexBar, RepoBar, Poltergeist) and a `hello` template. Plugins for private tools stay in `plugins/local/`.

## Writing a plugin (for tool authors)

1. **Pick a status contract.** Either a CLI that prints JSON (`mytool status --json`, always exit 0) or a status file the tool rewrites atomically at least every 30 s. Include `updated_at` (and `pid`), so DeckStudio can tell a crashed tool from an idle one, and write `running: false` on a clean exit so it reads `stopped`, not `stale`.
2. **Prefer argv commands.** Use `["$bin", "verb"]` over shell strings, and loopback HTTP over remote. Then the user only has to switch the plugin on.
3. **Keep tokens in the tool.** If a verb must not be triggerable by any web page (URL schemes are), give the CLI a control token the URL handler checks. DeckStudio runs the CLI, so it gets the trusted path for free.
4. **Ship templates** with `{self.<value>}` and `{ "type": "plugin", "action": … }`, so a user gets a working key in one click.
5. **Validate** with `deckctl plugin validate <dir>` (offline), `POST /api/plugins/validate`, or `validateManifest` from `src/plugin-schema.mjs`. `deckctl plugin init <id>` scaffolds a valid plugin; `deckctl plugin link <dir>` develops it in place.
