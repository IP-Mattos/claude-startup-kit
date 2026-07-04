import React from "react";
import ReactDOM from "react-dom/client";
import AppV3 from "./v3/AppV3";
import { isV3Theme, loadV3Theme } from "./lib/themes";

// Pixel mono — used by the manga theme (src/v3/themes/manga.css)
import "@fontsource/vt323/400.css";
// V3 SaaS dashboard font
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";

// V3 is the only layout. The v1-layout class on body is kept because every
// `body[data-theme-v3]` rule is scoped under it; removing the class would
// orphan the cascade.
document.documentElement.removeAttribute("data-theme");
document.body.classList.add("v3-layout");

// Lazy-load just the active theme stylesheet. Light is the implicit default
// (its tokens are baked into AppV3.css fallbacks) but we still load its CSS
// so the override rules apply.
let v3Theme = "light";
try {
  const saved = localStorage.getItem("csk-theme-v3");
  if (saved && isV3Theme(saved)) v3Theme = saved;
} catch {
  /* localStorage unavailable */
}
// Fire-and-forget; React renders immediately and the stylesheet attaches
// a tick later. Brief unstyled flash on cold load is acceptable.
void loadV3Theme(v3Theme);

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <AppV3 />
  </React.StrictMode>,
);
