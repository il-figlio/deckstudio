# CodexBar for DeckStudio

Shows your Claude and Codex usage limits on the Stream Deck+, read from [CodexBar](https://github.com/steipete/CodexBar)'s bundled command-line tool.

> This is a third-party wrapper. It is not made, endorsed or supported by CodexBar's author. It contains no CodexBar code, icons or branding. The plugin icon is the Carbon `meter` glyph. The Claude and Codex keys use the app logos that ship with DeckStudio (`app-claude`, `app-codex`).

## What it shows

| value | meaning | source field |
|---|---|---|
| `{codexbar.claude_session}` / `{codexbar.codex_session}` | 5-hour session window, % used (rounded) | `usage.primary.usedPercent` |
| `{codexbar.claude_week}` / `{codexbar.codex_week}` | weekly window, % used | `usage.secondary.usedPercent` |
| `claude_reset`, `codex_reset`, `claude_week_reset`, `codex_week_reset` | when the window resets (ISO 8601, UTC) | `usage.primary/secondary.resetsAt` |
| `claude_pace`, `codex_pace` | `runs out` when CodexBar projects the session is used up before it resets, else empty | `pace.primary.willLastToReset` |
| `claude_incident`, `codex_incident` | `minor`, `major`, `critical` or `maintenance` while the provider's status page reports an issue, else empty | `status.indicator` |
| `claude_status`, `codex_status` | the status page's description, e.g. `Operational` | `status.description` |
| `claude_cost`, `claude_cost_limit` | Claude extra-usage spend and its limit, when CodexBar reports them | `usage.providerCost.used` / `.limit` |
| `codex_credits` | Codex credits left | `credits.remaining` |
| `claude_error`, `codex_error` | a provider's fetch error, if any | `error.message` |
| `claude_provider`, `codex_provider` | `claude` / `codex`, to confirm the array order (below) | `provider` |
| `claude_hot`, `codex_hot` | `on` at 80 % or more of the 5-hour session, else empty (for lamps) | `usage.primary.usedPercent` ≥ 80 |
| `claude_week_hot`, `codex_week_hot` | `on` at 80 % or more of the week, else empty | `usage.secondary.usedPercent` ≥ 80 |

**Templates:**

- **Keys:** Claude 5 h, Claude week, Codex 5 h and Codex week, each showing its % and opening CodexBar on press. Also an incidents key, a Claude spend key, and an Open CodexBar key.
- **Dials:** read-only gauges for the same four windows; the needle follows the % (`"value": "{codexbar.claude_session}"`).
- **AI limits page:** all of the above on one page.

On the 5-hour keys, the red lamp lights when any of these is true:

- 80 % or more of the session is used (`claude_hot` / `codex_hot`);
- CodexBar projects the session runs out before it resets;
- the provider reports an incident.

The weekly keys light at 80 % of the week or during an incident.

Hold a 5-hour key to open that provider's status page.

## Setup

1. Install CodexBar: `brew install --cask codexbar`.
2. Sign in to Claude and Codex in CodexBar as usual.
3. Install the CLI: CodexBar → Settings → Advanced → Install CLI. If you skip this, the plugin also finds `CodexBar.app/Contents/Helpers/CodexBarCLI` in `/Applications` or `~/Applications`.
4. Install this plugin and switch it on in DeckStudio. It needs no extra permissions: no shell, no URL schemes, and no network access of its own. CodexBar fetches the usage and status pages itself.

The plugin runs this every 120 s, with a 60 s timeout:

```
codexbar usage --provider both --format json --status
```

## Data source

The command and JSON shape come from CodexBar's source (`steipete/CodexBar`, branch `main`, read 2026-11-24, version 0.85.1):

- `docs/cli.md`, sections "Command" and "Sample output (JSON, pretty)": the `usage` command, `--format json`, `--provider both` and `--status`, and the per-provider payload (`provider`, `status`, `usage.primary` / `secondary` with `usedPercent`, `windowMinutes` and `resetsAt`, `pace`, `credits`).
- `Sources/CodexBarCLI/CLIPayloads.swift`: `ProviderPayload` (keys `provider, account, version, source, status, usage, rateWindowLabels, credits, resetCredits, …, error, pace`), `ProviderStatusPayload` (`indicator, description, updatedAt, url`) and `PacePayload`.
- `Sources/CodexBarCLI/CLIUsageCommand.swift`: `printUsageOutput` prints `[ProviderPayload]`, so the output is always a JSON array.
- `Sources/CodexBarCLI/CLIErrorReporting.swift`: `encodeJSON` uses ISO 8601 dates.
- `Sources/CodexBarCore/UsageFetcher.swift`: `RateWindow.encode` and `UsageSnapshot.encode` (`primary`, `secondary` and `tertiary` are always present, possibly `null`), plus `providerCost`.
- `Sources/CodexBarCore/ProviderStatus.swift`: `ProviderStatusIndicator` is one of `none`, `minor`, `major`, `critical`, `maintenance` or `unknown`.
- `Sources/CodexBarCLI/CLIOptions.swift` (`ProviderSelection.both`) and `Sources/CodexBarCore/Providers/ProviderManifest.swift` (`allDescriptors`): `both` means the primary providers in registry order, which is **Codex first, then Claude**. So the values read `$[0]` for Codex and `$[1]` for Claude.

`fixtures/usage-both.json` is a sample in that format; its numbers are made up.

## Caveats

- **Array order:** the values depend on `both` returning `[codex, claude]`. If a future CodexBar changes that order, `claude_provider` and `codex_provider` will show it.
- **Failed providers:** when one provider fails, CodexBar still prints both payloads but exits non-zero (`UsageCommandOutput.exitCode`). DeckStudio treats a non-zero exit as a failed read: the plugin shows `error` and keeps the last values until they go stale (10 min).
- **Thresholds and needles need a current DeckStudio:** the `*_hot` values use value tests (`"atLeast": 80`) and the dials take their needle from `"value": "{codexbar.…}"`. Both arrived in plugin/v1 together with plugin settings; an older DeckStudio ignores the tests (the `*_hot` lamps would then light at any usage) and leaves the needles at zero.
- **`codexbar serve`:** there is an HTTP alternative, `GET http://127.0.0.1:<port>/usage?provider=both` (same array). It isn't used here because the default port is 8080, which often clashes with local model servers.
