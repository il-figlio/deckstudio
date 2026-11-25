// Grok Bot roster: every bot with its avatar shape/color, unread count and whether it's
// waiting on you — read from the app's local cache, opened via grokbot://app/v1/agent?id=…
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'

const DIR = path.join(process.env.HOME, 'Library/Application Support/Grok Bot/sand-client-persistence')
const SHAPES = new Set(['arch', 'bean', 'blob', 'capsule', 'cloud', 'clover', 'crystal', 'cylinder', 'dome', 'egg', 'flower', 'gem', 'heart', 'hex', 'house', 'leaf', 'pebble', 'pumpkin', 'shield', 'sparkle', 'square', 'squircle', 'star', 'tablet', 'teardrop', 'wedge'])

function b32decode(s) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0, val = 0, out = []
  for (const ch of s.toUpperCase()) { const i = A.indexOf(ch); if (i < 0) continue; val = (val << 5) | i; bits += 5; if (bits >= 8) { out.push((val >>> (bits - 8)) & 255); bits -= 8 } }
  return Buffer.from(out).toString('utf8')
}

export class GrokBots {
  constructor() { this.bots = []; this.file = null; this.mtime = 0; this.available = fs.existsSync(DIR) }
  locate() {
    try {
      for (const f of fs.readdirSync(DIR)) if (f.endsWith('.blob') && b32decode(f.slice(0, -5)).endsWith('.roster.last-roster')) return path.join(DIR, f)
    } catch {}
    return null
  }
  /** Re-read the roster if it changed. Returns true when the bot list changed. */
  refresh() {
    this.file ??= this.locate()
    if (!this.file) { this.available = false; return false }
    try {
      const st = fs.statSync(this.file)
      if (st.mtimeMs === this.mtime) return false
      this.mtime = st.mtimeMs
      const rows = JSON.parse(fs.readFileSync(this.file, 'utf8'))?.value?.rows || []
      this.bots = rows.filter(r => r && r.id && !r.isRemovedFromSidebar).map(r => ({
        id: r.id, name: String(r.name || 'bot').split(' · ')[0], fullName: r.name || '',
        shape: SHAPES.has(r.avatarShape) ? r.avatarShape : 'blob', color: r.avatarColor || 'black',
        unread: Number(r.unreadCount) || 0, awaiting: !!r.awaitingUserResponse, hidden: !!r.isHiddenFromSidebar,
        activityAt: r.lastActivityAt || r.updatedAt || 0,
      }))
      this.available = true
      return true
    } catch { this.file = null; return false }
  }
  /** Bots that need you first (waiting on you, then unread), then most recently active. */
  list(pinned = []) {
    const pins = pinned.map(p => String(p).toLowerCase())
    const isPinned = b => pins.includes(b.id.toLowerCase()) || pins.includes(b.name.toLowerCase()) || pins.includes(b.fullName.toLowerCase())
    const score = b => (b.awaiting ? 2 : 0) + (b.unread ? 1 : 0)
    const visible = this.bots.filter(b => !b.hidden || isPinned(b))
    const at = b => { const i = pins.findIndex(p => p === b.id.toLowerCase() || p === b.name.toLowerCase() || p === b.fullName.toLowerCase()); return i < 0 ? 1e9 : i }
    if (pins.length) return visible.filter(isPinned).sort((a, b) => at(a) - at(b))
    return visible.sort((a, b) => score(b) - score(a) || b.activityAt - a.activityAt)
  }
  /** by id, exact name, or case-insensitive name */
  find(ref) {
    const r = String(ref || '').toLowerCase()
    return this.bots.find(b => b.id === ref) || this.bots.find(b => b.name.toLowerCase() === r || b.fullName.toLowerCase() === r) || null
  }
  open(id) {
    return new Promise((resolve, reject) => {
      if (!/^[0-9a-f-]{8,64}$/i.test(id)) return reject(new Error('bad bot id'))
      execFile('open', [`grokbot://app/v1/agent?id=${encodeURIComponent(id)}`], err => (err ? reject(err) : resolve()))
    })
  }
}
