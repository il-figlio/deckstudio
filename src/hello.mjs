// Is the program on DeckStudio's port really this DeckStudio? Checked by every client (deckctl, the MCP server;
// bin/deck-agent-hook has a dependency-free copy) BEFORE it sends the token, so a process that squats port 7337
// while DeckStudio is down can't collect it.
//
//   client: nonce = 16 random bytes (hex) → GET /api/hello?nonce=<nonce>   (no token)
//   server: { deckstudio: "hello/v1", id: <random per start>, proof: HMAC-SHA256(token, "deckstudio-hello/v1\n<nonce>\n<id>") }
//   client: recomputes the proof with the token it read from ~/.deckstudio/token; only on a match does it send the token.
//
// Only a process that can read the token file (i.e. the server that wrote it, or code running as you, which is outside
// the threat model) can answer. The token itself changes on every server start (server.mjs). ~/.deckstudio/server.json
// (0600) records the running server's id and pid; a client that can read it also checks the id matches.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

export const HELLO = 'hello/v1'
export const helloProof = (token, nonce, id) => crypto.createHmac('sha256', String(token)).update(`deckstudio-${HELLO}\n${nonce}\n${id}`).digest('hex')

/**
 * Check the server at `base` (an http://127.0.0.1:<port> origin) knows `token`.
 * Returns { ok: true, id } or { ok: false, down?: true, why }.
 */
export async function verifyServer(base, token, { home, timeout = 3000 } = {}) {
  const nonce = crypto.randomBytes(16).toString('hex')
  let r
  try { r = await fetch(`${base}/api/hello?nonce=${nonce}`, { redirect: 'error', signal: AbortSignal.timeout(timeout) }) }
  catch (e) { return { ok: false, down: true, why: e?.name === 'TimeoutError' ? `no answer from ${base} within ${timeout / 1000} s` : `nothing answers at ${base}` } }
  const j = await r.json().catch(() => null)
  const notUs = `the program listening at ${base} is not this DeckStudio (it can't prove it knows the token), so the token was not sent. If DeckStudio was just restarted, try again; otherwise check what is using that port (lsof -nP -iTCP:${new URL(base).port} -sTCP:LISTEN)`
  if (!r.ok || !j || typeof j.id !== 'string' || typeof j.proof !== 'string' || !/^[0-9a-f]{64}$/.test(j.proof)) return { ok: false, why: notUs }
  const want = Buffer.from(helloProof(token, nonce, j.id))
  if (!crypto.timingSafeEqual(Buffer.from(j.proof), want)) return { ok: false, why: notUs }
  if (home) {
    let info = null
    try { info = JSON.parse(fs.readFileSync(path.join(home, 'server.json'), 'utf8')) } catch {}
    if (info?.id && info.id !== j.id) return { ok: false, why: `${base} answers as server ${j.id.slice(0, 8)}, but ${path.join(home, 'server.json')} names ${String(info.id).slice(0, 8)}: is a second DeckStudio running? Not sending the token.` }
  }
  return { ok: true, id: j.id }
}
