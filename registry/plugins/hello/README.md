# Hello: an example plugin to copy

The smallest useful DeckStudio plugin. Copy this folder when you start a new one.

- **`hello-status`** is a bundled script that prints one JSON document and exits 0. A real plugin would run your tool here instead, e.g. `["$bin", "status", "--json"]`. Include `updated_at`, so DeckStudio can tell a fresh status from a stale one.
- **`values`** pick fields out of that document:
  - `{hello.greeting}`: a plain path;
  - `{hello.minute}`: a number;
  - `{hello.busy}`: a boolean mapped to `busy` or empty, so a lamp can follow it.
- **`actions.say`** runs `hello-say <name>` as argv. There is no shell, and `{name}` is one argument however it's spelled. `toast: true` shows its first output line on the strip.
- **`templates`** add a key (lamp lit on even minutes, press says hello) and a read-only dial. They use `{self.…}` and `{ "type": "plugin" }` without an id, so the templates keep working if you rename the plugin.

It needs no permissions and has no `detect`, so it always counts as installed.

## Try it

```sh
deckctl plugin link ./plugins/hello     # or copy the folder to ~/.deckstudio/plugins/hello
```

Switch it on in the editor's Plugins tab, then add the "Hello key" recipe.

## Make it yours

1. Rename the folder and `id`.
2. Point `status.cmd` at your tool, and set `detect.bin` so DeckStudio can find it (`$bin`).
3. Replace `fixtures/status.json` with real output from your tool. List the values you expect in `fixtures/status.expect.json`.
4. Run `node scripts/check.mjs <id>`.
