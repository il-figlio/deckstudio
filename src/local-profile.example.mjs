// Copy to src/local-profile.mjs (gitignored) for pages, keys and recipes that should stay on your Mac:
// internal apps, private paths, your own scripts. DeckStudio merges it over the starter profile (src/local.mjs).
// Only the starter profile and the recipe list use it: your saved profile lives in ~/.deckstudio/profile.json.

/** Extra pages, same shape as pages in default-profile.mjs. */
export const pages = {
  work: {
    name: 'Work',
    apps: ['com.example.app'], // optional: show while this app is in front
    keys: [
      { glyph: 'terminal', label: 'Deploy', onPress: { type: 'shell', cmd: '$HOME/bin/deploy', toast: true } },
    ],
    dials: [],
    strip: { mode: 'segments' },
  },
}

/** Optional: adjust the starter profile after merging, e.g. link your page from the Apps page. */
export function patch(p) {
  const keys = p.pages.apps?.keys
  if (keys) keys[5] = { glyph: 'briefcase', label: 'Work', onPress: { type: 'page', page: 'work' } }
  return p
}

/** Optional: extra recipes, same shape as RECIPES in recipes.mjs. */
export const recipes = []
