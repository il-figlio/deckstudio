// Writes deckstudio.json with the deckkit builder (validated before writing). Run: node make-manifest.mjs
import { manifest } from '../../ts/deckkit/src/index.js' // '@deckstudio/deckkit'

manifest('ticker', { name: 'Ticker', version: '1.0.0', description: 'A counter service: the key shows the count, press adds one.' })
  .set('$schema', '../../../docs/plugin.schema.json')
  .author('DeckStudio SDK example')
  .icon({ glyph: 'add' })
  .detect({ bin: ['$dir/ticker.mjs'] })
  .statusCmd(['$dir/ticker.mjs', 'status', '--json'], { interval: 2, stale: 95 })
  .value('state', { path: '$.state', default: 'off', stale: 'off' })
  .value('count', { path: '$.values.count', default: '–', stale: '–' })
  .cmd('bump', ['$dir/ticker.mjs', 'bump', '{by}'], { title: 'Add to the count', params: ['by'], toast: true })
  .key('count', { glyph: 'add', title: '{self.state}', label: '{self.count}', led: '{self.state}', onPress: { type: 'plugin', action: 'bump', args: { by: '1' } } },
    { title: 'Ticker count', what: 'Shows the count; press adds one.' })
  .write(new URL('.', import.meta.url).pathname)
