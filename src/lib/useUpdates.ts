// Update channel hook.
//
// Surfaces two independent update sources to the UI:
//   • app — this Tauri app, GitHub releases on IP-Mattos/claude-startup-kit.
//   • gentleAi — the gentle-ai CLI, GitHub releases on
//     Gentleman-Programming/gentle-ai. We can also re-run its installer.
//
// Both checks share a 24h cooldown stored in localStorage. The cooldown is
// per-channel so a manual "Check now" can refresh just one. Dismissed
// versions are remembered (per-channel) so a user who clicks "Later" doesn't
// see the same banner forever.
//
// All Tauri IPC is gated behind IS_TAURI; in plain browser preview the hook
// resolves to "not configured" everywhere.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h
const LS_LAST_APP = "csk-update-app-last-checked";
const LS_LAST_GA = "csk-update-gentle-ai-last-checked";
const LS_DISMISS_APP = "csk-update-app-dismissed-version";
const LS_DISMISS_GA = "csk-update-gentle-ai-dismissed-version";

export interface UpdateStatus {
  available: boolean;
  current: string;
  latest: string;
  release_url: string;
  notes: string;
  configured: boolean;
}

export interface UpdatesState {
  app: UpdateStatus | null;
  gentleAi: UpdateStatus | null;
  // True while ANY check is in flight; UI uses this to disable the manual
  // "Check now" button.
  checking: boolean;
  // Last error from a failed check, if any. Cleared on the next successful
  // check.
  error: string | null;
  // Imperative actions.
  checkNow: () => void;
  applyGentleAi: () => Promise<string | null>;
  dismissApp: (version: string) => void;
  dismissGentleAi: (version: string) => void;
}

function readNumber(key: string): number {
  try {
    const v = parseInt(localStorage.getItem(key) ?? "", 10);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

function writeNumber(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore */
  }
}

function readString(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeString(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* ignore */
  }
}

// Hide an UpdateStatus that the user already dismissed at the same version.
// We never hide the underlying truth — just the `available` flag — so the
// Settings page can still show "v1.2.3 → v1.2.4 (dismissed)" if we want
// later. For now we just zero out availability.
function applyDismissal(s: UpdateStatus | null, dismissed: string): UpdateStatus | null {
  if (!s || !s.available) return s;
  if (dismissed && dismissed === s.latest) {
    return { ...s, available: false };
  }
  return s;
}

export function useUpdates(): UpdatesState {
  const [app, setApp] = useState<UpdateStatus | null>(null);
  const [gentleAi, setGentleAi] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Avoid re-running on StrictMode double-mount in dev.
  const ranOnce = useRef(false);

  const runChecks = useCallback(async (force: boolean) => {
    if (!IS_TAURI) {
      setApp({
        available: false,
        current: "",
        latest: "",
        release_url: "",
        notes: "",
        configured: false,
      });
      setGentleAi({
        available: false,
        current: "",
        latest: "",
        release_url: "",
        notes: "",
        configured: false,
      });
      return;
    }
    setChecking(true);
    setError(null);
    const now = Date.now();
    const dismissApp = readString(LS_DISMISS_APP);
    const dismissGa = readString(LS_DISMISS_GA);

    const tasks: Promise<void>[] = [];

    if (force || now - readNumber(LS_LAST_APP) > COOLDOWN_MS) {
      tasks.push(
        invoke<UpdateStatus>("check_app_update")
          .then((s) => {
            setApp(applyDismissal(s, dismissApp));
            writeNumber(LS_LAST_APP, Date.now());
          })
          .catch((e) => setError(String(e)))
      );
    }

    if (force || now - readNumber(LS_LAST_GA) > COOLDOWN_MS) {
      tasks.push(
        invoke<UpdateStatus>("check_gentle_ai_update")
          .then((s) => {
            setGentleAi(applyDismissal(s, dismissGa));
            writeNumber(LS_LAST_GA, Date.now());
          })
          .catch((e) => setError(String(e)))
      );
    }

    await Promise.all(tasks);
    setChecking(false);
  }, []);

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    void runChecks(false);
  }, [runChecks]);

  const checkNow = useCallback(() => {
    void runChecks(true);
  }, [runChecks]);

  const applyGentleAi = useCallback(async (): Promise<string | null> => {
    if (!IS_TAURI) return null;
    setChecking(true);
    try {
      const newVersion = await invoke<string>("apply_gentle_ai_update");
      // Re-check both channels after a successful upgrade.
      await runChecks(true);
      return newVersion;
    } catch (e) {
      setError(String(e));
      return null;
    } finally {
      setChecking(false);
    }
  }, [runChecks]);

  const dismissApp = useCallback((version: string) => {
    writeString(LS_DISMISS_APP, version);
    setApp((s) => (s ? { ...s, available: false } : s));
  }, []);

  const dismissGentleAi = useCallback((version: string) => {
    writeString(LS_DISMISS_GA, version);
    setGentleAi((s) => (s ? { ...s, available: false } : s));
  }, []);

  return {
    app,
    gentleAi,
    checking,
    error,
    checkNow,
    applyGentleAi,
    dismissApp,
    dismissGentleAi,
  };
}
