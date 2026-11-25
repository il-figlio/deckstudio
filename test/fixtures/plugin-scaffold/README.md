# Scratch Plug

A DeckStudio plugin (plugin/v1, see DeckStudio's docs/PLUGINS.md).

- `deckstudio.json`: the manifest (status, values, actions, templates).
- `status.sh`: example status command. Replace it with your tool (`["$bin", "status", "--json"]` plus `detect.bin`).

Try it:

```sh
deckctl plugin validate .
deckctl plugin link .          # ~/.deckstudio/plugins/scratch-plug → this folder (edits are picked up live)
deckctl plugin enable scratch-plug
deckctl plugin info scratch-plug      # values: {scratch-plug.state} {scratch-plug.count}
deckctl plugin run scratch-plug bump by=2
deckctl recipe apply plugin-scratch-plug-counter --key 1
deckctl plugin unlink scratch-plug
```
