# Security policy

## Reporting a vulnerability

Please report security problems privately, using GitHub's
[private vulnerability reporting](https://docs.github.com/en/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability):
open the repository's **Security** tab and choose **Report a vulnerability**. Please don't file a public issue
for anything exploitable.

Include what you found, the version or commit, and steps to reproduce. This is a volunteer project: expect an
acknowledgement within about a week, and a fix or a clear answer as soon as we can. We'll credit you in the
changelog unless you'd rather we didn't.

Supported versions: the latest release, and `main`.

## Threat model

DeckStudio is a **local, single-user tool**. It drives your Stream Deck+ and can run commands as you, so the
main job of its security design is to keep anything *other than you* from reaching that.

### The local server

- It listens on **127.0.0.1 only** (default port 7337), never on a network interface.
- Every HTTP and WebSocket request needs the **access token**, a random 192-bit value in
  `~/.deckstudio/token` (mode 0600). It is **new on every server start** (written once the server owns the
  port), so a token that leaked once stops working at the next restart; an open editor tab then needs
  `deckctl open` again. The token never goes in a URL: `deckctl open` asks the server for a
  **one-time login code** (128-bit, valid 60 s, single use) and opens `/#c=<code>`; the editor trades it for the
  token (`POST /api/login`, rate-limited, refused without the editor's own `Origin`), keeps it in `sessionStorage`
  and strips the fragment. Browser history never holds a working token. Until it is used, the code is as good as
  the token, so it is never in a process's arguments either (on a Mac with several users, `ps -axww` shows
  everyone's): deckctl passes the link to the browser on `osascript`'s standard input (`open location`), not as
  `open <url>`. `deckctl open --dev` only prints the link: another user could be listening on the Vite port
  (5610) while your dev server isn't, so paste it only while yours is running. The `Origin` check keeps web pages
  out; a local program can forge headers, so it is a second line, not the reason a code stays private. The editor's WebSocket
  sends the token as a `Sec-WebSocket-Protocol` entry, not in the query string. Tokens and codes are compared in
  constant time.
- **Clients check the server before sending the token.** deckctl, the MCP server and the agent hook first call
  `GET /api/hello?nonce=<random>` (no token); the server answers with `HMAC-SHA256(token, nonce + server id)`,
  which only a process that can read the token file can compute. Only on a match does the client send the
  token, so a program that grabs port 7337 while DeckStudio is down never receives it. `~/.deckstudio/server.json`
  (0600) records the running server's id and pid. (A Unix socket would also solve this, but would mean a second
  transport for the browser editor and every client; the hello check keeps plain loopback HTTP.) Hand-written
  `curl` scripts don't do this check: only run them while DeckStudio is running.
- The `Host` header must be `127.0.0.1:<port>` or `localhost:<port>`, and WebSocket `Origin` must match
  too. That blocks DNS-rebinding and cross-site requests from web pages you visit.
- App icons, plugin icons and bot avatars (`/logos`, `/plugin-icon`, `/botavatar`) need no token from the editor's
  own page (`Sec-Fetch-Site: same-origin`); anything else (other sites, a typed URL, a client that sends no such
  header, e.g. another local user's `curl`) needs the token, so nobody can probe which apps or plugins you have.
- Attribution fields (`origin` in a request body, the `x-deck-client` header) are labels any token holder can
  set; nothing security-relevant depends on them.
- The editor is served with a strict Content-Security-Policy (same-origin scripts, no framing, no objects).
- Everything DeckStudio writes lives in `~/.deckstudio` (directory 0700, files 0600).

Anyone who can read your token file, or run code as your macOS user, can already do whatever DeckStudio can.
That is outside the threat model.

### What a profile can run

A profile (your layout, `~/.deckstudio/profile.json`) is **code you trust**: keys and dials can run shell
commands, AppleScript, Shortcuts, HTTP requests and synthesize keystrokes. Treat an imported profile like a
shell script: read it before you import it. The browser demo never runs any of this; it only draws.

### Plugins and bots

- A plugin is a manifest (`deckstudio.json`). DeckStudio **never loads plugin code**. It runs only the commands,
  loopback URLs and files the manifest declares, and only while the plugin is switched on.
- **Enabling a plugin means trusting its argv commands to run as you.** Without the `shell` grant a command's
  program must be the plugin's own (`$bin`, a `detect.bin` entry, or a file shipped in the plugin folder), and
  shells, interpreters and wrappers (`sh`, `python`, `arch`, `awk`, `find`, `caffeinate`, `script`, …) are refused;
  that narrows what a manifest can do, but the plugin's own program can still do anything you can.
- Plugins installed by the user start **off**. Enabling one shows what it asks for; shell-string commands, other
  programs, URL schemes beyond the safe set, and non-loopback network access each need an explicit grant, and
  effective permissions are declared ∩ granted. Switching a plugin on records the SHA-256 of its manifest: an
  update (or any change to it) switches it off, without grants, until you review it again.
- A plugin's templates (ready-made keys) may only use the plugin's own actions and page navigation: never a
  `poll`/`browse` command, shell, AppleScript, keystrokes, http, Shortcuts or open action. They apply only while
  the plugin is on. Action arguments can read only the plugin's own values and settings; `secret` settings
  reach only its own commands and are never shown by the API, template vars or MCP.
- A status file must be in the plugin's folder, `~/.deckstudio`, the app's own Application Support folder, or
  the exact file the manifest names; paths are canonicalized and compared case-insensitively, and credential
  stores (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, Keychains, Mail, Messages, DeckStudio's token…) are
  always off limits.
- The marketplace installer checks **every file** of a plugin (scripts and helpers too, not only the manifest)
  against the SHA-256 the registry index lists for it. It refuses unlisted, missing or changed files, symlinks,
  path traversal, URL-registry paths outside the registry's folder or origin, and oversized or too-many-file
  plugins, and installs owner-only (0700 / 0600). The hashes protect against a registry checkout or mirror being
  tampered with after review; they don't make a reviewed plugin safe.
- Rex integration: DeckStudio runs the Rex CLI only from known install locations (Rex's Application Support
  folder, `/Applications` or `~/Applications/Rex.app` and `Rex Server.app`, Homebrew's `rex`), and only after
  `codesign --verify --strict` passes and the signature's Team ID is Superlogical's (`AG92C3PT77`, override with
  `DECKSTUDIO_REX_TEAM`). Spotlight search is off unless `DECKSTUDIO_REX_SPOTLIGHT=1`, and what it finds must pass
  the same check. `DECKSTUDIO_REX_CLI` / `REX_BIN` are your explicit choice and are used as-is.
- Bring-your-own bots and agents are plain data. A bot's "open" action can be a URL (allowed schemes only), an app
  bundle id, or a shell command, and shell commands stay blocked until you trust that provider.
- Agent-alert hooks (`bin/deck-agent-hook`) talk only to a loopback `DECKSTUDIO_URL`, and send only an event name, a session id and a short title to the
  local server. They never forward prompts, tool inputs or transcripts. Codex, though, hands its notify program
  the whole payload (your last prompt, the agent's reply) as a command-line argument, readable by every user on
  the Mac (`ps -axww`) while the hook runs; DeckStudio can't change that, so the Codex setup says to use it only
  on a single-user Mac.

### MCP server

`bin/deckstudio-mcp` talks to the local server with your token and refuses non-loopback URLs. Agents can edit
keys and dials and push status, but **cannot add or change anything that runs code**: an edit or recipe that adds
or alters a `poll`/`browse` command, a shell, AppleScript, keystroke, typing, http or Shortcuts action, or an
`open` of anything but an https URL (anywhere, including inside `multi` and dial actions) is refused, and the agent
is told to ask you to make that change in the editor. Agents also cannot enable plugins, grant permissions, apply
a switched-off plugin's templates or see plugin settings. This is a **guard rail, not a sandbox**: an agent that
also has a shell can read the token and call the HTTP API directly.

## Out of scope

- Attacks that need local code execution as your user, or read access to `~/.deckstudio`.
- A malicious profile or plugin you chose to import, install and grant permissions to.
- Hosting the demo or the server on a public interface. DeckStudio is not designed for that; don't do it.
