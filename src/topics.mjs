// What an agent is working on, as one glyph a glance can read: "Guest wifi setup" → wifi.
// First match wins, so more specific topics come first. Names are Carbon icons.
const TOPICS = [
  [/\bwi-?fi\b|wireless|\bssid\b/i, 'wifi'],
  [/stream ?deck|deckstudio|\bkeys?\b.*\bdials?\b/i, 'keyboard'],
  [/\bmcps?\b|plugin|connector|integration/i, 'plug'],
  [/\bnetwork|\bdns\b|\bvpn\b|tailscale|\bproxy\b|firewall/i, 'network--3'],
  [/\btests?\b|\bspec\b|\bqa\b|swift testing|\bci\b/i, 'test-tool'],
  [/\bbug|\bfix|crash|debug|sigterm|\berror\b|\bhang/i, 'debug'],
  [/review|audit|critique|assess|evaluat/i, 'view'],
  [/deploy|release|ship|publish|rollout/i, 'rocket'],
  [/\bpr\b|pull request|merge|\bgit\b|branch|rebase|commit/i, 'pull-request'],
  [/model|gguf|\bllm\b|gemma|gemm?ini|llama|qwen|\blora\b|fine-?tun|inference|eval/i, 'chip'],
  [/handoff|hand-off|parallel|delegate|agents?\b/i, 'events'],
  [/prompt|chat|reply|message|email|inbox/i, 'chat'],
  [/\bdocs?\b|readme|write|draft|notes?\b|spec sheet|document/i, 'document'],
  [/search|find|research|look up|mobbin/i, 'search'],
  [/design|\bui\b|\bux\b|icon|logo|figma|css|theme/i, 'color-palette'],
  [/image|photo|screenshot|video|camera/i, 'image'],
  [/audio|voice|dictation|\bmic\b|speech|tts|whisper/i, 'microphone'],
  [/database|\bsql\b|postgres|sqlite|migration|schema/i, 'data--base'],
  [/\bapi\b|endpoint|server|backend|http/i, 'api'],
  [/security|auth|token|secret|password|permission/i, 'security'],
  [/clean ?up|cleanup|refactor|remove|prune|tidy/i, 'clean'],
  [/install|setup|set up|config|settings|upgrade|update/i, 'settings'],
  [/data|csv|chart|metric|dashboard|analytics/i, 'chart--line'],
  [/trading|market|price|stock|finance|cost/i, 'currency--dollar'],
  [/calendar|meeting|schedule/i, 'calendar'],
  [/build|compile|cargo|npm|xcode/i, 'tools'],
  [/awake|caffeinate|power|battery|sleep/i, 'power'],
]

export function topicGlyph(...texts) {
  const s = texts.filter(Boolean).join(' · ')
  for (const [re, glyph] of TOPICS) if (re.test(s)) return glyph
  return null
}
