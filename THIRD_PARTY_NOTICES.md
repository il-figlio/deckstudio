# Third-party notices

DeckStudio is MIT licensed (see `LICENSE`). It builds on the work below; each keeps its own license.

## Design system and UI

### SPEC-01 — Shu Ding (MIT)
<https://github.com/shuding/spec-01>

The editor's hardware look — keycaps, LCD windows, knobs, the device frame — and the kit components in
`editor/src/components/ui/` (including `hardware/*.css`) are adapted from SPEC-01. The on-device renderer
(`src/render-spec.mjs`) redraws the same SPEC-01 look for the Stream Deck's own screens.

```
MIT License

Copyright (c) 2026 Shu Ding

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### Vercel UI SDK — Vercel, Inc. (Apache-2.0)
<https://github.com/vercel-labs/ui> · npm `@ui-sdk/core`, `@ui-sdk/react`

SPEC-01 is a kit for the Vercel UI SDK; the editor uses `@ui-sdk/react` primitives as an npm dependency
(unmodified). Licensed under the Apache License, Version 2.0:
<https://www.apache.org/licenses/LICENSE-2.0>.

## Icons and type

| Project | Use | License |
|---|---|---|
| [Carbon Design System icons](https://github.com/carbon-design-system/carbon) (`@carbon/icons`, `@carbon/icons-react`) — IBM | key glyphs, editor icons | Apache-2.0 |
| [IBM Plex Mono](https://github.com/IBM/plex) (`@ibm/plex-mono`, `@fontsource/ibm-plex-mono`) — IBM | device and editor type | SIL Open Font License 1.1 |

## Device and rendering

| Project | Use | License |
|---|---|---|
| [`@elgato-stream-deck/node`, `@elgato-stream-deck/webhid`](https://github.com/Julusian/node-elgato-stream-deck) — Julian Waller | USB HID / WebHID device access | MIT |
| [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas) | Skia rendering | MIT |
| [`omggif`](https://github.com/deanm/omggif) | GIF decoding | MIT |
| [`ws`](https://github.com/websockets/ws) | editor WebSocket | MIT |

## Trademarks and app artwork

DeckStudio is an independent, non-commercial open-source project. **It is not affiliated with, endorsed by,
or sponsored by Elgato or Corsair.** "Elgato" and "Stream Deck" are trademarks of Corsair Memory, Inc.;
they are used here only to describe the hardware DeckStudio works with.

App names, icons and logos in `assets/logos/` and the Grok Bot avatar sprites in `assets/grokbot/` belong to
their respective owners (including Anthropic, OpenAI, SpaceXAI (Grok Bot), Superlogical (Rex) and Anomaly (OpenCode, Hex)
projects). They are included only so keys can show the app they launch; no endorsement is implied. If you own
one of these marks and want it removed, open an issue and it will be taken down.

## Plugin registry adapters

The plugins in `registry/plugins/` that wrap third-party apps (CodexBar, RepoBar, Poltergeist) are unofficial
wrappers. Their apps' authors don't make or endorse them, and the plugins contain none of those apps' code, icons or
branding. The plugins are MIT licensed like the rest of DeckStudio, unless their folder says otherwise; the tools
they wrap keep their own licenses and trademarks.
