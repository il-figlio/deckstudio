// One-time editor login codes. `deckctl open` asks the server (with the token) for a code and opens
// /#c=<code>; the editor trades it for the token at POST /api/login. So no working token is ever in a URL or in
// browser history. The code itself is a credential until used: deckctl hands the link to the browser over
// osascript's stdin, never argv (`ps -axww` shows every user's argv, and whoever redeems first gets the token),
// and the server takes it only with the editor's own Origin (src/same-origin.mjs).
// A code is 128 random bits, works once, within `ttl` ms; only its SHA-256 is kept. After `maxFails` bad
// codes within a minute, a wrong code gets 'limited' until that minute is over. A valid code is always taken
// (looked up before the limit): otherwise anyone on the box could lock the owner out with 10 junk POSTs, and at
// 128 bits the limit isn't what stops guessing anyway.
import crypto from 'node:crypto'

const sha = s => crypto.createHash('sha256').update(String(s)).digest()

export function loginCodes({ ttl = 60e3, maxFails = 10, max = 16, now = Date.now } = {}) {
  const codes = new Map() // sha256 hex → expiry
  let fails = []
  const purge = t => { for (const [h, exp] of codes) if (exp <= t) codes.delete(h) }
  return {
    ttl,
    issue() {
      const t = now()
      purge(t)
      while (codes.size >= max) codes.delete(codes.keys().next().value)
      const code = crypto.randomBytes(16).toString('hex')
      codes.set(sha(code).toString('hex'), t + ttl)
      return code
    },
    /** @returns {'ok' | 'bad' | 'limited'} */
    redeem(code) {
      const t = now()
      fails = fails.filter(x => t - x < 60e3)
      const want = sha(typeof code === 'string' ? code : '')
      let hit = null
      for (const [h, exp] of codes) if (crypto.timingSafeEqual(Buffer.from(h, 'hex'), want) && exp > t) hit = h // compares every entry
      if (!hit) { if (fails.length >= maxFails) return 'limited'; fails.push(t); return 'bad' }
      codes.delete(hit)
      return 'ok'
    },
  }
}
