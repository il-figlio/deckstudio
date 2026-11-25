# DeckStudio — guide for agents

DeckStudio drives an Elgato **Stream Deck+**:

- 8 LCD keys of 120×120
- 4 push-dials
- an 800×100 touch strip

Everything about the deck lives in one JSON profile. Change the profile and the deck redraws.

## Talking to it

| | |
|---|---|
| Server | `http://127.0.0.1:7337` |
| Auth | header `x-deck-token: $(cat ~/.deckstudio/token)` on every `/api` call (the token changes on every server start: read the file each time; deckctl, MCP and the hook also verify the server with `GET /api/hello` first) |
| CLI | `~/deckstudio/bin/deckctl` (`status`, `page <id>`, `key N --label …`, `toast "…"`, `log -f`, `recipe list/show/apply`) |
| MCP | `~/deckstudio/bin/deckstudio-mcp` (stdio): the same things as tools (`deck_status`, `deck_flash`, `deck_set_key`, …). Setup and the rules: `docs/MCP.md`. Enabling plugins, granting permissions, switching bot providers on, and adding anything that runs code (shell / AppleScript / keystroke / http / Shortcuts actions, non-https opens, poll / browse commands) stay the user's decisions in the editor: MCP refuses those edits. |
| Read | `GET /api/state` → `{ profile, page, status }` |
| Write | `PUT /api/profile` with the **whole** profile. Read it, change it, put it back, and never drop pages you didn't touch. |
| Test | `deckctl log -f`, then press the key. Every press logs ✓/✗ with the error. |

Temporary status (doesn't save):

```sh
deckctl key 3 --label "build ✓" --bg "#1d5f3a"
deckctl clear
```

## Profile shape

```jsonc
{
  "brightness": 70,
  "startPage": "home",
  "appSwitching": true,                       // follow the frontmost app
  "agents": { "toast": true, "autoSwitch": false },
  "theme": { "style": "spec", "accent": "#7c5cff" },
  "agentProviders": [{ "id": "my-agent-app", "enabled": true }], // optional, see "Agent alerting"
  "botProviders": [{ "type": "command", "id": "my-app", "cmd": "my-app bots --json", "interval": 15 }, { "id": "other-app", "enabled": true }], // optional, see "Bring your own bots"
  "pages": {
    "<id>": {
      "name": "Home",
      "apps": ["com.superlogical.rex"],      // optional: show while that app is in front
      "source": "rex" | "bots" | "audio",  // optional: generated live content ("rex" = the agents page: every agent provider) ("grokbots" = older alias: bots, Grok Bot only)
      "providers": ["grokbot", "my-app"],  // bots pages: which providers (empty/missing = all)
      "bots": ["grokbot:<id>", "Scout"],   // bots pages: pinned bots in slot order ("provider:id"; a bare id or name means a Grok bot)
      "keys":  [ /* 8 key objects */ ],
      "dials": [ /* 4 dial objects */ ],
      "strip": { "mode": "segments" | "full", "text": "…", "onTap": {…}, "onSwipeLeft": {…} }
    }
  }
}
```

## Keys

- **Face:**
  - `face`: `cap` | `lcd` | `screen`
  - `tone`: `paper` | `black` | `key`
- **Text:**
  - `label`, `title` (small caption)
  - `caption` (under an LCD window)
- **Icon, the first one set wins:**
  - `bot`: `"provider:id"` (e.g. `"grokbot:<id>"`, `"my-app:support"`). A bare id or name still finds a Grok bot first, then any bot. The key becomes that bot: avatar, unread badge, press opens it, hold opens its app.
  - `sprite`: `"grokbot/bot-<shape>-face"`, plus `spriteColor` and `spriteMode: blink|loop`.
  - `logo`: a genuine logo or app icon: shipped ones in `assets/logos`, plus this Mac's own in `~/.deckstudio/logos`. `GET /api/logos` lists both; `POST /api/logos/from-app {bundleId}` adds an installed app's real icon and Icon Studio saves `custom-<name>`, both into `~/.deckstudio/logos` (never the repo).
  - `glyph`: any Carbon icon name, or a DeckStudio glyph (`app-*`, `agent-needs`, …). Search with `GET /api/glyphs?q=`.
  - `icon`: an emoji or short text.
  - `image`: a `data:image/png|jpeg|gif|webp;base64,…` (animated GIFs play).
- **Animation:**
  - `motion`: `bob` | `pulse` | `breathe` | `flicker` | `shake` | `spin`
- **Status:**
  - `led`: true, or a template such as `"{agents_needs}"` (lit when that value isn't 0)
  - `ledColor`, `badge`, `progress` (0–1)
- **Behavior:**
  - `onPress`, `onLongPress` (when set, a short press fires on release), `onRelease`
  - `poll: { cmd, interval }`: the first line of the command's output becomes `{out}`
  - `app`: a bundle id the key depends on. The key dims with "not installed" when that app is missing.

## Dials

- `mode`:
  - `value`: `min`, `max`, `step`, `default`, `wrap`, `onChange`
  - `volume`
  - `brightness`
  - `actions`: `onLeft` / `onRight`
- **Segment above the dial:**
  - `label`, `glyph`, `style` (`bar` | `gauge` | `text`)
  - `unit`, `display` (a template)
  - `accent`
- **Touch and press:** `onPress`, `onTouch`, `onLongTouch`
- **Live value:** `poll`; numeric output sets the value. Or `value: "{codexbar.claude_session}"` (any live var, e.g. a plugin value): the needle follows it (a trailing `%` is ignored; non-numeric text shows as text)
- **Read-only:** a `value` dial with a `poll` (or a templated `value`) and nothing using its value (no `onChange`, no press/touch action reading `{value}` or `$DECK_VALUE`) is a live readout, so it's read-only. The first turn of such a dial logs a one-time notice. Turning it never changes the number, on the deck or on the editor's knob (the knob shows "read-only"). `readonly: true` forces this on; `readonly: false` makes the dial adjustable again.
- **Browse:** `browse: { cmd }` gives a read-only dial's turns a job. The command runs once when you start turning, never on a timer, and prints one item per line as `name<TAB>value<TAB>note`. Each click steps through the items. The segment shows the item's name, its value (a number also drives the gauge) and `n/N · note`, then goes back to the live value 5 s after the last turn. Keep the command cheap: `ps`, `df`, `vm_stat`, no disk scans.

The starter `system` page works this way. CPU and Memory turn through the top 8 processes by CPU or memory, and press opens Activity Monitor on that tab (the tab only switches if Activity Monitor isn't already open). Disk turns through the mounted volumes with % used and free space, press opens Storage settings, and tapping its segment opens Disk Utility.

## Actions

Every action is `{ "type": …, …params }`:

| type | params | notes |
|---|---|---|
| `page` / `back` | `page` | |
| `app` | `target` | bundle id, or several comma-separated to try in order |
| `open` | `target` | URL, path, or app name |
| `keys` | `combo` | e.g. `cmd+shift+4` (needs Accessibility). macOS ignores synthesized screenshot shortcuts: use `capture`. |
| `hold-keys` | `combo` | held while the key is held: push-to-talk |
| `type` | `text` | the text goes to osascript as an argument; templated values lose control characters (no newline / tab / escape) |
| `shell` | `cmd`, `toast` | env: `$DECK_VALUE $DECK_DELTA $DECK_X $DECK_PAGE`. A `{value}` in `cmd` is never pasted into the command: it becomes a quoted env reference (`"${DECK_V_0}"`), so it's text in bare, `"double"` and `'single'` quoted spots alike. `{…}` inside backticks or `${…}` is refused. |
| `applescript` | `script` | a `{value}` becomes `(item 1 of argv)` (inside a `"string"`: `" & (item 1 of argv) & "`) and the value is passed as an argument; the script then runs inside `on run argv`, so a templated script can't define handlers or properties |
| `shortcut` | `name`, `input` | macOS Shortcuts |
| `http` | `url`, `method`, `body` | |
| `media` | `command` | `playpause` / `next` / `previous` / `mute` |
| `volume` / `brightness` | `step` | |
| `agents-next` | | jump to the agent that most needs you (Rex: jumps to its block; others: open their app) |
| `mic-mute` | `mode` | `toggle` / `on` / `off` |
| `audio-input` / `audio-output` | `device` | name or uid (`GET /api/audio`) |
| `multi` | `actions` | run in order |
| `capture` | `mode`, `to`, `delay`, `delayDial` | screenshots / screen recording, see below |
| `plugin` | `plugin`, `action`, `args` | a plugin's declared action, e.g. `{ "type": "plugin", "plugin": "capture", "action": "record" }`. See "Plugins". |

### Capture

`{ "type": "capture", "mode": …, "to": "file" | "clipboard", "delay": 5 }` runs `/usr/sbin/screencapture` directly (`src/capture.mjs`).

| mode | does |
|---|---|
| `screen` | whole screen (one file per display). `delay`: seconds, or `"{value}"` on a dial; `delayDial: 1`–`4` takes the seconds from that dial on the key's page (an explicit `delay` wins). `cursor: true` includes the pointer, `sound: true` plays the shutter. Pressing again during the countdown cancels it. |
| `selection` / `window` | interactive crosshair / window picker. Never blocks the server. Esc cancels quietly ("capture cancelled", no error). Pressing again cancels it. |
| `record` | toggle a screen recording (`.mov`). The key turns red and shows the elapsed time; press again to stop and the movie is finalized. Options: `audio: true` (mic), `clicks: true`, `cursor: false`, `maxSeconds` (default 3 h: a recording nobody stops still ends). Recordings never outlive DeckStudio: stopped on exit; one left by a crashed server is stopped and finalized when the next server is up (never one a live server owns). Frames are only written when the screen changes, so a still screen gives a short movie. |
| `toolbar` | the system screenshot / recording toolbar (⌘⇧5) |
| `folder` | open the screenshots folder |
| `copy-last` / `reveal-last` / `open-last` | the last capture's path to the clipboard / show it in Finder / open it |
| `check` | show the Screen Recording state. This is the only mode that may ask macOS for permission (once). |

- **Where files go:** where macOS saves screenshots (`defaults read com.apple.screencapture location`, else `~/Desktop`). They're named like macOS names them ("Screenshot 2026-11-24 at 9.41.18 PM.png", "Screen Recording … .mov") and respect `type`, `name` and `disable-shadow`. `DECKSTUDIO_CAPTURE_DIR` overrides the folder, for tests.
- **Results:** every capture flashes the strip ("saved …", "📋 copied to clipboard", "capture cancelled") and logs a `capture` line in `deckctl log`. A capture that writes nothing (e.g. an unwritable folder: screencapture still exits 0) is a failure, not a cancel; Screen Recording is blamed only when a fresh check says it's off.
- **Permission:** captures need **Screen Recording** for DeckStudio's TCC "responsible" app. That's the app that ran `deckctl start` (Terminal, iTerm, an agent host…), not node. `bin/deckhelper capture-access` prints `{screen, accessibility, responsible:{name,path}}` and never prompts. When access is missing, the key shows "Screen Recording off: allow "<app>"" and System Settings opens once per run. Recipe: `deckctl recipe show capture-permission`.

## Live values for templates

`{recording}` (`on` while recording) `{rec_time}` (`off` or `m:ss`) `{last_capture}` `{agents_needs}` `{agents_review}` `{agents_working}` `{bots_waiting}` (bots waiting on you, every provider) `{bots_calling}` (Grok Bot only) `{mic}` `{camera}` `{front_app}` `{page}` `{out}` (poll output)

Plugins add `{<plugin id>.<value>}` (e.g. `{capture.rec_time}`, `{bots.waiting}`) and `{<plugin id>._state}`. `GET /api/plugins` lists each plugin's `vars`.

## Plugins

A plugin is a macOS tool that joins the deck through one manifest, `deckstudio.json`. The manifest says how to detect the tool, where its status comes from (an argv command, a loopback URL or a file), which values keys can show, which actions keys can run, and which key / dial / page templates it offers (they show up as recipes `plugin-<id>-<name>`). DeckStudio runs only what the manifest declares, while the user has the plugin on, with the permissions the user granted (`profile.plugins`).

- **Spec:** `docs/PLUGINS.md`. Schema: `docs/plugin.schema.json`.
- **Built-in plugins:** `plugins/` (`capture`, `bots`, `grokbot`). This Mac's own go in `plugins/local/` (gitignored), installed ones in `~/.deckstudio/plugins/`.
- **API:** `GET /api/plugins`, `POST /api/plugins/<id>/enable|grant|action|refresh`, `POST /api/plugins/rescan`, `POST /api/plugins/validate`.

## Data sources

- **Agents (every provider):** `GET /api/agents`. See "Agent alerting".
- **Bots (every provider):** `GET /api/bots` (`?provider=<id>` filters) → `{ providers, bots }`. `GET /api/grokbots` is the older Grok-only alias. See below.
- **Running apps:** `GET /api/apps`. Add `?icons=1` to get each app's real icon as a 64px PNG data URL.
- **Audio devices:** `GET /api/audio`

## Agent alerting

The agents page (`source: "rex"`, kept as the id for older profiles), `{agents_needs}` / `{agents_review}` / `{agents_working}`, the `agents-next` action, the strip toast and the auto-switch all read one list: every enabled **agent provider**, merged and sorted by attention (needs you > ready for review > working > idle). Schema and trust: `src/agent-schema.mjs` (pure, shared with the browser demo). Hub: `src/agents.mjs`.

| provider | how | press |
|---|---|---|
| `rex` | built in, read live (`rex events`). The CLI is found via `$DECKSTUDIO_REX_CLI` (an explicit path, never second-guessed), `$REX_BIN`, `~/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS/rex`, `/opt/homebrew/bin/rex`, `/usr/local/bin/rex`, then Spotlight (bundle id `com.superlogical.rex.server`). Not found → the provider reads "not installed", no errors. | jumps Rex to the session's block |
| `claude-code` | Claude Code hooks run `bin/deck-agent-hook claude-code` (below) | brings forward the app the session runs in |
| `codex` | Codex's `notify` program runs `bin/deck-agent-hook codex` (below) | same |
| any other id | `~/.deckstudio/agents/<provider>.json` (re-read every 2 s), `POST /api/agents`, or `POST /api/agents/status` one session at a time | the session's `open` (trusted), else the provider's `app` |

Seen state: a long press (or `POST /api/agents/seen`) marks a session seen. Rex keeps `~/.deckstudio/rex-seen.json`; other providers `~/.deckstudio/agents-seen.json`. A session not updated for a day drops off the deck.

### The document (`agents/v1`)

```jsonc
{
  "deckstudio": "agents/v1",
  "provider": "my-agent-app",            // a-z 0-9 -, up to 32; "rex" is reserved
  "name": "My Agent App",
  "app": "com.example.myagentapp",       // optional bundle id: a press opens it when a session has no `open`
  "schemes": ["myagentapp"],             // url schemes besides https its sessions open (the user still has to allow them)
  "sessions": [
    {
      "id": "build-42",                  // required: A-Z a-z 0-9 . _ : @ -, up to 128
      "name": "web-app",                 // short label (project / session), shown on the key
      "title": "refactor settings page",
      "app": "claude-code",              // claude-code | codex | ante | cursor | gemini | opencode | aider | amp | copilot | grok | custom (anything else → custom)
      "state": "needs",                  // idle | working | done | needs | error
      "needs": "permission",             // with state needs: permission | question | auth
      "message": "allow npm install?",
      "progress": 40,                    // optional 0–100 while working
      "updatedAt": "2026-01-01T12:00:00Z", // ISO or ms; missing → the file's mtime / the time of the push
      "open": { "type": "url", "url": "myagentapp://session/build-42" }  // or { "type": "app", "target": "<bundle id>" }
    }
  ]
}
```

Also accepted: `{ "providers": [doc, …] }`, an array of docs, a bare array of sessions. Aliases: `state` `blocked`/`waiting` → needs, `finished`/`complete` → done, `running`/`busy` → working; `kind` = `needs`; `msg` = `message`.

### Trust (same rules as bring-your-own-bots)

What a press may do is the user's call, in `profile.agentProviders` (the editor's agents page → "agents · providers" sets it; a document's own fields never count):

```jsonc
"agentProviders": [{ "id": "my-agent-app", "enabled": true, "schemes": ["myagentapp"] }, { "id": "rex", "enabled": false }]
```

- **enabled**: `rex`, `claude-code` and `codex` are on unless `"enabled": false`. Any other provider stays off the deck (not listed, not counted, no alerts) until the user switches it on.
- **url**: `https:` always; another scheme only if the document declares it **and** the user allowed it. `javascript: data: file: vbscript: blob: view-source: jar: about:` never.
- **app**: bundle ids only (`open -b`). **No shell**: an agents document can never run a command.
- A blocked press only logs why (✗ in `deckctl log`). `GET /api/agents` reports per session `press` and per provider `enabled`, `schemes`, `allowed`, `blockedSchemes`.

### Ready-made hooks: `bin/deck-agent-hook`

A dependency-free node script. It sends only the session id, the project folder's name, the event's own short message (e.g. "Claude needs your permission to use Bash") and the app the agent runs in (`$__CFBundleIdentifier` / `$TERM_PROGRAM`) — never prompts, transcripts or tool input. It always exits 0, silently, within ~2 s, so it can never block or fail the agent (`DECK_AGENT_HOOK_DEBUG=1` prints what happened). Token: `$DECKSTUDIO_TOKEN`, else `~/.deckstudio/token` (rotated on every server start, so prefer the file); server: `$DECKSTUDIO_URL` (loopback only), else `http://127.0.0.1:${DECKSTUDIO_PORT:-7337}`. It sends the token only after the server answers `GET /api/hello` with the right HMAC. Copied out of the repo, it falls back to `POST /api/agents/hook` with only the fields the mapping reads.

**Claude Code**: merge into `~/.claude/settings.json` (or a project's `.claude/settings.json`); DeckStudio never edits it for you. Use the absolute path; the editor shows the snippet with yours filled in (`deckctl recipe show claude-code-hooks` too).

```json
{
  "hooks": {
    "SessionStart":      [{ "hooks": [{ "type": "command", "command": "~/deckstudio/bin/deck-agent-hook claude-code", "timeout": 5 }] }],
    "UserPromptSubmit":  [{ "hooks": [{ "type": "command", "command": "~/deckstudio/bin/deck-agent-hook claude-code", "timeout": 5 }] }],
    "PermissionRequest": [{ "hooks": [{ "type": "command", "command": "~/deckstudio/bin/deck-agent-hook claude-code", "timeout": 5 }] }],
    "PostToolUse":       [{ "matcher": "*", "hooks": [{ "type": "command", "command": "~/deckstudio/bin/deck-agent-hook claude-code", "timeout": 5 }] }],
    "Notification":      [{ "hooks": [{ "type": "command", "command": "~/deckstudio/bin/deck-agent-hook claude-code", "timeout": 5 }] }],
    "Stop":              [{ "hooks": [{ "type": "command", "command": "~/deckstudio/bin/deck-agent-hook claude-code", "timeout": 5 }] }],
    "StopFailure":       [{ "hooks": [{ "type": "command", "command": "~/deckstudio/bin/deck-agent-hook claude-code", "timeout": 5 }] }],
    "SessionEnd":        [{ "hooks": [{ "type": "command", "command": "~/deckstudio/bin/deck-agent-hook claude-code", "timeout": 5 }] }]
  }
}
```

| hook event (stdin JSON, `hook_event_name`) | → state |
|---|---|
| `SessionStart` | idle |
| `UserPromptSubmit`, `PreToolUse`, `PostToolUse` | working (`PostToolUse` clears "allow?" once you approve; drop it to avoid a hook per tool) |
| `PermissionRequest`; `Notification` with `notification_type` `permission_prompt` | needs · permission |
| `Notification` `elicitation_dialog` / `agent_needs_input`; `auth_storage_failure` | needs · question; needs · auth |
| `Notification` `idle_prompt`; `Stop` | done |
| `StopFailure` | error |
| `SessionEnd` | removed |

The session id is Claude Code's `session_id`; the name is the folder of `cwd`. Other events (`SubagentStop`, …) are ignored.

**Codex**: one top-level line in `~/.codex/config.toml` (above any `[table]`; Codex runs it without a shell, so use the absolute path). Codex appends its JSON payload as the last argument and currently sends only `agent-turn-complete`, so Codex sessions show up as **done** when a turn finishes (`thread-id` = session id, `cwd` folder = name). An `approval-requested` type, if Codex ever sends one, maps to needs · permission.

```toml
notify = ["/Users/<you>/deckstudio/bin/deck-agent-hook", "codex"]
```

> **Shared Mac? Don't use Codex notify.** Codex passes the whole payload, including your last prompt and the agent's reply, as a command-line argument, and every user on the Mac can read other processes' arguments (`ps -axww`) while the hook runs. DeckStudio can't change how Codex calls it (the hook only forwards the event, session id and folder name). On a Mac with other user accounts, leave `notify` unset (Codex sessions in Rex terminal blocks still show up through the `rex` provider).

**Anything else** (a script, another agent CLI): `deck-agent-hook status <provider> <session id> <idle|working|done|needs|error|gone> [message]`.

### Endpoints

| | |
|---|---|
| `GET /api/agents` | `{ available, error, counts: { needs, review, working, idle }, agents: [ { key: "provider:id", provider, id, name, title, app, state, needs?, message, progress, updatedAt, open?, attention, press, … } ], providers: [ { id, name, kind: rex\|hook\|file, enabled, installed?, available?, count, stale?, schemes, allowed, blockedSchemes, error } ], dir, hook }`. Rex rows keep their older fields too (`blockId`, `session`, `msg`, `kind`). |
| `POST /api/agents` | an agents/v1 document → `~/.deckstudio/agents/<provider>.json`. `"merge": true` upserts the listed sessions and keeps the rest. Returns `{ providers: [{ provider, count, enabled }] }`. |
| `POST /api/agents/status` | `{ provider, id, state, needs?, message?, name?, title?, app?, progress?, open? }`: upserts one session (fields left out keep their value). `state: "gone"` removes it. |
| `POST /api/agents/hook` | `{ source: "claude-code" \| "codex", payload, env?: { __CFBundleIdentifier?, TERM_PROGRAM? } }`: the hook mapping, done server-side. |
| `POST /api/agents/seen` | `{ key }`: mark a session seen (a long press). |
| `POST /api/agents/open` | `{ key }`: what a press does (Rex jump, or open its trusted target). |
| `POST /api/agents/remove` | `{ provider, id? }`: drop one session, or move the provider's file to `~/.deckstudio/agents/.removed/`. |

```sh
T=$(cat ~/.deckstudio/token)
curl -s -X POST http://127.0.0.1:7337/api/agents/status -H "x-deck-token: $T" -H 'content-type: application/json' \
  -d '{"provider":"my-agent-app","id":"build-42","name":"web-app","state":"needs","needs":"permission","message":"allow npm install?"}'
```

## Bring your own bots

Bot pages and bot keys work with any bot or agent app. Grok Bot is built in; every other app is a **provider** that hands DeckStudio one JSON document.

| provider | how | notes |
|---|---|---|
| `grokbot` | automatic | Grok Bot's local roster, read live. Opens `grokbot://app/v1/agent?id=<id>`. Can't be pushed or overwritten. |
| file | `~/.deckstudio/bots/<provider>.json` | Re-read every 3 s. Rewrite it whenever status changes (write a temp file and rename; a half-written file keeps its last good version). Not rewritten for a day → **stale**: still listed, but no longer calling you. |
| push | `POST /api/bots` | Writes that file for you (needs the token like every `/api` call). |
| command | `profile.botProviders: [{ "type": "command", "id", "name"?, "cmd", "interval"? }]` | Runs `cmd` (zsh -lc, as you) every `interval` s (min 5, default 15); it prints the JSON (≤ 2 MB, 20 s; the whole process group is killed on timeout). After a failed run the last good bots stay, marked stale. |

Two files (or a file and a command) claiming the same provider id: the command wins, then the first file by name; the others are listed with a "duplicate" error.

### Trust: what a bot may do

A bots document is data from another app, so it can't decide what a press does on this Mac. The user decides, per provider, in `profile.botProviders` (the editor's bots panel sets it; a document's own fields never count):

```jsonc
"botProviders": [
  { "id": "my-app", "enabled": true, "schemes": ["myapp"], "allowShell": false }
]
```

- **enabled**: a new file / pushed provider stays **off the deck** (not on bots pages, not for keys, not in `{bots_waiting}`) until the user switches it on ("switch on" in the editor's provider list; pasting JSON into the editor's import box switches those providers on). Grok Bot and the user's own command providers are on unless `"enabled": false`.
- **url**: `https:` always opens. Any other scheme opens only if the document declares it (`"schemes": ["myapp"]`) **and** the user allowed it (`"schemes": ["myapp"]` in `botProviders`). `javascript: data: file: vbscript: blob: view-source: jar: about:` never. Grok Bot's `grokbot://` is built in.
- **app**: `target` (and the document's `app`) must be a bundle id; it opens with `open -b`.
- **shell**: runs only with `"allowShell": true` for that provider.
- A blocked press does nothing but log why (✗ in `deckctl log`). `GET /api/bots` reports per bot `press` (what a press does, or why it's blocked) and per provider `enabled`, `stale`, `schemes` (declared), `allowed`, `blockedSchemes`, `shell` (bots with a shell action).

The document (`bots/v1`; per bot `id` (a non-empty string) and `name` are required, rows without them are skipped):

```jsonc
{
  "deckstudio": "bots/v1",
  "provider": "my-app",               // a-z 0-9 -, up to 32; "grokbot" is reserved
  "name": "My App",                   // shown in the editor
  "app": "com.example.myapp",         // optional bundle id: holding a bot key opens the app
  "schemes": ["myapp"],               // url schemes besides https its bots open (the user still has to allow them)
  "bots": [
    {
      "id": "support", "name": "Support", "subtitle": "inbox triage",
      "avatar": { "shape": "blob", "color": "violet" },   // or { "glyph": "<carbon icon>" } | { "emoji": "🤖" }
                                                          //  | { "image": "https://… | data:image/png;base64,…" } | { "logo": "<assets/logos name>" }
      "unread": 2,                    // badge
      "awaiting": true,               // waiting on you: red lamp, the key shakes, counts in {bots_waiting}
      "hidden": false,                // off the deck unless pinned
      "activityAt": "2026-01-01T12:00:00Z",                // ISO, ms, or ms as a string: recent first
      "open": { "type": "url", "url": "myapp://bots/support" }  // or { "type": "app", "target": "<bundle id>" } | { "type": "shell", "cmd": "…" } (see Trust)
    }
  ]
}
```

- Shapes: arch bean blob capsule cloud clover crystal cylinder dome egg flower gem heart hex house leaf pebble pumpkin shield sparkle square squircle star tablet teardrop wedge. Colors: red orange yellow green cyan blue violet magenta brown gray black white (or `#rrggbb`).
- Also accepted: `{ "providers": [doc, …] }`, an array of docs, a bare array of bots, and Grok Bot's export `{ "grokbots": 1, "bots": [{ id, name, shape, color, unread, awaiting }] }`.
- No `open`: a press opens the provider's `app`.
- Avatars: `data:` images up to 256 KB inline. `https://` images are fetched by DeckStudio: public addresses only (no loopback / private / link-local, checked on every redirect, ≤ 3), ≤ 1 MB, png / jpeg / gif / webp by content, ≤ 4096 px, shrunk to 144 px; a failed fetch is retried later. Glyph names are exact (`4K`, not `4k`).
- Size: one limit, 2 MB, for a file, a push (`413` if the saved document would be larger) and a command's output.

Endpoints:

| | |
|---|---|
| `GET /api/bots[?provider=id]` | `{ providers: [{ id, name, kind: grokbot\|file\|command, available?, count, error? }], bots: [{ key: "provider:id", id, provider, name, fullName, avatar, unread, awaiting, open, thumb }] }` |
| `POST /api/bots` | a document → writes `~/.deckstudio/bots/<provider>.json`. `"merge": true` merges each listed row over the stored one (a row may be just `{ id, unread }`; fields it leaves out, and the document's name / app / schemes, are kept) and keeps the other bots. Returns `{ providers: [{ provider, count }] }`. A new provider still has to be switched on by the user (see Trust). |
| `POST /api/bots/status` | `{ provider, id, unread?, awaiting?, hidden?, activityAt? }`: a quick status change for one bot of a file provider (unread 0–999, booleans must be `true`/`false`). |
| `POST /api/bots/import` | `{ text }`: the editor's paste box (same as `POST /api/bots`). |
| `POST /api/bots/remove` | `{ provider }`: moves that provider's file to `~/.deckstudio/bots/.removed/` (a file that also holds other providers is rewritten without it). The editor asks first. |
| `GET /api/grokbots` | older alias: Grok Bot's bots only. |

```sh
T=$(cat ~/.deckstudio/token)
curl -s -X POST http://127.0.0.1:7337/api/bots -H "x-deck-token: $T" -H 'content-type: application/json' \
  -d '{"provider":"my-app","name":"My App","bots":[{"id":"support","name":"Support","awaiting":true}]}'
curl -s -X POST http://127.0.0.1:7337/api/bots/status -H "x-deck-token: $T" -H 'content-type: application/json' \
  -d '{"provider":"my-app","id":"support","awaiting":false}'
```

Pages: `source: "bots"` shows every enabled provider (or `providers: [...]`), calling-you first, 7 per page, "more" on key 8; dial 1 counts who's calling and opens the first. Older profiles with `source: "grokbots"` keep working and mean `source: "bots", providers: ["grokbot"]`; the editor offers a one-click switch. Recipes: `deckctl recipe show byob-json` is a ready prompt for wiring up any bot app.

## Recipes

`deckctl recipe list` lists ready-made keys, dials and pages. `deckctl recipe show <id>` prints what a recipe does and its setup prompt. `deckctl recipe apply <id> --key 3 --var name=value` applies one.
