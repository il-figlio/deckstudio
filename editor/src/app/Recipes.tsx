// Recipe browser: ready-made keys / dials / pages, each with a setup prompt for an agent.
import * as React from "react"
import { Button } from "@/components/ui/button"
import { Icon } from "@/components/ui/icon"
import { adoptProfile, api, clone, flushSave, state, toast, touch, type Profile } from "./store"

type Recipe = {
  id: string; category: string; where: "key" | "dial" | "page" | "none"; title: string; what: string
  needs?: string[]; ask?: { name: string; label: string }[]; template: unknown; prompt: string
  plugin?: string; pluginEnabled?: boolean
}

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{\{(\w+)\}\}/g, (m, k) => vars[k] || m)

/** Apply a recipe (or a plugin template, recipe id "plugin-<id>-<name>") to key / dial `index` of the current page, or as a new page. One undo step. */
export async function applyRecipe(id: string, where: string, index: number | undefined, vars: Record<string, string> = {}, title = id) {
  await flushSave()
  const before = clone(state.profile!) // the undo point: the server's WS echo can land before the GET below
  const out = await api<{ page?: string }>("POST", "/api/recipes/apply", { id, vars, page: state.page, index })
  // the server changed the profile: take its copy (one undo step) before showing anything that uses it
  const st = await api<{ profile: Profile }>("GET", "/api/state")
  adoptProfile(st.profile, true, before)
  if (where === "page" && out.page) { state.page = out.page; state.sel = { kind: "page" }; await api("POST", "/api/goto", { page: out.page }) }
  toast(where === "page" ? `added page "${out.page}"` : `applied ${title}`)
  state.formKey++
  touch()
  return out
}

export function Recipes({ onClose }: { onClose(): void }) {
  const [recipes, setRecipes] = React.useState<Recipe[]>([])
  const [open, setOpen] = React.useState<string | null>(null)
  const [vars, setVars] = React.useState<Record<string, string>>({})
  const [q, setQ] = React.useState("")
  React.useEffect(() => { api<{ recipes: Recipe[] }>("GET", "/api/recipes").then((r) => setRecipes(r.recipes)).catch(() => {}) }, [])
  const sel = state.sel
  const target = (r: Recipe) =>
    r.where === "page" ? "as a new page"
      : r.where === "key" ? (sel.kind === "key" ? `to key ${sel.index + 1}` : null)
      : r.where === "dial" ? (sel.kind === "dial" ? `to dial ${sel.index + 1}` : null)
      : null
  const shown = recipes.filter((r) => !q || `${r.title} ${r.what} ${r.category}`.toLowerCase().includes(q.toLowerCase()))
  const cats = [...new Set(shown.map((r) => r.category))]
  return (
    <div data-ds-modal role="dialog" aria-modal aria-labelledby="rec-title" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div data-kit="module" data-ds-modal-card data-ds-recipes>
        <header data-ds-row>
          <h2 id="rec-title" style={{ flex: 1 }}>recipes</h2>
          <input data-kit="input" placeholder="search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 200 }} />
          <Button round aria-label="close" onClick={onClose}><Icon name="close" /></Button>
        </header>
        <p data-ds-note>
          ready-made keys, dials and pages. apply one to the selected {sel.kind === "key" || sel.kind === "dial" ? sel.kind : "key or dial"}, or copy its setup prompt
          into claude code / codex / ante and let the agent build or adapt it.
        </p>
        {cats.map((c) => (
          <section key={c}>
            <h3 data-ds-cat>{c}</h3>
            {shown.filter((r) => r.category === c).map((r) => {
              const isOpen = open === r.id
              const where = target(r)
              return (
                <article key={r.id} data-ds-recipe data-open={isOpen || undefined}>
                  <button type="button" data-ds-recipe-head onClick={() => { setOpen(isOpen ? null : r.id); setVars({}) }}>
                    <strong>{r.title}</strong>
                    <span data-ds-tag>{r.where === "none" ? "prompt" : r.where}</span>
                    <span data-ds-note style={{ flex: 1, textAlign: "left" }}>{r.what}</span>
                  </button>
                  {isOpen && (
                    <div data-ds-recipe-body>
                      {r.needs && <p data-ds-note>needs: {r.needs.join(" · ")}</p>}
                      {r.ask?.map((a) => (
                        <label key={a.name} data-kit="field">
                          <span data-kit="label">{a.label}</span>
                          <input data-kit="input" value={vars[a.name] || ""} onChange={(e) => setVars({ ...vars, [a.name]: e.target.value })} />
                        </label>
                      ))}
                      <pre data-ds-cmds>{fill(r.prompt, vars)}</pre>
                      <div data-ds-row>
                        {r.template != null && r.where !== "none" && (
                          <Button
                            tone="primary"
                            disabled={!where || r.pluginEnabled === false}
                            title={r.pluginEnabled === false ? `switch the ${r.plugin} plugin on first (plugins tab)` : where ? undefined : `select a ${r.where} on the deck first`}
                            onClick={async () => {
                              const s = state.sel as { kind: string; index?: number }
                              await applyRecipe(r.id, r.where, s.index, vars, r.title)
                              onClose()
                            }}
                          >
                            apply {where || `(select a ${r.where})`}
                          </Button>
                        )}
                        <Button onClick={() => navigator.clipboard.writeText(fill(r.prompt, vars)).then(() => toast("prompt copied — paste it into your agent"))}>
                          <Icon name="copy" /> copy prompt
                        </Button>
                      </div>
                    </div>
                  )}
                </article>
              )
            })}
          </section>
        ))}
      </div>
    </div>
  )
}
