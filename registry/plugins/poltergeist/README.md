# Poltergeist for DeckStudio

Shows the build state of a [Poltergeist](https://github.com/steipete/poltergeist) project's targets on the Stream Deck+ (ok, building or failed), and builds a target when you press its key.

> This is a third-party wrapper. It is not made, endorsed or supported by Poltergeist's author. It contains no Poltergeist code, icons or branding: the icon is the Carbon `build-tool` glyph.

## Setup

Poltergeist works per project, and its status is keyed by your own target names. Set three things in DeckStudio → plugins → Poltergeist → **settings** (saved in your profile, so a plugin update keeps them):

| setting | default | used in |
|---|---|---|
| `config`: the project's `poltergeist.config.json` (absolute or `~/` path) | `~/Projects/my-app/poltergeist.config.json` | `status.cmd`, `actions.build.cmd` (`{settings.config}`) |
| `target1`: a target name (`poltergeist list` shows them) | `app` | the `t1_*` values (`$['{settings.target1}']…`), the first key / dial's label (`{poltergeist.settings.target1}`) and press args |
| `target2` | `tests` | the `t2_*` values, the second key |

Then:

- Install Poltergeist: `brew install steipete/tap/poltergeist` (standalone), or `npm install --global @steipete/poltergeist` (needs Node 24+ on DeckStudio's PATH).
- Start the daemon in your project: `poltergeist haunt`.
- Install the plugin and switch it on. Changing a setting re-reads the status at once.

It needs no shell, no URL schemes and no network access.

## What it shows

| value | meaning | source field |
|---|---|---|
| `{poltergeist.t1_build}` | `ok`, `building`, `failed` or `idle`; `none` before the first build | `<target>.lastBuild.status` |
| `t1_failed` | `failed` while the last build failed, else empty (drives the lamp) | same |
| `t1_building` | `building` while a build runs, else empty | same |
| `t1_progress` | build progress % (when the builder reports it) | `<target>.lastBuild.progress.percent` |
| `t1_error` | the failed build's error summary | `<target>.lastBuild.errorSummary` |
| `t1_at` | when the last build started | `<target>.lastBuild.timestamp` |
| `t1_daemon` | `watching` while the daemon runs, else `stopped` | `<target>.process.isActive` |
| `paused` | `paused` while auto-builds are paused | `_paused` |

`t2_*` holds the same values for the second target.

**Actions:**

- `build` (param `target`) runs `poltergeist build <target> --config <config>` as argv, never through a shell. It is **detached** (`"detach": true`, timeout 30 min): a long build isn't killed after a minute, the press returns at once, the strip says `started` and then `done` or `failed (exit n)`, and the output goes to `~/.deckstudio/plugins-logs/poltergeist-build.log`. A second press while it builds is refused.
- `open_monitor` opens the Poltergeist monitor app (`me.steipete.poltergeist.monitor`), if you have it.

**Templates:**

- **Target keys:** the target's name (from settings) as the label, its state as the caption and a red lamp after a failed build. Press builds the target.
- **Target dial:** shows the state; press or tap builds.
- **Builds page:** both targets, the paused flag and the monitor app.

Press args are filled from the current vars, so a key's `"args": { "target": "{settings.target1}" }` builds whatever target you set.

The plugin runs this every 5 s, with a 20 s timeout:

```
poltergeist status --json --config <config setting>
```

## Data source

From Poltergeist's source (`steipete/poltergeist`, branch `main`, read 2026-11-24):

- `docs/cli.md`: the daemon and build commands (`haunt`, `build [target]`, `list`) and their JSON modes.
- `src/cli/commands/status.ts`: `status [view]` with `--json` and `-t/--target` prints `JSON.stringify(await poltergeist.getStatus(target))`, and `-c/--config` comes from `src/cli/options.ts`.
- `src/poltergeist.ts` (`getStatus`): adds `_paused` and `_buildQueue`.
- `src/core/status-presenter.ts`: the per-target object (`status, enabled, type, process, lastBuild, appInfo, pendingFiles, buildStats, buildCommand, postBuild`).
- `src/status/types.ts` (`StatusObject`) and `src/types.ts`: `BuildStatus.status` is one of `success`, `failure`, `building`, `idle` or `failed`, and `BuildProgress` is `{ current, total, percent, label, updatedAt }`.
- `src/cli/commands/daemon.ts`: `build [target]` with `-c/--config`, `--json`, `--force` and `--verbose`. It runs the build in the CLI process and exits non-zero when the build fails.
- `apps/mac/Poltergeist.xcodeproj`: the monitor app's bundle id.

`fixtures/status.json` is a sample in that format; its targets and errors are made up.

## Caveats

- **Long builds:** `poltergeist build` builds inside the CLI process. The `build` action is detached with a 30-minute timeout, so builds up to half an hour finish; after that the build's process group is killed. Switching the plugin off stops a running build.
- **The top-level `status` field:** the plugin reads `lastBuild.status`, not `<target>.status`. When the daemon isn't running in the same process, `status-presenter.ts` derives that field from the state file, and it can read `failure` for a daemon that is just old.
- **No heartbeat:** the status JSON has no top-level heartbeat, so staleness is DeckStudio's own: no successful read for 120 s.
