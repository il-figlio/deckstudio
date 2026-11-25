// The control token: proves a control request came from your own CLI (which can read a 0600 file), not from a web
// page or another app opening your URL scheme / hitting your loopback port.
import { lstatSync, readFileSync, unlinkSync } from 'node:fs'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { tokenPath, writeAtomic } from './status.js'

const TOKEN_RE = /^[0-9a-f]{64}$/

/** Constant-time string compare (false for different lengths; tokens are always 64 characters). */
export function constantTimeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b))
  return x.length === y.length && timingSafeEqual(x, y)
}

/** The `token` query parameter of a URL string, or null. */
export function tokenIn(url) {
  try { return new URL(String(url)).searchParams.get('token') } catch { return null }
}

/**
 * @param {{ app?: string, file?: string }} opts
 */
export function controlToken(opts = {}) {
  const file = opts.file || (opts.app ? tokenPath(opts.app) : null)
  if (!file) throw new Error('controlToken: give { app } or { file }')
  const self = {
    file,
    /** The token, only when the file is a regular file owned by this user with no group/other bits. */
    read() {
      try {
        const st = lstatSync(file)
        if (!st.isFile() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) return null
        const t = readFileSync(file, 'utf8').trim()
        return TOKEN_RE.test(t) ? t : null
      } catch { return null }
    },
    /** The existing private token, or a new one (32 random bytes, written 0600 atomically). */
    ensure() {
      const t = self.read()
      if (t) return t
      const token = randomBytes(32).toString('hex')
      writeAtomic(file, `${token}\n`)
      return token
    },
    /** Replaces the token (old URLs stop working). */
    rotate() { try { unlinkSync(file) } catch {} return self.ensure() },
    /** Constant-time check against the private token. Missing / loose token file: false. */
    verify(given) {
      if (typeof given !== 'string' || !TOKEN_RE.test(given)) return false
      const expected = self.read()
      return !!expected && constantTimeEqual(given, expected)
    },
    /** True when the URL's `token` parameter is the private token. */
    verifyUrl(url) { return self.verify(tokenIn(url)) },
    /** The URL with `token=<token>` (replacing any token already there), creating the token if needed. */
    appendToken(url) {
      const u = new URL(String(url))
      u.searchParams.delete('token')
      u.searchParams.append('token', self.ensure())
      return u.toString()
    },
  }
  return self
}
