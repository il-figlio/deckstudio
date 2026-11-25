// Types for the server-side modules the demo imports directly (see vite.config.ts aliases).
/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "@deck/render.mjs" {
  type Canvas = HTMLCanvasElement
  export function renderKey(key: any, theme: any, opts?: any): Promise<Canvas>
  export function renderStrip(strip: any, dials: any[], values: any[], theme: any, opts?: any): Promise<Canvas>
  export function renderError(w: number, h: number, msg: string): Canvas
  export const SEG_W: number
}
declare module "@deck/render-spec.mjs" {
  export function renderKeySpec(key: any, theme: any, opts?: any): Promise<HTMLCanvasElement>
  export function renderStripSpec(strip: any, dials: any[], values: any[], theme: any, opts?: any): Promise<HTMLCanvasElement>
  export function isAnimatedGif(src: unknown): boolean
}
declare module "@deck/default-profile.mjs" {
  export function defaultProfile(): any
}
declare module "@deck/topics.mjs" {
  export function topicGlyph(...texts: (string | undefined | null)[]): string | null
}
declare module "@deck/recipes.mjs" {
  export const RECIPES: any[]
  export function fillTemplate(value: any, vars: Record<string, string>): any
}
declare module "@deck/dial-rules.mjs" {
  export function isAction(a: unknown): boolean
  export function dialReadonlyInferred(d: unknown): boolean
  export function dialReadonly(d: unknown): boolean
  export function isVarValue(v: unknown): boolean
  export function dialVarValue(v: unknown, vars: Record<string, unknown>): number | string | null
}
declare module "virtual:deck-catalog" {
  const catalog: { custom: string[]; carbon: string[]; logos: string[]; sprites: string[] }
  export default catalog
}
declare module "@deck/bot-schema.mjs" {
  export const SHAPES: string[]
  export const COLORS: string[]
  export const GROK: { id: string; name: string; app: string; logo: string; schemes: string[] }
  export const MAX_DOC: number
  export type BotTrust = { enabled: boolean; allowShell: boolean; schemes: string[] }
  export type BotPress = { kind: "url" | "app" | "shell" | "none"; url?: string; target?: string; cmd?: string; blocked?: string }
  export function providerTrust(list: unknown, id: string, declared?: string[]): BotTrust
  export function botPress(b: any, trust?: Partial<BotTrust>, app?: string): BotPress
  export function pressText(p: BotPress): string
  export function pressSummary(presses: BotPress[]): string
  export const EXAMPLE_DOC: any
  export const MAX_BOTS: number
  export function providerId(v: unknown, fallback?: string): string
  export function providerColor(p: string): string
  export function normalizeBot(r: any, provider: string, i?: number): any
  export function parseBotDocs(input: unknown, fallback?: string): { provider: string; name: string; app?: string; logo?: string; schemes?: string[]; bots: any[] }[]
  export function findBot<T extends { key: string; id: string; provider: string; name: string; fullName: string }>(bots: T[], ref: unknown): T | null
  export function listBots<T>(bots: T[], opts?: { providers?: string[]; pins?: unknown[] }): T[]
  export function isWaiting(b: any): boolean
  export function botFace(b: any, opts?: { image?: string }): any
  export function botThumb(b: any, logoUrl?: (n: string) => string): string | null
}
declare module "virtual:deck-registry" {
  // a build-time copy of the plugin registry (vite.config.ts registrySnapshot): verified entries + their manifest text
  const registry: { ok: boolean; source: string | null; plugins: ({ id: string; name: string; version: string; tags: string[]; manifest: string; sha: string } & Record<string, any>)[] }
  export default registry
}
declare module "@deck/plugin-schema.mjs" {
  export type PluginGrants = { shell: boolean; schemes: string[]; network: string[] }
  export type PluginTransport = { kind: "cmd" | "http" | "file" | "builtin"; interval: number; timeout: number; stale: number; parse: string; cmd?: string | string[]; http?: string; file?: string; builtin?: string }
  export type PluginManifest = {
    deckstudio: string; id: string; source: string; builtin?: string; name: string; version: string; author?: string; homepage?: string; description?: string
    icon?: { file?: string; glyph?: string; logo?: string }; permissions: PluginGrants
    detect: { bundle: string[]; bin: string[]; paths: string[] }; install?: { brew?: string; url?: string; note?: string }
    status?: PluginTransport; bots?: PluginTransport; values: Record<string, any>; actions: Record<string, any>
    templates: { keys: Record<string, any>; dials: Record<string, any>; pages: Record<string, any> }
    settings: Record<string, PluginSetting>
  }
  export type PluginSetting = { type: "string" | "number" | "boolean"; default: string | number | boolean; title: string; description?: string; secret?: boolean }
  export const PLUGIN_SCHEMA: string
  export const VAR_RE: RegExp
  export function validateManifest(raw: unknown, opts?: { source?: string }): { ok: boolean; manifest: PluginManifest | null; errors: string[]; warnings: string[] }
  export function cleanPluginsConfig(v: unknown): Record<string, { enabled?: boolean; grants: PluginGrants; settings?: Record<string, string | number | boolean> }>
  export function pluginSettings(cfg: unknown, m: PluginManifest): Record<string, string | number | boolean>
  export function checkSettings(m: PluginManifest, req: unknown): Record<string, string | number | boolean | null>
  export function pluginTrust(cfg: unknown, m: PluginManifest, sha?: string | null): { enabled: boolean; updated?: boolean; grants: PluginGrants }
  export function publicSettings(m: PluginManifest, settings: Record<string, unknown>): Record<string, string | number | boolean>
  export function execParts(json: unknown): { path: string; what: string; sig: string }[]
  export function missingGrants(m: PluginManifest, t: { grants: PluginGrants }): PluginGrants
  export function extractValues(m: PluginManifest, doc: unknown, opts?: { stale?: boolean; settings?: Record<string, unknown> }): Record<string, string>
  export function pluginVars(id: string, values: Record<string, string>, state: string, settings?: Record<string, unknown>): Record<string, string>
  export function pluginRecipes(m: PluginManifest, opts?: { context?: string }): any[]
  export function referencedPlugins(json: unknown): Set<string>
  export function checkGrant(m: PluginManifest, req: unknown): PluginGrants
  export function cmdAllowed(cmd: unknown, grants: PluginGrants, m?: PluginManifest): string | null
  export function httpAllowed(url: string, grants: PluginGrants): string | null
  export function urlAllowed(url: string, grants: PluginGrants): string | null
  export function jsonPath(doc: unknown, path: string): unknown
}
declare module "@deck/agent-schema.mjs" {
  export const AGENT_SCHEMA: string
  export const STATES: string[]
  export const NEEDS_KINDS: string[]
  export const AGENT_APPS: string[]
  export const APP_NAMES: Record<string, string>
  export const BUILTIN_PROVIDERS: Record<string, { id: string; name: string; app?: string; logo: string; kind: "rex" | "hook" }>
  export type AgentTrust = { enabled: boolean; schemes: string[] }
  export type AgentPress = { kind: "url" | "app" | "none"; url?: string; target?: string; blocked?: string }
  export function normState(v: unknown): string
  export function normApp(v: unknown): string
  export function normalizeSession(r: any, provider: string): any
  export function parseAgentDocs(input: unknown, fallback?: string): { provider: string; name: string; app?: string; logo?: string; schemes?: string[]; sessions: any[] }[]
  export function cleanAgentStatus(b: any): any
  export function agentTrust(list: unknown, id: string, declared?: string[]): AgentTrust
  export function agentPress(s: any, trust?: Partial<AgentTrust>, providerApp?: string): AgentPress
  export function attentionOf(s: any, opts?: { seen?: number; baseline?: number }): "needs" | "review" | "working" | "idle"
  export function sortAgents<T>(list: T[], order?: (a: T) => number): T[]
  export function countAgents(list: { attention: string }[]): { needs: number; review: number; working: number; idle: number }
  export function hostApp(env?: Record<string, string>): string
  export function hookStatus(source: string, payload: any, env?: Record<string, string>): any
  export const EXAMPLE_AGENT_DOC: any
  export const HOOK_PATH: string
  export const CLAUDE_HOOK_EVENTS: string[]
  export function claudeHooksSnippet(hook?: string): string
  export function codexNotifySnippet(hook?: string): string
  export const CODEX_ARGV_WARNING: string
  export function curlStatusSnippet(base?: string): string
}
