// @deckstudio/deckkit: expose a macOS tool to DeckStudio. Zero dependencies, Node 18+.
export { createStatus, readStatus, heartbeatAt, isAlive, appDir, statusPath, tokenPath, writeAtomic, cleanState, STATUS_SCHEMA, HEARTBEAT_MS, STALE_MS } from './status.js'
export { controlToken, constantTimeEqual, tokenIn } from './token.js'
export { manifest, validate, parsePath, jsonPath, PLUGIN_SCHEMA, MANIFEST, RESERVED_IDS } from './manifest.js'
export { statusCli } from './cli.js'
