// Single source of truth for the V3 theme catalog. Both AppV3.tsx (cycle
// shortcut) and views.tsx (theme picker grid) consume this; without it the
// two files drift and a new theme breaks the cycle order.

export const V3_THEME_ORDER = [
  "light",
  "dark",
  "retro-os",
  "chrome95",
  "lunar-hud",
  "lilac-stickers",
  "y2k-pop",
  "pixel-crt",
  "ai-core",
  "satellite",
  "unix-90",
  "neural",
  "ps2-glow",
  "blueprint",
  "cyber-terminal",
  "data-dense",
  "command-palette",
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
  { id: "light",          label: "Light",          swatch: ["#F8F9FB", "#FFFFFF", "#ED7B26"] },
  { id: "dark",           label: "Dark",           swatch: ["#0F172A", "#1E293B", "#ED7B26"] },
  { id: "retro-os",       label: "Retro OS",       swatch: ["#F2F4F8", "#FFFFFF", "#1F4FD8"] },
  { id: "chrome95",       label: "Chrome 95",      swatch: ["#D4D0C8", "#C0C0C0", "#000080"] },
  { id: "lunar-hud",      label: "Lunar HUD",      swatch: ["#0E1218", "#141923", "#5EE7F2"] },
  { id: "lilac-stickers", label: "Lilac Stickers", swatch: ["#D9D2ED", "#1A1525", "#9C84C8"] },
  { id: "y2k-pop",        label: "Y2K Pop",        swatch: ["#FBF6FE", "#F5EFFB", "#FF5FB0"] },
  { id: "pixel-crt",      label: "Pixel CRT",      swatch: ["#3F2EBC", "#1A1466", "#5DE693"] },
  { id: "ai-core",        label: "AI Core",        swatch: ["#0A0B0D", "#101216", "#7FE0A8"] },
  { id: "satellite",      label: "Satellite",      swatch: ["#060D17", "#0B1422", "#2DD4D4"] },
  { id: "unix-90",        label: "Unix '90",       swatch: ["#B8BEC4", "#C4CACF", "#1F6F87"] },
  { id: "neural",         label: "Neural",         swatch: ["#050908", "#0B1311", "#6EFFA8"] },
  { id: "ps2-glow",       label: "PS2 Glow",       swatch: ["#050B1A", "#0E1F38", "#5CC8FF"] },
  { id: "blueprint",      label: "Blueprint",      swatch: ["#0B2545", "#103968", "#E8F4FF"] },
  { id: "cyber-terminal", label: "Cyber Terminal", swatch: ["#1F2014", "#2A2C1B", "#D9D766"] },
  { id: "data-dense",     label: "Data Dense",     swatch: ["#0E1014", "#13161C", "#5DD39E"] },
  { id: "command-palette",label: "Command Palette",swatch: ["#0C0D10", "#13151A", "#A4F0C4"] },
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
