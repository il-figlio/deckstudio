// Recipes: ready-made keys, dials and pages for everything DeckStudio can do, each with a
// setup prompt you can hand to an agent (Claude Code, Codex, Ante…) to build or adapt it.
// `template` is applied to the selected key / dial, or becomes a new page.
// `ask` lists the fields the editor asks for before applying ({{name}} placeholders).

import { CODEX_ARGV_WARNING, claudeHooksSnippet, codexNotifySnippet, curlStatusSnippet } from './agent-schema.mjs'

export const AGENT_CONTEXT = `You are configuring DeckStudio, a local tool that drives an Elgato Stream Deck+ (8 LCD keys, 4 push-dials, an 800×100 touch strip).
- Server: http://127.0.0.1:7337. Every /api call needs header x-deck-token: $(cat ~/.deckstudio/token).
- CLI: ~/deckstudio/bin/deckctl (status, page, key, dial, strip, toast, log -f, recipe list|show|apply).
- Profile: GET /api/state → .profile; change it with PUT /api/profile (the whole profile). Pages live in profile.pages[id] with keys[8], dials[4], strip.
- Read ~/deckstudio/docs/AGENT-GUIDE.md for the full schema before editing. Test with \`deckctl log -f\` while pressing the key.`

export const RECIPES = [
  // ---------- agents ----------
  {
    id: 'rex-agents-page', category: 'agents', where: 'page', title: 'Agents page',
    what: 'Every agent from every provider (Rex, Claude Code / Codex hooks, any app), most urgent first; press jumps to it. Appears while Rex is in front.',
    needs: ['Rex'],
    template: { name: 'Agents', source: 'rex', apps: ['com.superlogical.rex'], keys: [], dials: [], strip: { mode: 'segments' } },
    prompt: 'Add a DeckStudio page with source "rex" that shows my Rex agents, shown automatically while Rex (com.superlogical.rex) is frontmost. Keep my other pages unchanged.',
  },
  {
    id: 'agents-next-key', category: 'agents', where: 'key', title: 'Next agent that needs me',
    what: 'One key that jumps to the most urgent agent (any provider); its lamp lights while any agent needs you.',
    template: { logo: 'app-rex', title: 'agents', label: '{agents_needs} need you', led: '{agents_needs}', ledColor: '#e5484d', onPress: { type: 'agents-next' }, onLongPress: { type: 'page', page: 'agents' } },
    prompt: 'Put an "agents" key on my home page that runs the agents-next action, shows "{agents_needs} need you", and lights its red lamp while that number isn\'t 0.',
  },
  {
    id: 'claude-code-hooks', category: 'agents', where: 'none', title: 'Claude Code → agents page (hooks)',
    what: 'Claude Code sessions in any terminal show on the agents page: working, "allow?" when a permission waits, done when it stops. Sends only ids, the folder name and the event message.',
    template: null,
    prompt: `Add DeckStudio agent alerting to my Claude Code hooks. Merge this "hooks" block into ~/.claude/settings.json, keeping every hook I already have (append to the existing arrays per event, don't replace them). Replace ~/deckstudio with where DeckStudio lives if it's elsewhere (use an absolute path). Show me the diff before saving.

${claudeHooksSnippet()}

Then run one Claude Code prompt and check GET http://127.0.0.1:7337/api/agents (header x-deck-token: $(cat ~/.deckstudio/token)): a session with provider "claude-code" should be listed. The script is ~/deckstudio/bin/deck-agent-hook (DECK_AGENT_HOOK_DEBUG=1 prints what it sent). See docs/AGENT-GUIDE.md "Agent alerting".`,
  },
  {
    id: 'codex-notify', category: 'agents', where: 'none', title: 'Codex → agents page (notify)',
    what: 'Codex sessions show on the agents page as done when a turn completes (Codex\'s notify program). Single-user Macs only: Codex puts your prompt in the hook\'s command line, visible to other users.',
    template: null,
    prompt: `Add DeckStudio agent alerting to Codex: in ~/.codex/config.toml set this top-level key (above any [table]), with the absolute path to DeckStudio's hook script:

${codexNotifySnippet()}

If notify is already set to something else, don't overwrite it: tell me, so I can choose (Codex allows one notify program). Show me the diff before saving, and tell me this first: ${CODEX_ARGV_WARNING} Then finish one Codex turn and check GET http://127.0.0.1:7337/api/agents (header x-deck-token: $(cat ~/.deckstudio/token)) for a session with provider "codex".`,
  },
  {
    id: 'rex', category: 'agents', where: 'none', title: 'Rex sessions on the agents page',
    what: 'Rex is read live: every agent in a Rex terminal block, press jumps Rex to it. Nothing to set up when Rex is installed.',
    needs: ['Rex'],
    template: null,
    prompt: `Check that DeckStudio sees my Rex agents: GET http://127.0.0.1:7337/api/agents (header x-deck-token: $(cat ~/.deckstudio/token)) and look at providers[0] (id "rex"): installed, available, count. If installed is false but Rex is installed somewhere unusual, set DECKSTUDIO_REX_CLI to the rex CLI's path in the environment DeckStudio starts from (deckctl start) and restart it. If I want Rex off the deck, set profile.agentProviders to include {"id":"rex","enabled":false}. Make sure a page has source "rex" (recipe rex-agents-page).`,
  },
  {
    id: 'agents-json', category: 'agents', where: 'none', title: 'Any agent app → agents page (JSON)',
    what: 'Any agent app or script reports its sessions (agents/v1 JSON, or one status push per change).',
    ask: [{ name: 'app', label: 'agent app' }],
    template: null,
    prompt: `Make "{{app}}" report its agent sessions to DeckStudio's agents page (schema "agents/v1", see docs/AGENT-GUIDE.md "Agent alerting"). Whenever a session's state changes (idle | working | done | needs with needs: permission | question | auth | error | gone), push it, e.g.:

${curlStatusSnippet()}

Use a short provider id for the app, the session's own id, a short name (project), and never send prompts or transcripts. Or write the whole list to ~/.deckstudio/agents/<provider>.json. A new provider starts switched off: tell me to switch it on in DeckStudio's editor (agents page → providers), and to allow its url scheme there if sessions open a deep link.`,
  },
  {
    id: 'claude-hook-toast', category: 'agents', where: 'none', title: 'Claude Code → deck alerts',
    what: 'Claude Code hooks that flash the touch strip when a session needs you or finishes.',
    template: null,
    prompt: 'Set up Claude Code hooks (in ~/.claude/settings.json) so that the Notification hook runs `~/deckstudio/bin/deckctl toast "claude needs you"` and the Stop hook runs `~/deckstudio/bin/deckctl toast "claude finished"`. Don\'t remove existing hooks. Show me the diff before saving.',
  },
  // ---------- bots · bring your own (Grok Bot first, any bot app via JSON) ----------
  {
    id: 'bots-page', category: 'bots · bring your own', where: 'page', title: 'Bots page (every provider)',
    what: 'Every bot from every provider (Grok Bot, JSON files, commands), the ones calling you first; press opens that bot.',
    template: { name: 'Bots', source: 'bots', keys: [], dials: [], strip: { mode: 'segments' } },
    prompt: 'Add a DeckStudio page with source "bots" (bring your own bots). Leave page.providers empty to show every provider, or set it to e.g. ["grokbot", "my-bot-app"]. Use GET /api/bots to see the providers and bots. Keep my other pages unchanged.',
  },
  {
    id: 'grokbots-page', category: 'bots · bring your own', where: 'page', title: 'Grok bots page (curated)',
    what: 'Your chosen Grok bots in fixed slots (the rest stay off the deck); appears while Grok Bot is in front.',
    ask: [{ name: 'bots', label: 'bots, comma separated, in slot order' }],
    template: { name: 'Grok Bots', source: 'bots', providers: ['grokbot'], apps: ['com.anysphere.sand'], bots: '{{bots}}', keys: [], dials: [], strip: { mode: 'segments' } },
    prompt: 'Make a DeckStudio page with source "bots" and providers ["grokbot"] that shows only these Grok bots, in this order: {{bots}} (page field `bots`, an array of names or "grokbot:<id>"). Use GET /api/bots?provider=grokbot to check the names exist.',
  },
  {
    id: 'grokbot-key', category: 'bots · bring your own', where: 'key', title: 'One bot',
    what: 'A key bound to one bot (any provider): its own avatar, unread badge, shakes when it\'s waiting on you; press opens that bot.',
    ask: [{ name: 'bot', label: 'bot: a name, or provider:id' }],
    template: { bot: '{{bot}}' },
    prompt: 'Bind a DeckStudio key to my bot "{{bot}}" (key field `bot`: "provider:id" such as "grokbot:<id>" or "my-bot-app:support"; a bare name still finds a Grok bot). Use GET /api/bots for the exact keys. Choose an empty key on my bots page, or tell me which slot you used.',
  },
  {
    id: 'byob-json', category: 'bots · bring your own', where: 'none', title: 'Bring any bot app (JSON)',
    what: 'Make another bot / agent app show its bots on the deck: it writes one small JSON file (or POSTs it), DeckStudio picks it up within seconds.',
    ask: [{ name: 'app', label: 'bot app' }],
    template: null,
    prompt: `Make my bot app "{{app}}" show its bots on my Stream Deck through DeckStudio's bring-your-own-bots format.
1. Find where {{app}} keeps its list of bots/agents and their status (local files, a CLI, or an API). Read only names, ids, avatar hints and unread/waiting status — no transcripts, no secrets.
2. Produce this JSON (schema "bots/v1"; only id and name are required):
   {"deckstudio":"bots/v1","provider":"<short-id-for-the-app>","name":"{{app}}","app":"<its macOS bundle id, optional>","schemes":["<its deep-link scheme, if bots open one>"],
    "bots":[{"id":"…","name":"…","subtitle":"optional","avatar":{"shape":"blob","color":"violet"} | {"glyph":"<carbon icon>"} | {"emoji":"🤖"} | {"image":"https://… or data:image/png;base64,…"} | {"logo":"<assets/logos name>"},
             "unread":0,"awaiting":false,"hidden":false,"activityAt":"ISO time","open":{"type":"url","url":"<deep link>"} | {"type":"app","target":"<bundle id>"} | {"type":"shell","cmd":"…"}}]}
   shapes: arch bean blob capsule cloud clover crystal cylinder dome egg flower gem heart hex house leaf pebble pumpkin shield sparkle square squircle star tablet teardrop wedge; colors: red orange yellow green cyan blue violet magenta brown gray black white.
3. Deliver it ONE of these ways: write it to ~/.deckstudio/bots/<provider>.json (DeckStudio re-reads that folder every few seconds); or POST it to http://127.0.0.1:7337/api/bots; or add a command provider that prints it (profile.botProviders: [{"type":"command","id":"<provider>","cmd":"…","interval":15}]).
4. Keep status fresh: re-write the file when a bot starts/stops waiting, or POST /api/bots/status {"provider","id","unread","awaiting"}.
5. Check with GET /api/bots — the bots appear under provider "<provider>". A new provider starts switched off and deep links other than https (and shell) are blocked: tell me to switch it on in DeckStudio's editor (bots panel) and allow its scheme there. Then add a page with source "bots".`,
  },
  {
    id: 'byob-command', category: 'bots · bring your own', where: 'none', title: 'Bots from a command',
    what: 'A command (script, CLI) that prints the bots JSON; DeckStudio runs it every few seconds and shows the result.',
    ask: [{ name: 'cmd', label: 'command that prints the JSON' }],
    template: null,
    prompt: 'Add a command bot provider to my DeckStudio profile: profile.botProviders (an array; keep existing entries) gets {"type":"command","id":"<short id>","name":"<app name>","cmd":"{{cmd}}","interval":15}. The command must print bring-your-own-bots JSON ({"bots":[{"id","name",…}]}, see docs/AGENT-GUIDE.md "Bring your own bots"). PUT the whole profile back, then check GET /api/bots for that provider (an error shows in its "error" field).',
  },
  // ---------- apps ----------
  {
    id: 'app-key', category: 'apps', where: 'key', title: 'App launcher',
    what: 'Opens an app (genuine icon), lamp lit while it runs, dimmed when it isn\'t installed.',
    ask: [{ name: 'app', label: 'bundle id (com.…) or app name' }, { name: 'label', label: 'label on the key' }],
    template: { glyph: 'application', label: '{{label}}', onPress: { type: 'app', target: '{{app}}' } },
    prompt: 'Add an app key for {{app}} to my DeckStudio "apps" page. Use POST /api/logos/from-app {bundleId} to pull its real icon and set the key\'s `logo` to the returned name.',
  },
  {
    id: 'codex-key', category: 'apps', where: 'key', title: 'Codex desktop',
    what: 'Codex (the cloud icon) with a running lamp.',
    template: { logo: 'app-codex', label: 'Codex', onPress: { type: 'app', target: 'com.openai.codex' } },
    prompt: 'Add a Codex desktop key (logo "app-codex", app com.openai.codex) to my apps page.',
  },
  {
    id: 'hex-dictation', category: 'apps', where: 'key', title: 'Hold-to-talk dictation (Hex)',
    what: 'Holds your dictation hotkey for as long as the key is held. Needs Accessibility, and Hex installed.',
    ask: [{ name: 'combo', label: 'dictation hotkey (e.g. ropt, fn, ctrl+space)' }],
    needs: ['Hex (anomaly.hex)', 'Accessibility'],
    template: { logo: 'app-hex', title: 'hold to talk', label: 'Hex', app: 'anomaly.hex', onPress: { type: 'hold-keys', combo: '{{combo}}' } },
    prompt: 'Make a push-to-talk key: action `hold-keys` with combo "{{combo}}" (my Hex hotkey), logo app-hex, key field app "anomaly.hex" so it dims if Hex is missing.',
  },
  {
    id: 'app-aware-page', category: 'apps', where: 'page', title: 'Page that follows an app',
    what: 'Any page can take over while an app is in front (like Elgato smart profiles).',
    ask: [{ name: 'app', label: 'bundle id' }, { name: 'name', label: 'page name' }],
    template: { name: '{{name}}', apps: ['{{app}}'], keys: [], dials: [], strip: { mode: 'segments' } },
    prompt: 'Create a DeckStudio page "{{name}}" with `apps: ["{{app}}"]` so it shows while that app is frontmost, then fill it with the 8 most useful shortcuts for that app (use `keys` actions) and Carbon glyphs.',
  },
  // ---------- capture ----------
  // All capture keys use the `capture` action (/usr/sbin/screencapture). Synthetic ⌘⇧3 / ⌘⇧4 keystrokes are unreliable:
  // macOS ignores them from System Events, so the press "works" and nothing is saved.
  {
    id: 'capture-page', category: 'capture', where: 'page', title: 'Screen capture page',
    what: 'Full screen / selection / window to a file or the clipboard, timed shot (dial 1 sets seconds), screen recording toggle (key turns red, press again to stop), ⌘⇧5 toolbar, screenshots folder, copy last path.',
    needs: ['Screen Recording for the app that runs DeckStudio'],
    template: 'capture',
    prompt: 'Add the DeckStudio "capture" recipe page (deckctl recipe apply capture-page). Then press "Full screen" and check `deckctl log -n 5`: it should say "saved Screenshot …". If the strip says "Screen Recording off", follow the capture-permission recipe.',
  },
  {
    id: 'screenshot-clipboard', category: 'capture', where: 'key', title: 'Selection → clipboard',
    what: 'Drag to select; the shot lands on the clipboard. Esc cancels.',
    template: { glyph: 'cut-out', title: 'clipboard', label: 'Selection', onPress: { type: 'capture', mode: 'selection', to: 'clipboard' } },
    prompt: 'Add a key that takes a selection screenshot to the clipboard: { type: "capture", mode: "selection", to: "clipboard" }, glyph cut-out.',
  },
  {
    id: 'record-toggle', category: 'capture', where: 'key', title: 'Record screen (toggle)',
    what: 'Press to start recording the screen, press again to stop; the key turns red and counts while recording. Saves a .mov where screenshots go. Hold opens the ⌘⇧5 toolbar.',
    needs: ['Screen Recording for the app that runs DeckStudio'],
    template: { glyph: 'recording', title: 'hold: toolbar', label: 'Record', tone: 'black', ledColor: '#e5484d', onPress: { type: 'capture', mode: 'record' }, onLongPress: { type: 'capture', mode: 'toolbar' } },
    prompt: 'Add a screen-recording toggle key: onPress { type: "capture", mode: "record" } (add audio: true to record the microphone, clicks: true to show clicks), onLongPress { type: "capture", mode: "toolbar" }.',
  },
  {
    id: 'capture-permission', category: 'capture', where: 'none', title: 'Fix: Screen Recording permission',
    what: 'Captures need macOS Screen Recording for the app that launched DeckStudio (the terminal or agent app, not node).',
    template: null,
    prompt: `${AGENT_CONTEXT}
Goal: make DeckStudio's capture keys work.
1. Run \`~/deckstudio/bin/deckhelper capture-access\`. It prints {"screen": true|false, "responsible": {"name", "path"}}. "responsible" is the app macOS charges the permission to: whatever started \`deckctl start\` (Terminal, iTerm, Ghostty, an agent app such as "Rex Server"…). Run it from the same app that starts DeckStudio.
2. If "screen" is false, tell the user to open System Settings › Privacy & Security › Screen & System Audio Recording and switch on that app (use + to add it from its "path" if it isn't listed), then quit and reopen it. Don't loop permission prompts. \`deckhelper capture-access request\` asks macOS once, only if the user wants that.
3. Restart DeckStudio from that app: \`deckctl stop; sleep 2; deckctl start\`. Press the Capture page's "Full screen" key and confirm \`deckctl log -n 5\` shows "saved Screenshot …".
Without the permission, screencapture fails with "could not create image from display" and DeckStudio shows "Screen Recording off: allow <app>" on the strip.`,
  },
  // ---------- audio / video ----------
  {
    id: 'av-page', category: 'audio & video', where: 'page', title: 'Audio & camera page',
    what: 'Your mics and outputs (press to switch), mic mute, camera-in-use lamp; dials cycle devices.',
    template: { name: 'Audio & Video', source: 'audio', keys: [], dials: [{ mode: 'volume', label: 'Volume', glyph: 'volume--up', unit: '%', step: 2, style: 'bar' }, {}, {}, {}], strip: { mode: 'segments' } },
    prompt: 'Add an audio & video page (source "audio") with a volume dial on dial 1.',
  },
  {
    id: 'mic-mute', category: 'audio & video', where: 'key', title: 'Mic mute',
    what: 'Toggles the microphone; title shows live/muted.',
    template: { glyph: 'microphone', title: '{mic}', label: 'Mic', onPress: { type: 'mic-mute' } },
    prompt: 'Add a mic mute key (action mic-mute) whose title shows {mic}.',
  },
  {
    id: 'volume-dial', category: 'audio & video', where: 'dial', title: 'Volume dial',
    what: 'System volume; press mutes.',
    template: { mode: 'volume', label: 'Volume', glyph: 'volume--up', unit: '%', step: 2, style: 'bar' },
    prompt: 'Make dial 1 a system volume dial (mode volume).',
  },
  {
    id: 'output-switch', category: 'audio & video', where: 'key', title: 'Switch output to…',
    what: 'One press sends audio to a specific device.',
    ask: [{ name: 'device', label: 'output device name' }],
    template: { glyph: 'headphones', title: 'output', label: '{{device}}', onPress: { type: 'audio-output', device: '{{device}}' } },
    prompt: 'Add a key that switches audio output to "{{device}}" (action audio-output). GET /api/audio lists device names.',
  },
  // ---------- system / data ----------
  {
    id: 'clock-key', category: 'system', where: 'key', title: 'Clock (LCD)',
    what: 'Time on a gray LCD window.',
    template: { face: 'lcd', title: '{page}', label: '{out}', poll: { cmd: 'date +%H:%M', interval: 10 } },
    prompt: 'Add an LCD clock key (face lcd, poll date +%H:%M every 10 s).',
  },
  {
    id: 'stat-key', category: 'system', where: 'key', title: 'Live number from a command',
    what: 'Any shell command\'s output on an LCD key, refreshed on a timer.',
    ask: [{ name: 'cmd', label: 'command' }, { name: 'title', label: 'title' }],
    template: { face: 'lcd', title: '{{title}}', label: '{out}', poll: { cmd: '{{cmd}}', interval: 5 } },
    prompt: 'Add an LCD key titled "{{title}}" that shows the first line of `{{cmd}}` every 5 seconds.',
  },
  {
    id: 'status-light', category: 'system', where: 'key', title: 'Status light pushed by a script',
    what: 'A key your scripts recolor: `deckctl key 3 --label "build ✓" --bg "#1d5f3a"`.',
    template: { glyph: 'flash', label: 'status' },
    prompt: 'Make key {{key}} on my home page a status light, and write a shell function `deckstatus <ok|fail> <text>` that calls `deckctl key {{key}} --label <text> --bg <green|red>`.',
    ask: [{ name: 'key', label: 'key number (1-8)' }],
  },
  {
    id: 'webhook-key', category: 'system', where: 'key', title: 'Call a webhook',
    what: 'POST to a URL on press.',
    ask: [{ name: 'url', label: 'https url' }],
    template: { glyph: 'api', label: 'webhook', onPress: { type: 'http', url: '{{url}}', method: 'POST' } },
    prompt: 'Add a key that POSTs to {{url}} and shows ✓/✗ (check `deckctl log -f`).',
  },
  {
    id: 'shortcut-key', category: 'system', where: 'key', title: 'Run a macOS Shortcut',
    ask: [{ name: 'name', label: 'Shortcut name' }],
    what: 'Runs any Shortcuts.app shortcut.',
    template: { glyph: 'flash', label: '{{name}}', onPress: { type: 'shortcut', name: '{{name}}' } },
    prompt: 'Add a key that runs my macOS Shortcut "{{name}}".',
  },
  // ---------- looks ----------
  {
    id: 'animated-logo', category: 'looks', where: 'key', title: 'Animated logo',
    what: 'Any logo with motion: flicker, bob, pulse, breathe, shake, spin. Animated GIF uploads play too.',
    template: { logo: 'provider-ante', motion: 'flicker' },
    prompt: 'Give my {{key}} key a `motion` of flicker (or bob/pulse/breathe/shake/spin).',
    ask: [{ name: 'key', label: 'which key' }],
  },
  {
    id: 'pixel-icon', category: 'looks', where: 'none', title: 'Pixel / ASCII / dithered icon',
    what: 'Open the icon studio (top bar → icons), pick any app icon, apply pixelate / dither / ASCII, save as a logo.',
    template: null,
    prompt: 'Using DeckStudio\'s icon studio settings as a guide, generate a 1-bit Atkinson-dithered 256×256 PNG of the {{app}} icon on transparent, save it via POST /api/logos/save {name, dataUrl}, and set it as the logo of the {{app}} key.',
    ask: [{ name: 'app', label: 'app' }],
  },
].map(r => ({ ...r, prompt: `${r.prompt}\n\n---\n${AGENT_CONTEXT}` }))

export function fillTemplate(value, vars) {
  if (typeof value === 'string') {
    const whole = /^\{\{(\w+)\}\}$/.exec(value)
    if (whole && (whole[1] === 'bots' || whole[1] === 'providers')) return String(vars[whole[1]] || '').split(',').map(s => s.trim()).filter(Boolean)
    return value.replace(/\{\{(\w+)\}\}/g, (m, k) => (vars[k] ?? m))
  }
  if (Array.isArray(value)) return value.map(v => fillTemplate(v, vars))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillTemplate(v, vars)]))
  return value
}
