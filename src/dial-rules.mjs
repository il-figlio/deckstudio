// Dial rules shared by the engine, the renderer and the editor (imported there through the @deck alias),
// so the server, the demo and the editor's knobs always agree.
const isObj = v => v != null && typeof v === 'object' && !Array.isArray(v)
/** an action that does something: `{ type: 'none' }` counts as empty */
export const isAction = a => isObj(a) && !!a.type && a.type !== 'none'
// an action that reads the dial's value ({value} templates, $DECK_VALUE in shell commands)
const usesValue = a => isAction(a) && /\{value\}|DECK_VALUE/.test(JSON.stringify(a))

/** Read-only guessed from the config (no explicit `readonly`): a value dial that only shows a live readout,
 *  a `poll` and nothing that uses its value (no onChange, no press/touch reading {value} / $DECK_VALUE). */
export const dialReadonlyInferred = d => isObj(d) && d.readonly !== true && d.readonly !== false && (d.mode || 'value') === 'value'
  && ((isObj(d.poll) && !!(d.poll.cmd || d.poll.fn || d.poll.demo)) || isVarValue(d.value))
  && !isAction(d.onChange) && ![d.onPress, d.onTouch, d.onLongTouch].some(usesValue)

/** A dial `value` that is a template, e.g. "{codexbar.claude_session}": the needle follows that live var (a plugin value,
 *  {agents_needs}, …) instead of turns. Such a dial is a live readout (read-only unless `readonly: false`). */
export const isVarValue = v => typeof v === 'string' && /\{[\w.-]+(?:\|path)?\}/.test(v)
/** A template dial value filled from the current vars: a number when the text is one (a trailing % is ignored), else the text; null when empty. */
export function dialVarValue(v, vars) {
  const t = String(v).replace(/\{([\w.-]+)(?:\|path)?\}/g, (m, k) => (vars?.[k] != null ? String(vars[k]) : '')).trim()
  if (!t) return null
  const n = Number(t.replace(/%$/, ''))
  return Number.isFinite(n) ? n : t.slice(0, 80)
}

/** A dial that can't be turned: turning would just fight the next poll. `readonly: true|false` overrides the guess. */
export const dialReadonly = d => isObj(d) && (d.readonly === true || dialReadonlyInferred(d))
