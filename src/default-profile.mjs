// Starter profile written on first run. Everything here is editable in the web UI.
const CPU = `ps -A -o %cpu | awk -v n=$(sysctl -n hw.ncpu) '{s+=$1} END {printf "%.0f", s/n}'`
const MEM = `memory_pressure | awk '/free percentage/ {gsub("%","",$5); print 100-$5}'`
// % of the data volume's container in use (`df /` is the sealed system snapshot: it always reads ~1%)
const DISK = `df -kP /System/Volumes/Data 2>/dev/null | awk 'NR==2 {printf "%.0f", 100-$4*100/$2}'`
// browse lists for the system page's read-only dials: one "name<TAB>value<TAB>note" line per item, run
// only when you start turning (never polled). ps / df only: cheap, no disk scans.
const TOP_CPU = `ps -Acr -o pcpu=,pid=,comm= | head -8 | awk '{c=$1; p=$2; $1=$2=""; sub(/^ +/,""); printf "%s\\t%.0f\\tpid %s\\n", $0, c, p}'`
const TOP_MEM = `ps -Acm -o pmem=,rss=,pid=,comm= | head -8 | awk '{m=$1; r=$2; p=$3; $1=$2=$3=""; sub(/^ +/,""); printf "%s\\t%.1f\\t%s · pid %s\\n", $0, m, (r>=1048576 ? sprintf("%.1f gb", r/1048576) : sprintf("%.0f mb", r/1024)), p}'`
// (mounted disk images, e.g. installer .dmgs, are left out: their whole-disk nodes from `hdiutil info`, ~20 ms)
const VOLUMES = `b=Macintosh\\ HD; for v in /Volumes/*(N); do [[ $(readlink "$v") = / ]] && b=\${v:t}; done; dmg=" $(hdiutil info 2>/dev/null | awk '/^\\/dev\\/disk[0-9]+[[:space:]]/ {printf "%s ", $1}')"; df -kPl | awk -v b="$b" -v dmg="$dmg" 'function h(k){return k>=1073741824 ? sprintf("%.1f tb", k/1073741824) : k>=1048576 ? sprintf("%.0f gb", k/1048576) : sprintf("%.0f mb", k/1024)} NR>1 {d=$1; sub(/s[0-9].*$/,"",d); if (index(dmg, " " d " ")) next; mp=$0; sub(/^([^ ]+ +){5}/,"",mp); if (mp=="/System/Volumes/Data") n=b; else if (mp ~ /^\\/Volumes\\//) n=substr(mp,10); else next; line=sprintf("%s\\t%.0f\\t%s free", n, 100-$4*100/$2, h($4)); if (n==b) first=line; else rest=rest line "\\n"} END {if (first) print first; printf "%s", rest}'`
const ACTIVITY = tab => `defaults write com.apple.ActivityMonitor SelectedTab -int ${tab}; open -a 'Activity Monitor'` // 0 cpu · 1 memory (tab sticks when it isn't already open)

export const defaultProfile = () => ({
  version: 1,
  brightness: 70,
  startPage: 'home',
  appSwitching: true,                       // pages with `apps` take over while those apps are in front
  agents: { toast: true, autoSwitch: false }, // Rex agents that need you: flash on the strip / jump to the agents page
  // style 'spec' = the SPEC-01 hardware look (keycaps, gray lcd strip); 'classic' = dark tiles
  theme: { style: 'spec', font: 'Helvetica Neue', fg: '#ffffff', keyBg: '#16161c', stripBg: '#0d0d12', accent: '#7c5cff' },
  pages: {
    home: {
      name: 'Home',
      keys: [
        { face: 'lcd', title: '{page}', label: '{out}', poll: { cmd: 'date +%H:%M', interval: 10 } },
        { logo: 'app-rex', title: 'agents', label: '{agents_needs} need you', led: '{agents_needs}', ledColor: '#e5484d',
          onPress: { type: 'agents-next' }, onLongPress: { type: 'page', page: 'agents' } },
        { glyph: 'apps', label: 'Apps', onPress: { type: 'page', page: 'apps' } },
        { glyph: 'crop', label: 'Snip', onPress: { type: 'capture', mode: 'selection' }, onLongPress: { type: 'capture', mode: 'selection', to: 'clipboard' } },
        { glyph: 'play--filled--alt', label: 'Play', onPress: { type: 'media', command: 'playpause' }, onLongPress: { type: 'media', command: 'next' } },
        { glyph: 'dashboard', label: 'System', tone: 'black', onPress: { type: 'page', page: 'system' } },
        { glyph: 'microphone', label: 'Audio', tone: 'black', title: '{mic}', led: true, ledColor: '#22a05a',
          onPress: { type: 'page', page: 'av' }, onLongPress: { type: 'mic-mute' } },
        { glyph: 'locked', label: 'Lock', tone: 'key', onLongPress: { type: 'keys', combo: 'ctrl+cmd+q' }, title: 'hold' },
      ],
      dials: [
        { mode: 'volume', label: 'Volume', glyph: 'volume--up', unit: '%', step: 2, style: 'bar' },
        { mode: 'brightness', label: 'Deck', glyph: 'light', unit: '%', step: 5, style: 'bar', accent: '#e8590c' },
        { mode: 'value', label: 'CPU', glyph: 'chip', unit: '%', style: 'gauge', poll: { cmd: CPU, interval: 3 }, accent: '#22a05a' },
        { mode: 'value', label: 'Counter', glyph: 'hashtag', min: 0, max: 50, step: 1, default: 0, style: 'bar', accent: '#7c5cff',
          onTouch: { type: 'shell', cmd: 'echo "counter at $DECK_VALUE"', toast: true } },
      ],
      strip: { mode: 'segments' },
    },
    system: {
      name: 'System',
      keys: [
        { glyph: 'arrow--left', label: 'Back', tone: 'black', onPress: { type: 'back' } },
        { face: 'lcd', title: 'cpu', label: '{out}%', caption: 'load', poll: { cmd: CPU, interval: 3 } },
        { face: 'lcd', title: 'mem', label: '{out}%', caption: 'pressure', poll: { cmd: MEM, interval: 5 } },
        { face: 'lcd', title: 'disk', label: '{out}%', caption: 'used', poll: { cmd: DISK, interval: 60 } },
        { glyph: 'activity', label: 'Activity', onPress: { type: 'open', target: 'Activity Monitor' } },
        { glyph: 'asleep', label: 'Display off', onLongPress: { type: 'shell', cmd: 'pmset displaysleepnow' }, title: 'hold' },
        { glyph: 'clean', label: 'Clear', onPress: { type: 'shell', cmd: 'echo ok' } },
        { glyph: 'home', label: 'Home', tone: 'black', onPress: { type: 'page', page: 'home' } },
      ],
      dials: [
        // live readouts: read-only (poll, no onChange). Turning steps through the top processes / volumes.
        { mode: 'value', label: 'CPU', glyph: 'chip', unit: '%', style: 'gauge', poll: { cmd: CPU, interval: 2 }, accent: '#22a05a',
          browse: { cmd: TOP_CPU }, onPress: { type: 'shell', cmd: ACTIVITY(0) } },
        { mode: 'value', label: 'Memory', glyph: 'data--base', unit: '%', style: 'gauge', poll: { cmd: MEM, interval: 4 }, accent: '#2f5fe6',
          browse: { cmd: TOP_MEM }, onPress: { type: 'shell', cmd: ACTIVITY(1) } },
        { mode: 'value', label: 'Disk', glyph: 'save', unit: '%', style: 'gauge', poll: { cmd: DISK, interval: 60 }, accent: '#e8590c',
          browse: { cmd: VOLUMES }, onPress: { type: 'open', target: 'x-apple.systempreferences:com.apple.settings.Storage' },
          onTouch: { type: 'open', target: 'Disk Utility' } },
        { mode: 'volume', label: 'Volume', glyph: 'volume--up', unit: '%', style: 'bar' },
      ],
      strip: { mode: 'segments' },
    },
    // Every agent running in Rex, most urgent first. Shown automatically while Rex is in front.
    agents: {
      name: 'Agents',
      source: 'rex',
      apps: ['com.superlogical.rex'],
      keys: [], dials: [], strip: { mode: 'segments' },
    },
    apps: {
      name: 'Apps',
      keys: [
        // genuine app icons (assets/logos); the lamp is lit while the app is running
        { logo: 'app-claude', label: 'Claude', onPress: { type: 'app', target: 'com.anthropic.claudefordesktop' } },
        { logo: 'app-codex', label: 'Codex', onPress: { type: 'app', target: 'com.openai.codex' } },
        { logo: 'app-rex', label: 'Rex', onPress: { type: 'app', target: 'com.superlogical.rex' }, onLongPress: { type: 'page', page: 'agents' } },
        { logo: 'app-grokbot', label: 'Grok Bot', onPress: { type: 'app', target: 'com.anysphere.sand' } },
        { logo: 'app-hex', title: 'hold to talk', label: 'Hex', app: 'anomaly.hex', onPress: { type: 'hold-keys', combo: 'ropt' } },
        { glyph: 'headphones', label: 'Audio & Video', tone: 'black', onPress: { type: 'page', page: 'av' } },
        { sprite: 'grokbot/bot-blob-face', spriteColor: 'black', spriteMode: 'blink', label: 'Bots', title: '{bots_waiting} calling', led: '{bots_waiting}', ledColor: '#e5484d', onPress: { type: 'page', page: 'grokbots' } },
        { glyph: 'crop', label: 'Capture', tone: 'black', onPress: { type: 'page', page: 'capture' } },
      ],
      dials: [
        { mode: 'volume', label: 'Volume', glyph: 'volume--up', unit: '%', step: 2, style: 'bar' },
        { label: 'Agents', glyph: 'agent-needs', style: 'text', display: '{agents_needs}', accent: '#e5484d', onPress: { type: 'agents-next' }, onTouch: { type: 'page', page: 'agents' } },
        { label: 'Working', glyph: 'renew', style: 'text', display: '{agents_working}', onTouch: { type: 'page', page: 'agents' } },
        { label: 'Mic', glyph: 'microphone', style: 'text', display: '{mic}', onPress: { type: 'mic-mute' }, onTouch: { type: 'mic-mute' } },
      ],
      strip: { mode: 'segments' },
    },
    // Bring your own bots: Grok Bot's plus any bot app's (~/.deckstudio/bots), calling-you first; press opens that bot.
    // (page id stays "grokbots" so older links keep working; shown while Grok Bot is in front)
    grokbots: {
      name: 'Bots',
      source: 'bots',
      apps: ['com.anysphere.sand'],
      keys: [], dials: [{}, { mode: 'volume', label: 'Volume', glyph: 'volume--up', unit: '%', step: 2, style: 'bar' }, {}, {}], strip: { mode: 'segments' },
    },
    // Native macOS screenshots and recording: /usr/sbin/screencapture via the `capture` action
    // (synthetic ⌘⇧3/⌘⇧4 keystrokes are ignored by macOS). Saves where macOS saves screenshots.
    capture: {
      name: 'Capture',
      keys: [
        { glyph: 'fit-to-screen', title: 'file', label: 'Full screen', onPress: { type: 'capture', mode: 'screen' } },
        { glyph: 'crop', title: 'file', label: 'Selection', onPress: { type: 'capture', mode: 'selection' } },
        { glyph: 'application', title: 'file · hold: clip', label: 'Window', onPress: { type: 'capture', mode: 'window' }, onLongPress: { type: 'capture', mode: 'window', to: 'clipboard' } },
        { glyph: 'recording', title: 'hold: toolbar', label: 'Record', tone: 'black', ledColor: '#e5484d', onPress: { type: 'capture', mode: 'record' }, onLongPress: { type: 'capture', mode: 'toolbar' } },
        { glyph: 'image--copy', title: 'clipboard', label: 'Full screen', onPress: { type: 'capture', mode: 'screen', to: 'clipboard' } },
        { glyph: 'cut-out', title: 'clipboard', label: 'Selection', onPress: { type: 'capture', mode: 'selection', to: 'clipboard' } },
        { glyph: 'timer', title: 'secs: dial 1', label: 'Timed', onPress: { type: 'capture', mode: 'screen', delayDial: 1 } },
        { glyph: 'folder', title: 'hold: copy path', label: 'Screenshots', tone: 'black', onPress: { type: 'capture', mode: 'folder' }, onLongPress: { type: 'capture', mode: 'copy-last' } },
      ],
      dials: [
        { mode: 'value', label: 'Timer', glyph: 'timer', unit: 's', min: 1, max: 30, step: 1, value: 5, default: 5, style: 'bar', accent: '#e8590c',
          onPress: { type: 'capture', mode: 'screen', delay: '{value}' }, onTouch: { type: 'capture', mode: 'screen', delay: '{value}' } },
        { label: 'Record', glyph: 'recording', style: 'text', display: '{rec_time}', accent: '#e5484d',
          onPress: { type: 'capture', mode: 'record' }, onTouch: { type: 'capture', mode: 'record' } },
        { label: 'Last', glyph: 'image', style: 'text', display: '{last_capture}',
          onPress: { type: 'capture', mode: 'copy-last' }, onTouch: { type: 'capture', mode: 'reveal-last' }, onLongTouch: { type: 'capture', mode: 'open-last' } },
        { label: 'Toolbar', glyph: 'screen', style: 'text', display: '⌘⇧5',
          onPress: { type: 'capture', mode: 'toolbar' }, onTouch: { type: 'capture', mode: 'toolbar' } },
      ],
      strip: { mode: 'segments' },
    },
    // Microphones, outputs and the camera, generated from the devices on this Mac.
    av: {
      name: 'Audio & Video',
      source: 'audio',
      keys: [],
      dials: [{ mode: 'volume', label: 'Volume', glyph: 'volume--up', unit: '%', step: 2, style: 'bar' }, {}, {}, { mode: 'brightness', label: 'Deck', glyph: 'light', unit: '%', step: 5, style: 'bar', accent: '#e8590c' }],
      strip: { mode: 'segments' },
    },
  },
})
