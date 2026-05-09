// Single source of truth for the V3 theme catalog. Both AppV3.tsx (cycle
// shortcut) and views.tsx (theme picker grid) consume this; without it the
// two files drift and a new theme breaks the cycle order.

import { useEffect, useState } from "react";

export const V3_THEME_ORDER = [
  "light",
  "dark",
  "unix-90",
  "ps2-glow",
  "data-dense",
  "manga",
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
  { id: "light",      label: "Light",      swatch: ["#F8F9FB", "#FFFFFF", "#ED7B26"] },
  { id: "dark",       label: "Dark",       swatch: ["#0F172A", "#1E293B", "#ED7B26"] },
  { id: "unix-90",    label: "Unix '90",   swatch: ["#B8BEC4", "#C4CACF", "#1F6F87"] },
  { id: "ps2-glow",   label: "PS2 Glow",   swatch: ["#050B1A", "#0E1F38", "#5CC8FF"] },
  { id: "data-dense", label: "Data Dense", swatch: ["#0E1014", "#13161C", "#5DD39E"] },
  { id: "manga",      label: "Manga",      swatch: ["#E8E3D7", "#F2EEE3", "#C73E3E"] },
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

// React hook for theme-aware components. Subscribes to body's data-theme-v3
// via MutationObserver so callers re-render when the user switches themes
// from Settings or the Cmd+T cycle. We use an observer (not a custom event)
// so any future code path that mutates the attribute works without ceremony.
export function useV3Theme(): V3Theme {
  const [theme, setTheme] = useState<V3Theme>(() => readV3ThemeFromBody());
  useEffect(() => {
    const next = () => setTheme(readV3ThemeFromBody());
    const obs = new MutationObserver(next);
    obs.observe(document.body, {
      attributes: true,
      attributeFilter: ["data-theme-v3"],
    });
    // Catch a race where theme was applied between useState init and effect
    // (e.g. boot script attaches the attribute after first paint).
    next();
    return () => obs.disconnect();
  }, []);
  return theme;
}
