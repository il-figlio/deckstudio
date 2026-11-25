import { Hardware } from "@/components/ui/hardware"
import { Toasts } from "@/components/ui/toaster"
import { Banner, TopBar } from "./app/TopBar"
import { DeckView } from "./app/DeckView"
import { Inspector } from "./app/Inspector"
import { DEMO, TOKEN } from "./app/store"
import { DemoBanner } from "./demo/ui"

// Purple key color, close to the deck's default accent (#7c5cff).
const KEY = { l: 0.56, c: 0.24, h: 288 }

export default function App() {
  if (!TOKEN && !DEMO)
    return (
      <Hardware keyColor={KEY} data-ds-root>
        <div data-ds-gate data-kit="module">
          <h1>deckstudio</h1>
          <p>for security the editor needs its access token. open it from your terminal with:</p>
          <pre>deckctl open</pre>
        </div>
      </Hardware>
    )
  return (
    <Hardware keyColor={KEY} data-ds-root>
      <TopBar />
      <main data-ds-main>
        <section data-ds-left>
          {DEMO && <DemoBanner />}
          <Banner />
          <DeckView />
        </section>
        <Inspector />
      </main>
      <Toasts />
    </Hardware>
  )
}
