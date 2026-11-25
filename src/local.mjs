// Loads src/local-profile.mjs (gitignored, optional): personal pages, keys and recipes that stay on this Mac.
let local = {}
try { local = await import('./local-profile.mjs') } catch (e) {
  if (e?.code !== 'ERR_MODULE_NOT_FOUND' || !String(e.message).includes('local-profile')) console.error('local-profile.mjs:', e.message)
}

/** The starter profile with local pages merged in and the local patch applied. */
export function withLocal(p) {
  if (local.pages) p.pages = { ...p.pages, ...structuredClone(local.pages) }
  return typeof local.patch === 'function' ? local.patch(p) || p : p
}
export const localRecipes = () => (Array.isArray(local.recipes) ? local.recipes : [])
