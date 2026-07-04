// Update channel hook.
//
// Surfaces two independent update sources to the UI:
//   • app — this Tauri app, GitHub releases on IP-Mattos/claude-startup-kit.
//   • gentleAi — the gentle-ai CLI, GitHub releases on
//     Gentleman-Programming/gentle-ai. We can also re-run its installer.
//
// Both checks share a 24h cooldown stored in localStorage. The cooldown is
// per-channel so a manual "Check now" can refresh just one. The last
// successful result is cached (per-channel) so a fresh mount within the
// cooldown still hydrates state instead of showing "Loading…". Dismissed
// versions are remembered (per-channel) so a user who clicks "Later" doesn't
// see the same banner forever.
//
// All Tauri IPC is gated behind IS_TAURI; in plain browser preview the hook
// resolves to "not configured" everywhere.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./env";

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h
const LS_LAST_APP = "csk-update-app-last-checked";
const LS_LAST_GA = "csk-update-gentle-ai-last-checked";
const LS_DISMISS_APP = "csk-update-app-dismissed-version";
const LS_DISMISS_GA = "csk-update-gentle-ai-dismissed-version";
// Last successful check RESULTS, cached alongside the timestamps. Without
// these a fresh mount within the cooldown would skip the check AND leave
// state null — Settings stuck on "Loading…" and the update banner gone
// until the cooldown expired.
const LS_STATUS_APP = "csk-update-app-last-status";
const LS_STATUS_GA = "csk-update-gentle-ai-last-status";

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
  // True while the auto-updater is actively downloading + installing the
  // app's own update. Surfaced separately so the banner can show "Updating…"
  // instead of the regular "Apply" CTA.
  applyingApp: boolean;
  // Per-channel last error. Split because the two channels run independently;
  // a transient gentle-ai failure used to clobber a still-relevant app-update
  // error (and vice versa) when both shared a single string.
  appError: string | null;
  gentleAiError: string | null;
  // Imperative actions.
  checkNow: () => void;
  // Triggers atomic auto-update: download + verify signature + replace
  // binary + restart. On the happy path this resolves AFTER the new process
  // has taken over (the call never actually returns in practice). On error
  // the promise rejects and `appError` is populated.
  applyApp: () => Promise<void>;
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

// Read a cached UpdateStatus payload. Returns null on missing, corrupt, or
// shape-mismatched data so the caller falls back to a real check instead of
// rendering garbage.
function readStatus(key: string): UpdateStatus | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<UpdateStatus> | null;
    if (
      typeof v !== "object" ||
      v === null ||
      typeof v.available !== "boolean" ||
      typeof v.current !== "string" ||
      typeof v.latest !== "string" ||
      typeof v.release_url !== "string" ||
      typeof v.notes !== "string" ||
      typeof v.configured !== "boolean"
    ) {
      return null;
    }
    return v as UpdateStatus;
  } catch {
    return null;
  }
}

function writeStatus(key: string, value: UpdateStatus): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
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
  const [applyingApp, setApplyingApp] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [gentleAiError, setGentleAiError] = useState<string | null>(null);
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
    const now = Date.now();
    const dismissApp = readString(LS_DISMISS_APP);
    const dismissGa = readString(LS_DISMISS_GA);

    const tasks: Promise<void>[] = [];

    // Per channel: within cooldown, hydrate state from the cached last
    // result instead of leaving it null. The cache stores the RAW status;
    // dismissal is applied at read time, same as the live path. A missing
    // or corrupt cache falls back to a real check.
    let checkApp = force || now - readNumber(LS_LAST_APP) > COOLDOWN_MS;
    if (!checkApp) {
      const cached = readStatus(LS_STATUS_APP);
      if (cached) {
        setApp(applyDismissal(cached, dismissApp));
      } else {
        checkApp = true;
      }
    }
    if (checkApp) {
      setAppError(null);
      tasks.push(
        invoke<UpdateStatus>("check_app_update")
          .then((s) => {
            setApp(applyDismissal(s, dismissApp));
            writeNumber(LS_LAST_APP, Date.now());
            writeStatus(LS_STATUS_APP, s);
          })
          .catch((e) => setAppError(String(e)))
      );
    }

    let checkGa = force || now - readNumber(LS_LAST_GA) > COOLDOWN_MS;
    if (!checkGa) {
      const cached = readStatus(LS_STATUS_GA);
      if (cached) {
        setGentleAi(applyDismissal(cached, dismissGa));
      } else {
        checkGa = true;
      }
    }
    if (checkGa) {
      setGentleAiError(null);
      tasks.push(
        invoke<UpdateStatus>("check_gentle_ai_update")
          .then((s) => {
            setGentleAi(applyDismissal(s, dismissGa));
            writeNumber(LS_LAST_GA, Date.now());
            writeStatus(LS_STATUS_GA, s);
          })
          .catch((e) => setGentleAiError(String(e)))
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

  const applyApp = useCallback(async (): Promise<void> => {
    if (!IS_TAURI) return;
    setApplyingApp(true);
    setAppError(null);
    try {
      await invoke<void>("apply_app_update");
      // The Rust handler calls app.restart() on success, so this point is
      // typically unreachable. We clear the flag defensively in case the
      // restart fails or is a no-op on some future platform.
    } catch (e) {
      setAppError(String(e));
    } finally {
      setApplyingApp(false);
    }
  }, []);

  const applyGentleAi = useCallback(async (): Promise<string | null> => {
    if (!IS_TAURI) return null;
    setChecking(true);
    setGentleAiError(null);
    try {
      const newVersion = await invoke<string>("apply_gentle_ai_update");
      // Re-check both channels after a successful upgrade.
      await runChecks(true);
      // Tell the WorkspaceCard to re-fetch — backend cache was already
      // busted by the IPC, but the card's mount-time effect needs a kick
      // to actually re-call workspace_summary.
      window.dispatchEvent(new Event("csk:workspace-invalidate"));
      return newVersion;
    } catch (e) {
      setGentleAiError(String(e));
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
    applyingApp,
    appError,
    gentleAiError,
    checkNow,
    applyApp,
    applyGentleAi,
    dismissApp,
    dismissGentleAi,
  };
}
