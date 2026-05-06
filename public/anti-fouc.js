// Anti-FOUC theme bootstrap. Runs synchronously before the main React
// bundle so the page paints with the correct theme attribute on the
// first frame instead of flashing the default and then snapping into the
// user's choice. V3 is the active layout — only apply legacy v1 theme
// when the user explicitly opted into v1 via console backdoor.
//
// Lives in `public/` (not inline in index.html) so the production CSP
// can drop `'unsafe-inline'` from `script-src` — see tauri.conf.json
// `app.security.csp`. `'self'` covers any script Vite copies into the
// bundle root (this file lands at `/anti-fouc.js`).
(function () {
  try {
    var layout = localStorage.getItem("csk-layout-version") || "v3";
    if (layout === "v1") {
      var THEMES = [
        "kawaii", "grid", "gameboy",
        "retro-os", "hud", "petrick", "army-cream", "y2k", "pulse", "army-mauve",
        "dracula", "mono", "solarized-dark", "nord", "tokyo-night", "gruvbox",
        "lilac-os", "moon-zine", "deepweb", "akira", "alacritty", "crimson-arch",
        "aesthetic-arch", "pixel-kit", "kill-switch", "arcade-portal",
        "kawaii-v2", "grid-v2", "gameboy-v2", "dracula-v2", "mono-v2", "solarized-dark-v2",
        "nord-v2", "tokyo-night-v2", "gruvbox-v2", "retro-os-v2", "hud-v2", "petrick-v2",
        "army-cream-v2", "y2k-v2", "pulse-v2", "army-mauve-v2", "lilac-os-v2", "moon-zine-v2",
        "deepweb-v2", "akira-v2", "alacritty-v2", "crimson-arch-v2", "aesthetic-arch-v2",
        "pixel-kit-v2", "kill-switch-v2", "arcade-portal-v2"
      ];
      var t = localStorage.getItem("csk-theme");
      if (!t || THEMES.indexOf(t) === -1) {
        t = "kawaii";
        localStorage.setItem("csk-theme", t);
      }
      document.documentElement.setAttribute("data-theme", t);
    } else {
      // V3: pre-apply v3 theme to body so the early paint matches.
      var v3Theme = localStorage.getItem("csk-theme-v3") || "light";
      if (v3Theme !== "light") {
        document.body && document.body.setAttribute("data-theme-v3", v3Theme);
      }
    }
  } catch (e) {
    /* fail open — main.tsx will fix things */
  }
})();
