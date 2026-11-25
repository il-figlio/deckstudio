// `mytool status [--line|--json]` with the deck contract.
import { readStatus } from './status.js'

/**
 * Implements `status [--line|--json]`. `argv` is what follows the program name (a leading `"status"` is skipped).
 * - `--line`: one word (the state, or `off` when not running / stale), exit 0.
 * - `--json`: the status document on one line (`state: "off"`, `stale: true` when stale), exit 0.
 * - no flag: the same JSON, pretty-printed. An unknown flag: usage on stderr, exit 2.
 * @returns {number} the exit code
 */
export function statusCli(argv, opts = {}) {
  const args = [...argv]
  if (args[0] === 'status') args.shift()
  const out = opts.stdout || (s => process.stdout.write(s))
  const err = opts.stderr || (s => process.stderr.write(s))
  let format = 'pretty'
  for (const a of args) {
    if (a === '--line') format = 'line'
    else if (a === '--json') format = 'json'
    else { err('usage: status [--line|--json]\n'); return 2 }
  }
  const s = readStatus(opts)
  out(`${format === 'line' ? s.state : JSON.stringify(s.document, null, format === 'json' ? 0 : 2)}\n`)
  return 0
}
