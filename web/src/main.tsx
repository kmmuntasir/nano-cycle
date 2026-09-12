import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import CssBaseline from "@mui/material/CssBaseline";
import { ThemeProvider } from "@mui/material/styles";
import App from "./App";
import { theme } from "./theme";

function showBootError(text: string) {
  const el = document.createElement("pre");
  el.id = "boot-error";
  el.style.cssText = "color:#f66;padding:12px;white-space:pre-wrap;font-size:12px";
  el.textContent = "BOOT ERROR: " + text;
  document.body.prepend(el);
}

window.addEventListener("error", (e) => showBootError(e.message ?? String(e)));
window.addEventListener("unhandledrejection", (e) =>
  showBootError(String((e.reason as Error)?.stack ?? e.reason)),
);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <App />
    </ThemeProvider>
  </StrictMode>,
);
