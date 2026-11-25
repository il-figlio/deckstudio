# Hosting the public demo

The demo is a static site: the editor plus an in-browser engine (`editor/src/demo`) that renders with the server's own `src/render-spec.mjs`. It needs no server and reads nothing from the build machine. It is served from the **domain root** (`base: '/'`).

## Two builds

| Command | Output | Use |
|---|---|---|
| `npm run build:demo` | `web/site` | Everything in `assets/`, including local art you haven't committed |
| `npm run build:demo:public` | `web/site` | What you publish: only assets committed to git ship (same output folder; run one or the other) |

`build:demo:public` (sets `DECK_PUBLIC=1`) leaves out every logo and glyph that `git ls-files assets` doesn't list, such as your own app icons and Icon Studio saves (`custom-*`). Outside a git checkout (or with no `git`) it stops with an error rather than ship everything. Keys that pointed at a left-out logo show a neutral glyph instead. Edit the rule in `editor/vite.config.ts` (`local`).

Both builds copy `editor/hosting/*` (`vercel.json`, `_headers`, `netlify.toml`) to the site root.

## Deploy (not done automatically)

```sh
npm run build:demo:public
npx vercel deploy web/site --prod   # or: drag web/site into Netlify / Cloudflare Pages
```

- `vercel.json`: SPA fallback, `application/wasm` and `font/woff2` types, one-year immutable cache for `/assets/*`, one-day cache for icon folders.
- `_headers` is the same for Netlify/Cloudflare Pages; `netlify.toml` adds the SPA redirect.
- Every page gets the same security headers from all three files: a `Content-Security-Policy` (same-origin scripts plus `'wasm-unsafe-eval'`, no objects, no `<base>`, no framing), `X-Frame-Options: DENY`, `Permissions-Policy: hid=(self)`, `nosniff` and `no-referrer`. `npm run test:e2e` serves the demo with `_headers` applied (`test/e2e/static.mjs`) and fails on any CSP violation; `test/unit/hosting.test.mjs` keeps the three files in sync.

## Before publishing

Grep `web/site` for `/Users/`, your username, your own bot names and agent session ids. The demo's bots (Scout, Pixel, Ledger, ...) and agents are made up in `editor/src/demo/fixtures.ts`.
