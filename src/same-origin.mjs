// Request checks for the server's two token-free surfaces: POST /api/login and the icon routes. Browsers send Origin
// on every POST and Sec-Fetch-Site on every request, and a page can't forge either; a plain HTTP client (curl, another
// local user's script) can, so these keep web pages out and make a leaked login code or an icon probe take a
// deliberate forgery. They are not a boundary against local processes: that is keeping the code out of argv
// (bin/deckctl open) and the token out of reach (0600 files).

/** POST /api/login: only the editor's own page, i.e. Origin is this server (http://<allowed host>) and the browser
 *  doesn't say the request came from elsewhere. No Origin (curl, a non-browser) is refused. */
export function loginRequestOk(req, hosts) {
  const o = req.headers.origin, s = req.headers['sec-fetch-site']
  return typeof o === 'string' && o.startsWith('http://') && hosts.has(o.slice(7)) && (s == null || s === 'same-origin')
}

/** /logos, /plugin-icon, /botavatar: they reveal which apps / plugins are installed, so only the editor's own
 *  <img> loads (Sec-Fetch-Site: same-origin) or a token holder. Not other sites, typed URLs or headerless clients. */
export const assetRequestOk = (req, tokenOk) => req.headers['sec-fetch-site'] === 'same-origin' || tokenOk(req.headers['x-deck-token'])
