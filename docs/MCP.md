# DeckStudio MCP server

`bin/deckstudio-mcp` is an [MCP](https://modelcontextprotocol.io) server (stdio) that lets agents (Claude Code, Codex, Ante, any MCP client) read and drive the Stream Deck+ with tools instead of `curl`.

- **Separate process:** it talks to the running DeckStudio over HTTP (`http://127.0.0.1:7337`) with the token in `~/.deckstudio/token` (new on every server start, read on each call). Before each call it checks the server (`GET /api/hello`: an HMAC of a fresh nonce under the token) and sends the token only to a server that passes. It never touches the device or the profile file directly.
- **DeckStudio must be running.** If it isn't, every tool returns `DeckStudio is not running at … run: ~/deckstudio/bin/deckctl start` (`deck_log_tail` still works: it reads the log file).
- **Implementation:** `src/mcp.mjs`, built on `@modelcontextprotocol/sdk` (pinned). It negotiates the protocol version with the client (2025-11-25 down to 2024-11-05). stdout carries JSON-RPC only; logs go to stderr.

## Add it to a client

The server takes no arguments. Use the absolute path if your client doesn't expand `~`.

**Claude Code**

```sh
claude mcp add deckstudio -- ~/deckstudio/bin/deckstudio-mcp
# for every project: claude mcp add --scope user deckstudio -- ~/deckstudio/bin/deckstudio-mcp
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.deckstudio]
command = "/Users/<you>/deckstudio/bin/deckstudio-mcp"
args = []
```

**Any other MCP client** (Ante, Claude Desktop, Cursor, …): a stdio server.

```json
{
  "mcpServers": {
    "deckstudio": { "command": "/Users/<you>/deckstudio/bin/deckstudio-mcp", "args": [] }
  }
}
```

**Try it:** `npx @modelcontextprotocol/inspector --cli ~/deckstudio/bin/deckstudio-mcp --method tools/list`

### Environment

| var | default | |
|---|---|---|
| `DECKSTUDIO_URL` | `http://127.0.0.1:7337` | Must be loopback (`127.0.0.1`, `localhost`, `[::1]`): the token is never sent anywhere else. |
| `DECKSTUDIO_PORT` | `7337` | Used when `DECKSTUDIO_URL` is unset. |
| `DECKSTUDIO_HOME` | `~/.deckstudio` | Where the token and `actions.log` live. |

## Tools

All key / dial numbers are **1-based** (keys 1–8, dials 1–4), like `deckctl`. `page` defaults to the page on the deck now.

| tool | changes | inputs | does |
|---|---|---|---|
| `deck_status` | nothing | – | Connection, current page, pages, brightness, `agents_needs` / `agents_review` / `agents_working` / `bots_waiting`, plugin states and values, pages with overlays. Call this first. |
| `deck_flash` | temporary | `target` key\|dial\|strip\|toast, `index`, `page`, appearance fields (`label title icon bg fg border accent progress display text value unit style fontSize iconSize`), `ms` | Overlay on a key, dial segment or the strip, or a toast. Never saved. Overlays stay until `deck_clear`. |
| `deck_clear` | temporary | `page`? | Drops overlays (one page, or all). |
| `deck_goto_page` | temporary | `page` | Shows another page. |
| `deck_get_profile` | nothing | `page`?, `full`? | Summary of every page (labels, icons, what each press does), or raw JSON with `full` (data: images shortened; plugin settings and grants left out). |
| `deck_set_key` | **saved** | `key`, `page`?, `set` \| `replace`, `dry_run`? | Read-modify-write of the whole profile; only that key changes. `set` merges (`null` removes a field), `replace` swaps the whole key. Returns a diff and warnings (generated pages, executable parts the user already set). **Refused** if the change adds or alters anything that runs code (see below). Retries if someone else saved in between. |
| `deck_set_dial` | **saved** | `dial`, `page`?, `set` \| `replace`, `dry_run`? | Same for a dial. |
| `deck_recipes_list` | nothing | `id`?, `where`?, `query`? | Ready-made keys / dials / pages (plugin templates included). With `id`: one recipe in full (template, vars, setup prompt). |
| `deck_recipe_apply` | **saved** | `id`, `page`?, `key`\|`dial`, `page_id`, `vars`, `dry_run`? | Applies a recipe to one slot, or adds a page (never overwrites a page). Refused for recipes that run code (e.g. the built-in clock's `poll`) and for templates of a switched-off plugin. |
| `deck_plugins_list` | nothing | `registry`? | Plugins with state, values, actions (and why blocked), permissions vs. grants. `registry: true` adds installable plugins from `GET /api/plugins/registry` when the server has it. |
| `deck_plugin_info` | nothing | `id` | One plugin with its normalized manifest. |
| `deck_plugin_run_action` | runs it | `id`, `action`, `args`?, `value`? | Runs an action of a plugin the user **explicitly switched on** (`profile.plugins[id].enabled: true`). Built-in and local plugins that are only on by default refuse too (e.g. `capture`'s `record` would start a screen + mic recording): the user switches them on in the editor. Off / blocked plugins refuse with the reason. |
| `deck_plugin_enable` | **nothing** | `id`, `reason`? | Doesn't enable anything: returns what the plugin would be allowed to do and the link for the user, `http://127.0.0.1:7337/#plugins`. |
| `deck_log_tail` | nothing | `lines`?, `errors_only`? | Recent action-log lines (✓/✗ per press, turn, tap, action). |
| `deck_bots_push_status` | bots file | `provider`, `id`, `name`?, `provider_name`?, `subtitle`?, `unread`?, `awaiting`?, `hidden`? | Status for a bot of your own provider (`POST /api/bots/status`; creates the bot with `POST /api/bots` merge when `name` is given). Says whether the provider is switched on. |
| `deck_agents_list` | nothing | `all`? | Agents the deck knows (`GET /api/agents`) and their counts. |
| `deck_agent_push_status` | agents file | `provider`, `id`, `state` (idle / working / done / needs / error / gone), `needs`?, `message`?, `name`?, `title`?, `app`?, `progress`? | Status for one session of your own agent provider (`POST /api/agents/status`; fields left out keep their value, `gone` removes the session). Pushes status only (no `open`, schemes or shell). Says whether the provider is switched on. |

Resources: `deckstudio://docs/agent-guide`, `deckstudio://docs/plugins`, `deckstudio://docs/mcp` (these docs, for writing keys and dials).

Tools carry MCP annotations (`readOnlyHint`, `destructiveHint`), so clients that ask before writes can ask for `deck_set_*` / `deck_recipe_apply` only.

## What agents can't do, and why

Some decisions are the user's, made in the editor, and have no tool:

- **Anything that runs code on the Mac.** `deck_set_key`, `deck_set_dial` and `deck_recipe_apply` refuse any change that adds or alters a `poll` or `browse` command, a `shell`, `applescript`, `keys`, `hold-keys`, `type`, `http` or `shortcut` action, or an `open` whose target isn't an https url, anywhere in the control (inside `multi`, dial `onChange` / `onLeft` / …, touch actions), and refuse recipes that contain any of these. A poll runs at once and then on a timer, so one injected edit would otherwise be persistent code execution. The error tells the agent to ask the user to make that change in the editor. Existing executable parts the user set are left alone: an agent may relabel such a key, or remove the action.

- **Switching a plugin on, and granting it shell, url schemes or network.** Enabling a plugin lets its declared commands run as the user; a grant opens the escape hatches (arbitrary shell, other apps' url schemes, remote hosts). If an agent could do this, any text it reads (a web page, an issue, a bots document) could talk it into granting itself a shell. `deck_plugin_enable` therefore changes nothing and returns `needs_user_approval` with the link `http://127.0.0.1:7337/#plugins`; the agent tells the user and waits.
- **Installing / uninstalling plugins.** Same reason: installing brings new commands onto the Mac. Agents can browse the registry (`deck_plugins_list registry: true`).
- **Switching a bot provider on, or allowing its schemes / shell.** `deck_bots_push_status` pushes status only (no `open` action, no schemes); a new provider stays off the deck until the user switches it on in the editor's bots panel.
- **Switching an agent provider on, or allowing its schemes.** `deck_agent_push_status` pushes status only; `claude-code` and `codex` are on by default, any other provider stays off the deck (not listed, not counted, no alerts) until the user switches it on in the editor's agents page → providers. The tool returns `provider_enabled: false` with a note to tell the user.

The HTTP API itself still accepts these calls with the token (the editor uses them). This server simply doesn't expose them (and checks every edit itself: the server can't tell an MCP call from the editor, since attribution headers are spoofable), so an agent using MCP can't get there by accident or by prompt injection. An agent with a shell can still read the token and call the API: the MCP surface is a guard rail, not a sandbox.

Other rules:

- **The token** is read from `~/.deckstudio/token` on each call, sent only to loopback and only after the server proved it knows it (`GET /api/hello`), and never appears in tool descriptions, results or logs.
- **Edits** never drop pages: `deck_set_key` / `deck_set_dial` write back the profile they read with exactly one control changed, and check afterwards that every page is still there. Use `dry_run` first and tell the user what changed.
- **Temporary first:** for build / test / "needs you" status, use `deck_flash` and `deck_clear`, not saved edits.

## Tests

A stdio harness spawns `bin/deckstudio-mcp`, runs `initialize`, `tools/list`, the read-only tools against the live server, `deck_flash` → `deck_clear`, dry-run edits, and checks stdout holds only JSON-RPC frames and that a wrong `DECKSTUDIO_URL` gives the "not running" error. Write paths are tested against a mock server with a temporary `DECKSTUDIO_HOME`.
