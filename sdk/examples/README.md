# DeckStudio SDK examples

| | language | status source | shows |
|---|---|---|---|
| [`pomodoro/`](pomodoro) | Swift (DeckKit) | `file` | `DeckStatus` heartbeat, `DeckCLI` status, `stop()` on SIGTERM, key and dial templates |
| [`ticker/`](ticker) | Node (deckkit) | `cmd` (`ticker.mjs status --json`) | `createStatus`, `statusCli`, a loopback service guarded by `controlToken`, a manifest written by the builder (`make-manifest.mjs`) |
| [`e2e.mjs`](e2e.mjs) | Node | | both examples through DeckStudio's real `PluginHost` in a scratch `HOME` |

```sh
node e2e.mjs                       # KEEP=1 to keep the scratch folder
```

Try one on your deck:

```sh
cd pomodoro && swift build -c release && cp .build/release/pomodoro ~/.local/bin/
deckctl plugin link . && deckctl plugin enable pomodoro
# then add the "Pomodoro (25 min)" key or the "Pomodoro dial" recipe in the editor

cd ../ticker && ./ticker.mjs serve &
deckctl plugin link . && deckctl plugin enable ticker
```

In your own Node tool, import from `@deckstudio/deckkit` instead of the relative `../../ts/deckkit/src/index.js`.
