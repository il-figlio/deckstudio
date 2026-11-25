// Types for @deckstudio/deckkit. Spec: DeckStudio docs/PLUGINS.md (plugin/v1).

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

// ---------- status ----------

export declare const STATUS_SCHEMA: 'status/v1'
/** Heartbeat period (ms): the file is rewritten at least this often while running. */
export declare const HEARTBEAT_MS: 30000
/** A status older than this is stale (ms). Use `stale: 95` (seconds) in the manifest. */
export declare const STALE_MS: 95000

/** What `createStatus` writes (one JSON object, atomically, 0600 in a 0700 folder). */
export interface StatusDocument {
  schema: 'status/v1'
  /** One short word: `idle`, `working`, … `off` means not running. */
  state: string
  /** false after `stop()`; DeckStudio then skips the pid and heartbeat checks and reads `{id._state}` as `stopped`. */
  running: boolean
  /** The writer's process: when it is gone the status is stale. */
  pid: number
  /** ISO 8601 UTC with ms, rewritten at least every 30 s. */
  updated_at: string
  /** When the state last changed (ISO 8601). */
  since?: string
  /** Your numbers / words; map them in the manifest as `$.values.<name>`. Never user content. */
  values: Record<string, Json>
}

export interface StatusOptions {
  /** App name: the file is `~/Library/Application Support/<app>/deckstudio-status.json`. */
  app?: string
  /** A custom path instead. */
  file?: string
  /** Heartbeat period, ms (default and max 30000). */
  heartbeatMs?: number
  pid?: number
  now?: () => Date
  /** Keep the event loop alive with the heartbeat timer (default false: the timer is unref'd). */
  keepAlive?: boolean
}

export interface StatusWriter {
  readonly file: string
  readonly pid: number
  /** The last write error (writing is best-effort), or null. */
  lastError: Error | null
  /** Sets the state (and, when given, replaces all values), writes, and starts the heartbeat. `off` stops it. */
  set(state: string, values?: Record<string, Json>): boolean
  /** Merges values (null / undefined removes one) and writes. Before the first set(), the state is `idle`. */
  update(values: Record<string, Json | undefined>): boolean
  /** Final write with `running: false`; stops the heartbeat. Call it on exit (SIGINT/SIGTERM). */
  stop(finalState?: string, values?: Record<string, Json>): boolean
  /** Rewrites the file now. */
  write(): boolean
  /** The document as it would be written now. */
  snapshot(): StatusDocument
}

export declare function createStatus(opts: StatusOptions): StatusWriter

export interface ReadOptions {
  app?: string
  file?: string
  /** Default 95000. */
  staleAfterMs?: number
  /** The word for not running (default `off`). */
  offState?: string
  /** Epoch ms (default Date.now()). */
  now?: number
  isAlive?: (pid: number) => boolean
}

export interface StatusView {
  /** The state to show: the file's, or `offState` when missing or stale. */
  state: string
  /** What the file said before staleness (null: no readable file). */
  reportedState: string | null
  running: boolean
  pid: number | null
  /** Heartbeat, epoch ms. */
  updatedAt: number | null
  since: string | null
  values: Record<string, Json>
  stale: boolean
  staleReason: 'flag' | 'pid' | 'heartbeat' | null
  /** What `status --json` prints (state `off`, `stale: true` when stale). */
  document: Record<string, Json>
}

/** Reads a status file with DeckStudio's rules: `stale: true`, a dead `pid` (while running) or an old heartbeat → stale. */
export declare function readStatus(opts: ReadOptions): StatusView
/** The heartbeat (`updated_at` / `updatedAt` / `heartbeat`; ISO or epoch s/ms) in epoch ms, or null. */
export declare function heartbeatAt(doc: unknown): number | null
export declare function isAlive(pid: number): boolean
/** `~/Library/Application Support/<app>` on macOS; `$XDG_STATE_HOME/<app>` or `~/.local/state/<app>` elsewhere. */
export declare function appDir(app: string, opts?: { platform?: string; env?: Record<string, string | undefined> }): string
export declare function statusPath(app: string): string
export declare function tokenPath(app: string): string
/** temp file (0600, O_EXCL) + rename; creates the folder 0700 if missing. */
export declare function writeAtomic(file: string, text: string): void
export declare function cleanState(s: string): string

// ---------- control token ----------

export interface ControlToken {
  readonly file: string
  /** The token, only if the file is a regular 0600 file owned by this user. */
  read(): string | null
  /** The token, creating it (32 random bytes as hex, 0600) if needed. */
  ensure(): string
  rotate(): string
  /** Constant-time check. Missing or loose token file: false. */
  verify(given: string | null | undefined): boolean
  verifyUrl(url: string | URL): boolean
  /** `url` with `token=<token>` (replacing any present). Use it in the CLI, never in a manifest. */
  appendToken(url: string | URL): string
}
/** `~/Library/Application Support/<app>/control-token`, or `file`. */
export declare function controlToken(opts: { app?: string; file?: string }): ControlToken
export declare function constantTimeEqual(a: string, b: string): boolean
export declare function tokenIn(url: string | URL): string | null

// ---------- manifest ----------

export declare const PLUGIN_SCHEMA: 'plugin/v1'
export declare const MANIFEST: 'deckstudio.json'
export declare const RESERVED_IDS: readonly string[]

export type Command = string[] | string
export interface Transport { cmd?: Command; http?: string; file?: string; interval?: number; timeout?: number; stale?: number; parse?: 'auto' | 'json' | 'text' }
export type ValueSpec = string | {
  path: string; default?: string | number; stale?: string | number; round?: number; map?: Record<string, string | number>
  /** Tests: the value shows `then` ("on") when every test holds, else `else` (""), e.g. `{ path: '$.pct', atLeast: 80 }` for a lamp. */
  above?: number; below?: number; atLeast?: number; atMost?: number; equals?: string | number | boolean
  then?: string | number; else?: string | number
}
/** A user-editable setting: `{settings.<name>}` in the plugin's commands / paths, `{<id>.settings.<name>}` on keys. */
export interface Setting { type?: 'string' | 'number' | 'boolean'; default?: string | number | boolean; title?: string; description?: string }
export interface Action {
  title?: string; params?: string[]; refresh?: boolean
  /** cmd actions: seconds, up to 1800 (default 15; 1800 when detached). http actions: up to 60. */
  cmd?: Command; timeout?: number; toast?: boolean
  /** cmd actions only: run in the background (long builds); output goes to ~/.deckstudio/plugins-logs/<id>-<action>.log. */
  detach?: boolean
  http?: string; method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: Json
  type?: 'app' | 'url'; target?: string; url?: string
}
export interface Manifest {
  $schema?: string
  deckstudio: 'plugin/v1'
  id: string
  name: string
  version: string
  author?: string
  homepage?: string
  description?: string
  icon?: string | { glyph: string } | { logo: string }
  detect?: { bundle?: string | string[]; bin?: string | string[]; paths?: string | string[] }
  install?: { brew?: string; url?: string; note?: string }
  status?: Transport
  bots?: Transport
  values?: Record<string, ValueSpec>
  actions?: Record<string, Action>
  settings?: Record<string, Setting>
  templates?: { keys?: Record<string, Json>; dials?: Record<string, Json>; pages?: Record<string, Json> }
  permissions?: { shell?: boolean; schemes?: string[]; network?: string[] }
}
export interface ValidationResult { ok: boolean; errors: string[]; warnings: string[] }

/** Offline validation with DeckStudio's rules for a user / linked plugin (same messages as validateManifest). */
export declare function validate(manifest: Manifest | Record<string, unknown> | string): ValidationResult
export declare function parsePath(path: string): Array<string | number>
export declare function jsonPath(doc: unknown, path: string | Array<string | number>): unknown

export interface TemplateMeta { title?: string; what?: string }
export interface ManifestBuilder {
  set(key: string, value: unknown): ManifestBuilder
  name(v: string): ManifestBuilder
  version(v: string): ManifestBuilder
  description(v: string): ManifestBuilder
  author(v: string): ManifestBuilder
  homepage(v: string): ManifestBuilder
  icon(v: Manifest['icon']): ManifestBuilder
  detect(v: NonNullable<Manifest['detect']>): ManifestBuilder
  install(v: NonNullable<Manifest['install']>): ManifestBuilder
  permissions(v: NonNullable<Manifest['permissions']>): ManifestBuilder
  /** `stale` defaults to 95 (s). */
  statusFile(file: string, opts?: Omit<Transport, 'file' | 'cmd' | 'http'>): ManifestBuilder
  statusCmd(cmd: Command, opts?: Omit<Transport, 'file' | 'cmd' | 'http'>): ManifestBuilder
  statusHttp(url: string, opts?: Omit<Transport, 'file' | 'cmd' | 'http'>): ManifestBuilder
  value(name: string, spec: ValueSpec): ManifestBuilder
  /** A user-editable setting, e.g. `setting('config', { title: 'Config file', default: '~/app/config.json' })`. */
  setting(name: string, spec: Setting): ManifestBuilder
  action(name: string, spec: Action): ManifestBuilder
  cmd(name: string, argv: Command, opts?: Omit<Action, 'cmd'>): ManifestBuilder
  key(name: string, template: Json, meta?: TemplateMeta): ManifestBuilder
  dial(name: string, template: Json, meta?: TemplateMeta): ManifestBuilder
  page(name: string, template: Json, meta?: TemplateMeta): ManifestBuilder
  build(): Manifest
  toJSON(): Manifest
  validate(): ValidationResult
  /** Validates, then writes `<dir>/deckstudio.json` (or the .json path given). Returns the path. Throws when invalid. */
  write(dir: string): string
}
export declare function manifest(id: string, init?: { name?: string; version?: string; description?: string }): ManifestBuilder

// ---------- CLI ----------

export interface StatusCliOptions extends ReadOptions {
  stdout?: (s: string) => void
  stderr?: (s: string) => void
}
/** `status [--line|--json]`: prints and returns the exit code (0, or 2 for an unknown flag). */
export declare function statusCli(argv: string[], opts: StatusCliOptions): number
