// Single source of truth for the V3 theme catalog. Both AppV3.tsx (cycle
// shortcut) and views.tsx (theme picker grid) consume this; without it the
// two files drift and a new theme breaks the cycle order.

export const V3_THEME_ORDER = [
  "light",
  "dark",
  "pastel-kawaii",
  "cyber-moon",
  "brutal-green",
  "pixel-command",
  "text-ticker",
  "blueprint",
  "win95",
  "vapor",
  "bunker",
  "bios",
] as const;

export type V3Theme = (typeof V3_THEME_ORDER)[number];

// Visual catalog for the Settings theme picker. Co-located with the type so
// the swatch data and the order can't drift apart.
export interface V3ThemeOption {
  id: V3Theme;
  label: string;
  swatch: [string, string, string];
}
export const V3_THEME_OPTIONS: V3ThemeOption[] = [
  { id: "light",         label: "Light",          swatch: ["#F8F9FB", "#FFFFFF", "#ED7B26"] },
  { id: "dark",          label: "Dark",           swatch: ["#0F172A", "#1E293B", "#ED7B26"] },
  { id: "pastel-kawaii", label: "Pastel Kawaii",  swatch: ["#FBF1F6", "#FFFFFF", "#C24683"] },
  { id: "cyber-moon",    label: "Cyber Moon",     swatch: ["#0A0820", "#14122B", "#22D3EE"] },
  { id: "brutal-green",  label: "Brutal Green",   swatch: ["#050705", "#0B0F0B", "#3DDC84"] },
  { id: "pixel-command", label: "Pixel Command",  swatch: ["#F2EAD6", "#FBF6E7", "#B8351E"] },
  { id: "text-ticker",   label: "Text Ticker",    swatch: ["#F4EFE6", "#FBF7EE", "#B23A2E"] },
  { id: "blueprint",     label: "Blueprint",      swatch: ["#103A5C", "#164870", "#F0892B"] },
  { id: "win95",         label: "Win95",          swatch: ["#D4D0C8", "#C0C0C0", "#000080"] },
  { id: "vapor",         label: "Vapor",          swatch: ["#2B0E3A", "#1A0E2E", "#22D3EE"] },
  { id: "bunker",        label: "Bunker",         swatch: ["#14160F", "#1F2218", "#E8A33D"] },
  { id: "bios",          label: "BIOS",           swatch: ["#0000AA", "#000080", "#FFFF00"] },
];

// One-shot apply: load CSS + persist + set body attribute. Both the cycle
// shortcut (AppV3) and the picker (views) call this. Returns the resolved
// theme so callers can update local state without re-reading.
export function applyAndPersistV3Theme(theme: V3Theme): V3Theme {
  void loadV3Theme(theme);
  try {
    localStorage.setItem("csk-theme-v3", theme);
  } catch {
    /* localStorage unavailable — applied to body, not persisted */
  }
  return theme;
}

// Read the saved preference or fall back to whatever <body> has now (for
// when localStorage is wiped but the boot script already attached a theme).
export function readSavedV3Theme(): V3Theme {
  try {
    const saved = localStorage.getItem("csk-theme-v3");
    if (saved && isV3Theme(saved)) return saved;
  } catch {
    /* ignore */
  }
  return readV3ThemeFromBody();
}

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
