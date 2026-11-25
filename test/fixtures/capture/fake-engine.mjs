export function fakeEngine(extra = {}) {
  const e = {
    page: 'p1', log: [],
    toast(t) { e.log.push(['toast', String(t)]) },
    notify(m, l) { e.log.push(['notify', l, m]) },
    trace(x) { e.log.push(['trace', x]) },
    scheduleRender() {},
    hasPage: id => ['p1', 'p2'].includes(id),
    dialValue: (i, pg = e.page) => (pg === 'p1' ? [7, 2, 0, 'x'][i] : [3, 3, 3, 3][i]),
    toasts: () => e.log.filter(x => x[0] === 'toast').map(x => x[1]),
    ...extra,
  }
  return e
}
export const sleep = ms => new Promise(r => setTimeout(r, ms))
export const pgrep = pat => import('node:child_process').then(cp => { try { return cp.execSync(`pgrep -f ${JSON.stringify(pat)} || true`).toString().trim().split('\n').filter(Boolean) } catch { return [] } })
