# RepoBar for DeckStudio

Shows the GitHub repos you pinned in [RepoBar](https://github.com/steipete/RepoBar) on the Stream Deck+. Each repo shows its open pull requests and issues, and a press opens its PRs.

> This is a third-party wrapper. It is not made, endorsed or supported by RepoBar's author. It contains no RepoBar code, icons or branding: the icon is the Carbon `repo--source-code` glyph.

## What it shows

The plugin reads your RepoBar **pinned** repos, sorted by name, up to 6. Slot N is the N-th repo.

| value | meaning | source field |
|---|---|---|
| `{repobar.count}` | how many pinned repos came back (≤ 6) | array length |
| `{repobar.rN_owner}`, `{repobar.rN_repo}` | owner and name of slot N | `owner`, `name` |
| `{repobar.rN_prs}` | open pull requests | `openPulls` |
| `{repobar.rN_issues}` | open issues | `openIssues` |
| `{repobar.rN_ci}` | `failing` while CI fails, else empty. **Stays empty today**: see Caveats. | `ciStatus` (not yet in the output) |

**Actions** (all are `https` links, so they need no permissions):

| action | opens |
|---|---|
| `prs`, `issues`, `ci` | a repo's pull requests, issues or Actions runs: `https://github.com/{repo\|path}/…` with `{ "repo": "owner/name" }` as args. A slot key passes `{ "repo": "{repobar.r1_owner}/{repobar.r1_repo}" }` (args are filled from the plugin's values), so one action serves all six slots. `\|path` keeps the `/` (each part is still URL-encoded); an empty slot (`/`) or a `..` part is refused, so a key never opens a malformed url. |
| `my_prs` | github.com/pulls |
| `open` | RepoBar |

**Templates:**

- **Pinned repo key (slot 1):** the PR count as a badge and a red lamp on failing CI. Press opens its PRs, hold opens its Actions runs. For another slot, change `r1` to `rN` (in the press args too).
- **Any repo key:** set `repo` to `owner/name` in its args.
- **My PRs key.**
- **Pinned repos page:** 6 slot keys, My PRs and RepoBar.

## Setup

1. Install RepoBar: `brew install --cask repobar`.
2. Sign in to RepoBar and pin the repos you want on the deck.
3. Install the CLI: RepoBar → Preferences → Advanced → CLI. If you skip this, the plugin also finds `RepoBar.app/Contents/MacOS/repobarcli` in `/Applications` or `~/Applications`.
4. Install this plugin and switch it on. It needs no shell, no URL schemes and no network access of its own. RepoBar talks to GitHub with its own sign-in and cache.

The plugin runs this every 5 min, with a 45 s timeout:

```
repobar repos --scope pinned --sort repo --limit 6 --json
```

## Data source

From RepoBar's source (`steipete/RepoBar`, branch `main`, read 2026-11-24, version 0.10.5):

- `docs/cli.md`: `repos` with `--scope pinned`, `--sort repo` and `--limit`; `--json` output; fatal errors go to stderr with exit 1.
- `Sources/repobarcli/ReposCommand.swift`: the pinned scope fetches `settings.repoList.pinnedRepositories`, skipping hidden repos, then applies the sort and limit.
- `Sources/repobarcli/CLIOutput.swift`: `RepoOutput` (`fullName, owner, name, repoUrl, openIssues, openPulls, stars, pushedAt, latestRelease, activityDate, activityTitle, activityActor, activityUrl, error`). `renderJSONData` encodes it pretty-printed with sorted keys and Foundation's default date encoding, so dates are seconds since 2001-01-01 and `/` is escaped as `\/`.
- `Sources/repobarcli/VerifyCommands.swift`: `RepoDetailOutput`, the output of `repobar repo <owner/name> --json`, which *does* include `ciStatus` (`passing`, `failing`, `pending` or `unknown`) and `ciRunCount`.

`fixtures/repos-pinned.json` is a sample in that format; its repos are made up.

## Caveats

- **No CI in the list (flagged):** `repos --json` (`RepoOutput`) carries no CI status today; only `repobar repo <owner/name> --json` does. The `rN_ci` values read `$[N].ciStatus`, so the CI lamps work as soon as RepoBar adds that field to `RepoOutput`. Until then they stay dark. The upstream change would add `ciStatus: row.repo.ciStatus.description` there; RepoBar already has the data. Holding a slot key opens the repo's Actions runs either way.
- **github.com only:** links use `https://github.com/…`, so GitHub Enterprise repos link to the wrong host.
- **Few slots:** six slots × 5 values plus the count fills 31 of a plugin's 32 values.
