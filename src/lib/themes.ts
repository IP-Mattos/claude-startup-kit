// Single source of truth for the V3 theme catalog. Both AppV3.tsx (cycle
// shortcut) and views.tsx (theme picker grid) consume this; without it the
// two files drift and a new theme breaks the cycle order.

export const V3_THEME_ORDER = [
  "light",
  "dark",
  "dracula",
  "nord",
  "tokyo",
  "gruvbox",
  "kawaii",
  "gameboy",
  "grid",
  "mono",
  "solarized-dark",
  "retro-os",
  "hud",
  "petrick",
  "army-cream",
  "army-mauve",
  "y2k",
  "pulse",
  "akira",
  "alacritty",
  "crimson-arch",
  "aesthetic-arch",
  "pixel-kit",
  "kill-switch",
  "arcade-portal",
  "lilac-os",
  "moon-zine",
  "deepweb",
] as const;

export type V3Theme = (typeof V3_THEME_ORDER)[number];

// Vite import.meta.glob with eager:false returns lazy module loaders that
// trigger a network request only when called. This is what gives us the
// per-theme code-split chunks. No `as: "url"` — Vite injects the CSS into
// the document as a side effect when the module is imported.
const themeLoaders = import.meta.glob<unknown>("../v3/themes/*.css");

const loadedThemes = new Set<string>();
let loadingPromise: Promise<void> | null = null;

// Load (and cache) the requested theme's stylesheet, applying it to <body>
// once present. Safe to call repeatedly — subsequent calls for the same
// theme are a no-op. Returns the promise so callers can await first paint.
export async function loadV3Theme(name: V3Theme | string): Promise<void> {
  if (!isV3Theme(name)) return; // unknown theme — silently skip
  // light is the implicit default (no [data-theme-v3] attr) but its CSS still
  // defines the light tokens, so we always load it.
  applyV3ThemeAttribute(name);

  if (loadedThemes.has(name)) return;
  const loader = themeLoaders[`../v3/themes/${name}.css`];
  if (!loader) {
    console.warn(`[v3] theme "${name}" not found in glob — using current tokens`);
    return;
  }
  loadingPromise = (async () => {
    try {
      await loader();
      loadedThemes.add(name);
    } catch (e) {
      console.error(`[v3] failed to load theme ${name}:`, e);
    }
  })();
  return loadingPromise;
}

export function isV3Theme(value: string): value is V3Theme {
  return (V3_THEME_ORDER as readonly string[]).includes(value);
}

// Returns the next theme in the cycle order. Wraps around.
export function nextV3Theme(current: V3Theme | string): V3Theme {
  const idx = (V3_THEME_ORDER as readonly string[]).indexOf(current);
  return V3_THEME_ORDER[(idx + 1) % V3_THEME_ORDER.length];
}

// Body data-attribute is the theme selector hook. Light has no attribute
// (it's the implicit default token set baked into AppV3.css fallbacks).
function applyV3ThemeAttribute(name: V3Theme): void {
  if (name === "light") {
    document.body.removeAttribute("data-theme-v3");
  } else {
    document.body.setAttribute("data-theme-v3", name);
  }
}

// Best-effort read of the currently applied theme from <body>. Used at
// startup before localStorage hydrates, and as the ground truth for the
// theme cycler.
export function readV3ThemeFromBody(): V3Theme {
  const attr = document.body.getAttribute("data-theme-v3");
  if (attr && isV3Theme(attr)) return attr;
  return "light";
}
