// Live integrations: app-aware pages, agent sessions (Rex, hooks, any app: src/agents.mjs), audio devices, push-to-talk.
// Each dynamic page ("source") generates its keys/dials from live state; anything it leaves
// empty falls back to the page's own configured controls.
import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AgentHub } from './agents.mjs'
import { topicGlyph } from './topics.mjs'
import { BotHub } from './bots.mjs'
import { GROK, isWaiting } from './bot-schema.mjs'
import { captureVars, captureDecorate } from './capture.mjs'
import { PluginHost } from './plugins.mjs'
import { referencedPlugins } from './plugin-schema.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const HELPER = path.join(ROOT, 'bin/deckhelper')
const hasHelper = () => fs.existsSync(HELPER)

export function helper(args, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!hasHelper()) return reject(new Error('bin/deckhelper missing — run: npm run build:helper'))
    execFile(HELPER, args, { timeout }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).trim())) : resolve(String(stdout).trim())))
  })
}

// Genuine logos per agent app (assets/logos), with a drawn glyph as the fallback
export const APP_LOGO = { 'claude-code': 'app-claude', claude: 'app-claude', codex: 'app-codex', ante: 'provider-ante', grok: 'app-grokbot', opencode: 'provider-opencode' }
export const APP_GLYPH = { 'claude-code': 'app-claude', claude: 'app-claude', codex: 'app-codex', ante: 'app-ante', grok: 'app-grokbot', opencode: 'terminal' }
// System UI that grabs focus for a moment (notifications, Spotlight, the screenshot UI…) isn't "the app you're in"
const TRANSIENT = new Set(['com.apple.UserNotificationCenter', 'com.apple.notificationcenterui', 'com.apple.dock', 'com.apple.Spotlight',
  'com.apple.controlcenter', 'com.apple.screencaptureui', 'com.apple.loginwindow', 'com.apple.SecurityAgent', 'com.apple.systemuiserver',
  'com.apple.CoreServicesUIAgent', 'com.apple.UserAccountUpdater', 'com.apple.coreautha', 'com.apple.WindowManager'])
const LAMP = { needs: '#e5484d', review: '#22a05a', working: '#f0a020', idle: '#8a8a84' }
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s)

const BOT_OWN = ['bg', 'icon', 'progress', 'tone', 'face', 'border', 'accent', 'onRelease', 'onLongPress']
export class Live {
  constructor(engine) {
    this.e = engine
    // agent alerting: every enabled provider (Rex, Claude Code / Codex hooks, JSON files / pushes), merged by attention
    this.agents = new AgentHub({ cfg: () => this.e.profile?.agentProviders })
    this.rex = this.agents.rex
    this.front = { bundleId: '', name: '' }
    this.autoFrom = null      // page to return to when the app that caused an auto-switch loses focus
    this.autoPage = null
    this.audio = { devices: [], camera: false, ok: false }
    this.selId = null         // selected agent (by its provider:id key, so a reorder never retargets a press)
    this.running = new Set()  // bundle ids of running apps (launcher lamps)
    this.bots = new BotHub()  // bring your own bots: Grok Bot + JSON files/pushes + commands
    this.bots.cfg = () => this.e.profile?.botProviders // what the user enabled / trusts per provider
    this.grok = this.bots.grok
    // plugins (src/plugins.mjs): status → {id.value} vars, { type: 'plugin' } actions; built-in plugins read DeckStudio's own state
    this.plugins = new PluginHost({
      cfg: () => this.e.profile?.plugins,
      onChange: () => this.e.scheduleRender(),
      onBots: (id, entry) => this.bots.setPlugin(id, entry),
      bundles: async ids => JSON.parse(await helper(['installed', ...ids])),
      builtins: {
        capture: () => captureVars(),
        bots: () => { const all = this.bots.all(); return { waiting: all.filter(isWaiting).length, count: all.filter(b => !b.hidden).length, providers: new Set(all.map(b => b.provider)).size } },
        grokbot: () => ({ available: this.grok.available, calling: this.grok.bots.filter(b => !b.hidden && (b.awaiting || b.unread)).length, count: this.grok.bots.filter(b => !b.hidden).length }),
      },
    })
    this.grokOffset = 0
    this.offset = 0           // agent paging
    this.filter = null        // 'needs' | 'review' | 'working' | null
    this.blink = false
  }

  start() {
    this.agents.on('change', () => { this.clampSel(); this.e.scheduleRender(); this.e.emit('agents', this.agentsSummary()) })
    this.agents.on('alert', a => this.onAlert(a))
    this.agents.start()
    this.watchApps()
    this.pollAudio()
    this.audioTimer = setInterval(() => this.pollAudio(), 4000)
    this.pollApps()
    this.appsTimer = setInterval(() => this.pollApps(), 5000)
    this.bots.start(() => this.e.scheduleRender())
    this.bots.setCommands(this.e.profile.botProviders)
    this.plugins.start()
    this.grokTimer = setInterval(() => this.bots.setCommands(this.e.profile.botProviders), 3000) // follow profile edits
    this.blinkTimer = setInterval(() => {
      const want = this.isRexPage() && this.agents.counts().needs > 0
      if (!want) { if (this.blink) { this.blink = false; this.e.scheduleRender() } return }
      this.blink = !this.blink
      this.e.scheduleRender()
    }, 650)
  }
  stop() {
    this.stopped = true
    this.agents.stop()
    this.appProc?.kill()
    clearTimeout(this.appSettle); clearInterval(this.audioTimer); clearInterval(this.blinkTimer); clearInterval(this.appsTimer); clearInterval(this.grokTimer); this.bots.stop(); this.plugins.stop()
    this.keyd?.stdin.end() // the daemon releases anything still held when its stdin closes
  }

  // ---------- push-to-talk: one ordered daemon, so a release can never overtake its press ----------
  hold(combo, down) {
    if (!hasHelper()) return this.e.notify('bin/deckhelper missing — run: npm run build:helper', 'error')
    if (!this.keyd || this.keyd.exitCode !== null || this.keyd.killed) {
      const p = (this.keyd = spawn(HELPER, ['keyd'], { stdio: ['pipe', 'pipe', 'ignore'] }))
      p.stdout.setEncoding('utf8')
      p.stdout.on('data', d => { for (const l of d.split('\n')) if (l.startsWith('error ')) this.e.notify(l.slice(6), 'error') })
      p.on('error', () => { this.keyd = null })
      p.stdin.on('error', () => {})
    }
    this.keyd.stdin.write(`${down ? 'down' : 'up'} ${String(combo).replace(/\s+/g, '')}\n`)
  }

  // ---------- running apps: launcher keys light up while their app runs ----------
  async pollApps() {
    try {
      const list = JSON.parse(await helper(['apps']))
      const next = new Set(list.flatMap(a => [a.bundleId, a.name]).filter(Boolean))
      if ([...next].sort().join() !== [...this.running].sort().join()) { this.running = next; this.e.scheduleRender() }
    } catch {}
  }
  /** Which of these app targets are installed (cached; unknown ones are looked up in the background). */
  installed(targets) {
    this.inst ??= new Map()
    this.instQueue ??= new Set()
    const unknown = targets.filter(t => !this.inst.has(t))
    unknown.forEach(t => this.instQueue.add(t))
    this.flushInstalled()
    if (unknown.length) return null
    return targets.some(t => this.inst.get(t))
  }
  flushInstalled() {
    if (this.instPending || !this.instQueue?.size) return
    const batch = [...this.instQueue]; this.instQueue.clear()
    this.instPending = helper(['installed', ...batch]).then(out => {
      for (const [t, v] of Object.entries(JSON.parse(out))) this.inst.set(t, v)
    }).catch(() => batch.forEach(t => this.inst.set(t, true))).finally(() => {
      this.instPending = null
      this.e.scheduleRender()
      this.flushInstalled() // anything queued meanwhile
    })
  }
  decorate(k) {
    if (!k) return k
    k = captureDecorate(k) // a record key turns red with the elapsed time while recording
    // a key bound to one bot ("provider:id", or an older bare Grok bot id/name): its avatar, name, unread badge; press opens it
    if (k.bot) {
      const b = this.bots.find(k.bot)
      if (!b) return { ...k, label: k.label || String(k.bot), title: 'bot not found', dim: true }
      const own = Object.fromEntries(BOT_OWN.filter(f => k[f] != null).map(f => [f, k[f]])) // the key's own look/overlay fields win over the bot's defaults
      return { ...this.botKey(b), ...(k.label ? { label: k.label } : {}), ...own }
    }
    // plugin keys (`plugin: id`, or a plugin action on press): dimmed while the plugin is missing / off / broken
    const pid = k.plugin || (k.onPress?.type === 'plugin' ? k.onPress.plugin : null)
    if (pid) {
      const r = this.plugins.plugins.get(String(pid))
      const st = r ? this.plugins.state(r) : 'unknown plugin'
      const why = { missing: 'not installed', disabled: 'plugin off', invalid: 'plugin broken', 'unknown plugin': 'no such plugin' }[st]
      if (why) return { ...k, dim: true, title: why, led: false }
    }
    // app keys: lamp = running; dimmed with "not installed" when the app isn't on this Mac
    const appTargets = k.onPress?.type === 'app' ? String(k.onPress.target || '') : k.app ? String(k.app) : ''
    if (!appTargets) return k
    const targets = appTargets.split(',').map(t => t.trim()).filter(Boolean)
    const inst = this.installed(targets)
    if (inst === false) return { ...k, dim: true, title: 'not installed', led: false }
    if (k.led != null) return k
    return { ...k, led: targets.some(t => this.running.has(t)), ledColor: k.ledColor || LAMP.review }
  }

  // ---------- app-aware pages ----------
  watchApps() {
    if (!hasHelper() || this.stopped) return
    const p = (this.appProc = spawn(HELPER, ['watch-apps'], { stdio: ['ignore', 'pipe', 'ignore'] }))
    let buf = ''
    p.stdout.on('data', d => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        try { this.onFrontApp(JSON.parse(line)) } catch {}
      }
    })
    p.on('exit', () => { if (!this.stopped) setTimeout(() => this.watchApps(), 3000) })
  }
  pageForApp(bundleId) {
    const pages = this.e.profile.pages
    return Object.keys(pages).find(id => Array.isArray(pages[id].apps) && pages[id].apps.includes(bundleId)) || null
  }
  onFrontApp(app) {
    if (!app?.bundleId || app.bundleId === this.front.bundleId || TRANSIENT.has(app.bundleId)) return
    this.front = app
    this.e.emit('frontApp', app)
    // apps can flicker through focus (a panel, a notification): act only once focus has settled
    clearTimeout(this.appSettle)
    this.appSettle = setTimeout(() => this.applyFrontApp(app), 250)
  }
  applyFrontApp(app) {
    if (app.bundleId !== this.front.bundleId) return
    this.e.trace({ ev: 'front app', app: app.name || app.bundleId, id: app.bundleId })
    if (this.e.profile.appSwitching === false) return
    const target = this.pageForApp(app.bundleId)
    if (target) {
      if (target === this.e.page) return
      if (!this.autoPage) this.autoFrom = this.e.page // remember where we came from once
      this.autoPage = target
      this.e.switchTo(target)
    } else if (this.autoPage && this.e.page === this.autoPage) {
      // the app we followed lost focus: go back where we were
      const back = this.autoFrom
      this.autoPage = this.autoFrom = null
      if (back && this.e.hasPage(back)) this.e.switchTo(back)
    } else {
      this.autoPage = this.autoFrom = null
    }
  }
  /** profile changed: if which pages claim which apps changed, apply it to the current app now */
  appsChanged(prevPages) {
    const map = pages => JSON.stringify(Object.entries(pages || {}).map(([id, p]) => [id, p.apps || []]))
    if (map(prevPages) === map(this.e.profile.pages)) return
    if (this.front.bundleId) this.applyFrontApp(this.front)
  }
  /** the page's controls decide which plugins poll at full speed */
  pluginFocus(view) { this.plugins.focus(referencedPlugins([view.keys, view.dials, view.strip])) }
  /** a manual page change cancels the pending auto-return */
  manualPage() { this.autoPage = this.autoFrom = null }

  // ---------- agents (every provider; a page with source "rex" shows them) ----------
  agentsSummary() { return this.agents.summary() }
  visibleAgents() { const all = this.agents.list(); return this.filter ? all.filter(a => a.attention === this.filter) : all }
  clampSel() { const list = this.visibleAgents(); if (!list.some(a => a.key === this.selId)) this.selId = list[0]?.key || null }
  get sel() { return Math.max(0, this.visibleAgents().findIndex(a => a.key === this.selId)) }
  onAlert(a) {
    const cfg = this.e.profile.agents || {}
    const where = `${String(a.app || 'agent').replace('-code', '')} · ${a.session || a.name}`
    if (cfg.toast !== false && !this.isRexPage()) this.e.toast(`● ${where} needs you`, 2600)
    if (cfg.autoSwitch) { const id = this.rexPageId(); if (id && id !== this.e.page) this.e.goto(id) }
  }
  rexPageId() { const pages = this.e.profile.pages; return Object.keys(pages).find(id => pages[id].source === 'rex') || null }
  isRexPage() { return this.e.profile.pages[this.e.page]?.source === 'rex' }
  async goAgent(key) {
    const steps = await this.agents.go(key) // throws when it couldn't be shown (Rex not running, a blocked link…); the action log shows why
    this.e.trace({ ev: key.startsWith('rex:') ? 'rex jump' : 'agent open', steps })
    return steps
  }
  async goMostUrgent() {
    const all = this.agents.list()
    const a = all.find(x => x.attention === 'needs') || all.find(x => x.attention === 'review')
    if (!a) return this.e.toast('no agent needs you ✓', 1400)
    return this.goAgent(a.key)
  }

  statusOf(a) {
    if (a.attention === 'needs') {
      const t = a.state === 'error' ? 'error' : a.kind === 'permission' ? 'allow?' : a.kind === 'question' ? 'asks' : a.kind === 'auth' ? 'login' : 'needs'
      return { text: t, color: LAMP.needs, urgent: true, blinkOff: this.blink }
    }
    if (a.attention === 'review') return { text: 'done', color: LAMP.review }
    if (a.attention === 'working') return { text: typeof a.progress === 'number' ? `${a.progress}%` : 'busy', color: LAMP.working, progress: a.progress ?? undefined }
    return { text: 'idle', color: LAMP.idle }
  }
  rexView(pg) {
    const theme = this.e.profile.theme
    const agents = this.visibleAgents()
    const counts = this.agents.counts()
    const provs = this.agents.providers(), rexP = provs[0]
    const keys = new Array(8).fill(null)
    const perPage = 7
    if (this.offset >= agents.length) this.offset = 0
    agents.slice(this.offset, this.offset + perPage).forEach((a, i) => {
      keys[i] = {
        face: 'agent', logo: APP_LOGO[a.app], glyph: APP_GLYPH[a.app] || 'bot',
        topic: topicGlyph(a.title, a.msg) || undefined,
        // a title that is just the app's name says nothing: use what it reports doing instead
        label: (a.title && a.title.toLowerCase() !== a.app.replace('-code', '') ? a.title : a.msg || a.title || a.app), title: a.session, status: this.statusOf(a),
        border: a.key === this.selId ? theme.accent || '#7c5cff' : undefined,
        onPress: a.provider === 'rex'
          ? { type: 'internal', desc: `jump rex → ${a.app} · ${a.session} · ${(a.title || '').slice(0, 30)}`, run: () => { this.selId = a.key; return this.goAgent(a.key) } }
          : { type: 'internal', desc: `${a.provider} → ${a.app} · ${a.session} (${a.press})`, run: () => { this.selId = a.key; return this.goAgent(a.key) } },
        onLongPress: { type: 'internal', desc: `mark seen ${a.app} · ${a.session}`, run: () => { this.agents.markSeen(a.key); this.e.toast('marked seen', 900) } },
      }
    })
    const others = provs.some(p => p.kind !== 'rex' && p.enabled && p.count)
    if (!agents.length && !this.filter && rexP.enabled && rexP.installed && !rexP.available && !others) keys[0] = { face: 'lcd', title: 'rex', label: 'offline', caption: 'not reachable' }
    else if (!agents.length && !this.filter && !others && !(rexP.enabled && rexP.available)) keys[0] = { face: 'lcd', title: 'agents', label: 'none', caption: 'add hooks: editor' }
    else if (!agents.length) keys[0] = { face: 'lcd', title: this.filter || 'agents', label: 'none', caption: this.filter ? 'tap strip to clear' : 'all quiet' }
    keys[7] = agents.length > perPage
      ? { glyph: 'arrow--right', title: `${Math.floor(this.offset / perPage) + 1}/${Math.ceil(agents.length / perPage)}`, label: 'more', tone: 'black',
          onPress: { type: 'internal', desc: 'next page of agents', run: () => { this.offset = this.offset + perPage >= agents.length ? 0 : this.offset + perPage; this.e.scheduleRender() } } }
      : { face: 'lcd', title: 'needs you', label: String(counts.needs), caption: 'go to next', led: counts.needs > 0 && !this.blink, ledColor: LAMP.needs,
          onPress: { type: 'internal', desc: 'jump to the agent needing me', run: () => this.goMostUrgent() } }

    const sel = agents.find(a => a.key === this.selId)
    const tapFilter = f => ({ type: 'internal', run: () => { this.filter = this.filter === f ? null : f; this.offset = 0; this.clampSel(); this.e.scheduleRender() } })
    const countDial = (f, label, glyph, accent) => ({
      label: this.filter === f ? `${label} ◂` : label, glyph, style: 'text', display: String(counts[f]), accent,
      _press: tapFilter(f), onTouch: tapFilter(f),
    })
    const dials = [
      {
        label: sel ? `${sel.app.replace('-code', '')} · ${sel.session}` : 'agent', glyph: !sel || sel.provider === 'rex' ? 'app-rex' : APP_GLYPH[sel.app] || 'bot', style: 'text',
        display: sel ? (sel.title || sel.app).toLowerCase() : '—',
        _rotate: d => {
          const n = agents.length; if (!n) return
          const i = (this.sel + d + n) % n
          this.selId = agents[i].key; this.offset = Math.floor(i / perPage) * perPage; this.e.scheduleRender()
        },
        _press: sel ? { type: 'internal', run: () => this.goAgent(sel.key) } : null,
        onTouch: sel ? { type: 'internal', run: () => this.goAgent(sel.key) } : null,
      },
      countDial('needs', 'needs you', 'agent-needs', LAMP.needs),
      countDial('review', 'done', 'checkmark--outline', LAMP.review),
      countDial('working', 'working', 'renew', LAMP.working),
    ]
    return { keys, dials, strip: { mode: 'segments' } }
  }

  // ---------- audio / camera ----------
  async pollAudio() {
    if (!hasHelper()) return
    try {
      const [list, cam] = await Promise.all([helper(['audio', 'list']), helper(['camera-in-use'])])
      const next = { devices: JSON.parse(list), camera: cam === '1', ok: true }
      if (JSON.stringify(next) !== JSON.stringify(this.audio)) { this.audio = next; this.e.scheduleRender() }
    } catch (err) {
      if (this.audio.ok) { this.audio = { devices: [], camera: false, ok: false, error: err.message }; this.e.scheduleRender() }
    }
  }
  micMuted() { return !!this.audio.devices.find(d => d.defaultInput)?.inputMuted }
  async audioDo(args, msg) {
    try { await helper(args); if (msg) this.e.toast(msg, 1100) } catch (err) { this.e.notify(err.message, 'error') }
    await this.pollAudio()
  }
  setInput(uid) { const d = this.audio.devices.find(x => x.uid === uid || x.name === uid); return this.audioDo(['audio', 'set-input', d?.uid || uid], `🎙 ${d?.name || uid}`) }
  setOutput(uid) { const d = this.audio.devices.find(x => x.uid === uid || x.name === uid); return this.audioDo(['audio', 'set-output', d?.uid || uid], `🔈 ${d?.name || uid}`) }
  toggleMic(mode = 'toggle') { return this.audioDo(['audio', 'mute-input', mode]).then(() => this.e.toast(this.micMuted() ? 'mic muted' : 'mic live', 900)) }
  cycle(kind, dir) {
    const list = this.audio.devices.filter(d => d[kind])
    if (list.length < 2) return this.e.toast(`only one ${kind} device`, 1000)
    const cur = list.findIndex(d => d[kind === 'input' ? 'defaultInput' : 'defaultOutput'])
    const next = list[(cur + dir + list.length) % list.length]
    return kind === 'input' ? this.setInput(next.uid) : this.setOutput(next.uid)
  }

  audioView() {
    const keys = new Array(8).fill(null)
    const ins = this.audio.devices.filter(d => d.input).slice(0, 3)
    const outs = this.audio.devices.filter(d => d.output).slice(0, 3)
    ins.forEach((d, i) => {
      keys[i] = { glyph: 'microphone', title: 'input', label: trunc(d.name.toLowerCase(), 18), led: d.defaultInput, ledColor: LAMP.review,
        onPress: { type: 'internal', run: () => this.setInput(d.uid) } }
    })
    const muted = this.micMuted()
    keys[3] = { glyph: muted ? 'microphone--off' : 'microphone', title: 'mic', label: muted ? 'muted' : 'live', tone: muted ? 'black' : 'paper',
      led: true, ledColor: muted ? LAMP.needs : LAMP.review, onPress: { type: 'internal', run: () => this.toggleMic() } }
    outs.forEach((d, i) => {
      keys[4 + i] = { glyph: /speaker|built/i.test(d.name) ? 'volume--up' : /head|airpod|buds/i.test(d.name) ? 'headphones' : 'screen', title: 'output',
        label: trunc(d.name.toLowerCase(), 18), led: d.defaultOutput, ledColor: LAMP.review,
        onPress: { type: 'internal', run: () => this.setOutput(d.uid) } }
    })
    keys[7] = { glyph: 'camera', title: 'camera', label: this.audio.camera ? 'in use' : 'idle', led: this.audio.camera, ledColor: LAMP.needs, tone: this.audio.camera ? 'black' : 'paper' }
    if (!this.audio.ok) keys[0] = { face: 'lcd', title: 'audio', label: 'n/a', caption: 'helper missing' }
    const curIn = this.audio.devices.find(d => d.defaultInput), curOut = this.audio.devices.find(d => d.defaultOutput)
    const dials = [
      null, // volume etc. comes from the page's own dial 1
      { label: 'mic', glyph: 'mic-switch', style: 'text', display: trunc((curIn?.name || '—').toLowerCase(), 12), _rotate: d => this.cycle('input', d), _press: { type: 'internal', run: () => this.toggleMic() } },
      { label: 'output', glyph: 'volume--up', style: 'text', display: trunc((curOut?.name || '—').toLowerCase(), 12), _rotate: d => this.cycle('output', d) },
      null,
    ]
    return { keys, dials }
  }

  // ---------- shared ----------
  // ---------- bots (bring your own: grok bot, json files, commands) ----------
  botKey(b) {
    const app = b.provider === GROK.id ? GROK.app : this.bots.owners().get(b.provider)?.doc?.app // a bundle id (checked by the schema)
    return { ...this.bots.face(b), onPress: this.bots.openAction(b), ...(app ? { onLongPress: { type: 'app', target: app } } : {}) }
  }
  /** source 'bots' (page.providers filters, empty = all) and the older 'grokbots' (= Grok Bot only). */
  botsView(pg) {
    const providers = pg.source === 'grokbots' ? [GROK.id] : Array.isArray(pg.providers) ? pg.providers : []
    const bots = this.bots.list({ providers, pins: Array.isArray(pg.bots) ? pg.bots : [] })
    const keys = new Array(8).fill(null)
    const per = 7
    if (this.grokOffset >= bots.length) this.grokOffset = 0
    bots.slice(this.grokOffset, this.grokOffset + per).forEach((b, i) => { keys[i] = this.botKey(b) })
    const grokOnly = providers.length === 1 && providers[0] === GROK.id
    if (!bots.length) keys[0] = grokOnly && !this.grok.available ? { face: 'lcd', title: 'grok bot', label: 'n/a', caption: 'roster not found' }
      : { face: 'lcd', title: 'bots', label: 'none', caption: 'add a bot app' }
    const shown = [...new Set(bots.map(b => b.provider))]
    const one = this.bots.provider(providers.length === 1 ? providers[0] : shown.length === 1 ? shown[0] : providers.length ? '' : GROK.id)
    keys[7] = bots.length > per
      ? { glyph: 'arrow--right', title: `${Math.floor(this.grokOffset / per) + 1}/${Math.ceil(bots.length / per)}`, label: 'more', tone: 'black',
          onPress: { type: 'internal', desc: 'next page of bots', run: () => { this.grokOffset = this.grokOffset + per >= bots.length ? 0 : this.grokOffset + per; this.e.scheduleRender() } } }
      : one?.app ? { logo: one.logo, glyph: 'bot', label: one.name.toLowerCase(), onPress: { type: 'app', target: one.app } }
      : null
    const waiting = bots.filter(isWaiting).length
    const first = bots.find(b => b.awaiting) || bots.find(b => b.unread)
    const dials = [
      { label: 'calling you', glyph: 'notification', style: 'text', display: String(waiting), accent: LAMP.needs,
        _press: first ? this.bots.openAction(first) : null, onTouch: first ? this.bots.openAction(first) : null },
      null, null, null,
    ]
    return { keys, dials }
  }

  sourceView(pg) {
    if (pg.source === 'rex') return this.rexView(pg)
    if (pg.source === 'bots' || pg.source === 'grokbots') return this.botsView(pg)
    if (pg.source === 'audio') return this.audioView(pg)
    return null
  }
  vars() {
    const c = this.agents.counts()
    return {
      agents_needs: c.needs, agents_review: c.review, agents_working: c.working,
      mic: this.micMuted() ? 'muted' : 'live', camera: this.audio.camera ? 'on' : 'off',
      front_app: this.front.name || '',
      bots_calling: this.grok.bots.filter(b => !b.hidden && (b.awaiting || b.unread)).length, // Grok Bot only (older profiles)
      bots_waiting: this.bots.all().filter(isWaiting).length, // every provider
      ...captureVars(), // {recording} {rec_time} {last_capture}
      ...this.plugins.vars(), // {id.value} {id.state} per plugin
    }
  }
}
