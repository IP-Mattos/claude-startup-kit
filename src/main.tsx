import React, { Suspense, lazy } from "react";
import ReactDOM from "react-dom/client";
import AppV3 from "./v3/AppV3";

// V1 is legacy — only loaded via console backdoor `cskLayout("v1")`.
// Lazy import keeps it out of the V3 default bundle.
const AppV1 = lazy(() => import("./App"));

// Distinctive type pairing — pixel blackletter display + warm slab body + pixel mono
import "@fontsource/jacquard-12/400.css";
import "@fontsource/bitter/400.css";
import "@fontsource/bitter/500.css";
import "@fontsource/bitter/600.css";
import "@fontsource/bitter/700.css";
import "@fontsource/vt323/400.css";
// V3 SaaS dashboard font
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";

// Layout selector. v3 is the active layout — v1 is legacy and only reachable
// via the console backdoor `cskLayout("v1")` for emergency rollback.
function pickLayout(): "v1" | "v3" {
  try {
    const v = localStorage.getItem("csk-layout-version");
    if (v === "v3" || v === "v1") return v;
  } catch {
    /* localStorage unavailable */
  }
  return "v3";
}

// Expose a one-call toggle so users don't have to type two commands.
declare global {
  interface Window {
    cskLayout?: (v: "v1" | "v3") => void;
  }
}
if (typeof window !== "undefined") {
  window.cskLayout = (v) => {
    try {
      localStorage.setItem("csk-layout-version", v);
    } catch {
      /* ignore */
    }
    location.reload();
  };
}

const layout = pickLayout();
if (layout === "v3") {
  // Remove v1 data-theme so kawaii/dracula/etc. global rules don't bleed into v3.
  document.documentElement.removeAttribute("data-theme");
  document.body.classList.add("v3-layout");
  // Apply saved v3 theme (light/dark/dracula/nord/tokyo/gruvbox).
  const V3_THEMES = ["light", "dark", "dracula", "nord", "tokyo", "gruvbox"];
  let v3Theme = "light";
  try {
    const saved = localStorage.getItem("csk-theme-v3");
    if (saved && V3_THEMES.includes(saved)) v3Theme = saved;
  } catch {
    /* ignore */
  }
  if (v3Theme !== "light") {
    document.body.setAttribute("data-theme-v3", v3Theme);
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    {layout === "v3" ? (
      <AppV3 />
    ) : (
      <Suspense fallback={null}>
        <AppV1 />
      </Suspense>
    )}
  </React.StrictMode>,
);
