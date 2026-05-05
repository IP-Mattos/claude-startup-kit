// Single source of truth for "are we running inside Tauri?".
//
// Tauri APIs throw when loaded from a plain browser at localhost:1420 (no
// __TAURI_INTERNALS__ global). Every view/hook that touches `invoke` guards
// behind this so the UI still renders for previews. Centralized here so the
// detection logic doesn't drift across files.
export const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
