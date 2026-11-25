#!/usr/bin/env node
// ticker: a counter service on the Stream Deck through DeckStudio (deckkit example).
//   ticker.mjs serve            the service: a loopback HTTP server + the status file
//   ticker.mjs bump [n]         adds n (what the deck key calls; carries the control token)
//   ticker.mjs status [--line|--json]
import http from 'node:http'
import { createStatus, readStatus, controlToken, statusCli } from '../../ts/deckkit/src/index.js' // '@deckstudio/deckkit'

const APP = 'Ticker'
const token = controlToken({ app: APP })
const [cmd, arg] = process.argv.slice(2)

if (cmd === 'status') process.exit(statusCli(process.argv.slice(3), { app: APP }))
if (cmd === 'serve') {
  const status = createStatus({ app: APP })
  let count = 0
  token.ensure()
  const server = http.createServer((req, res) => {
    // Only our CLI can read the 0600 token file, so a web page that finds the port still can't bump.
    if (req.method !== 'POST' || req.url !== '/bump' || !token.verify(req.headers['x-ticker-token'])) return res.writeHead(403).end()
    count += Math.max(1, Math.min(100, Number(req.headers['x-ticker-by']) || 1))
    status.update({ count })
    res.end(String(count))
  })
  server.listen(0, '127.0.0.1', () => status.set('ready', { count, port: server.address().port }))
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { status.stop(); process.exit(0) })
} else if (cmd === 'bump') {
  const s = readStatus({ app: APP })
  if (!s.running) { console.log('ticker is not running'); process.exit(1) }
  const res = await fetch(`http://127.0.0.1:${s.values.port}/bump`, { method: 'POST', headers: { 'x-ticker-token': token.ensure(), 'x-ticker-by': String(arg || 1) } })
  console.log(res.ok ? `count ${await res.text()}` : `refused (${res.status})`)
} else { console.error('usage: ticker.mjs serve | bump [n] | status [--line|--json]'); process.exit(2) }
