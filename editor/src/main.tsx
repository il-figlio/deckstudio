import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "@fontsource/ibm-plex-mono/200.css"
import "@fontsource/ibm-plex-mono/300.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "./index.css"
import App from "./App"
import { DEMO, login, connect } from "./app/store"

;(DEMO ? Promise.resolve("") : login()).then((token) => {
  if (token || DEMO) connect()
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
})
