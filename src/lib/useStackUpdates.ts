// Stack-update channel hook (gentle-ai delegate).
//
// Mirrors the shape of `useUpdates` for app/gentle-ai self-update, but the
// truth lives in `gentle-ai update` and we just parse it. This is what
// powers the dynamic "Stack tools" card in Settings → Updates: every tool
// gentle-ai manages (engram, gga, opencode-*, gentle-ai itself) shows up
// here automatically without code changes when upstream adds new ones.
//
// Same 24h cooldown pattern as the other channels, persisted in
// localStorage, plus a cached copy of the last successful result so a fresh
// mount within the cooldown still shows data. Manual "Check now" forces a
// refresh ignoring the cooldown.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./env";

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h
const LS_LAST_CHECKED = "csk-update-stack-last-checked";
// Last successful check RESULT, cached alongside the timestamp. Without it a
// fresh mount within the cooldown would skip the check with `tools` still []
// and the stack table would sit empty until the cooldown expired.
const LS_LAST_TOOLS = "csk-update-stack-last-tools";

export interface StackToolStatus {
  name: string;
  installed: string | null; // null when gentle-ai prints "-"
  latest: string;
  state: "up_to_date" | "update_available" | "not_installed" | string;
}

// `apply_stack_update` result. The upgrade log and the follow-up gentle-ai
// config sync are reported separately: `sync_error` set means the stack
// upgrade itself succeeded but the config sync did not.
export interface StackUpdateOutcome {
  log: string;
  sync_error: string | null;
}

export interface StackUpdatesState {
  tools: StackToolStatus[];
  // True while the initial check (or a manual refresh) is in flight.
  loading: boolean;
  // True while `gentle-ai upgrade` is running across the whole stack.
  applying: boolean;
  // Last error, cleared on next successful operation.
  error: string | null;
  // Raw backend error of the config sync that follows a successful
  // upgrade, or null. Kept apart from `error` so a sync failure never reads
  // as a failed upgrade; SettingsView renders it with its own wording.
  syncError: string | null;

  checkNow: () => void;
  applyAll: () => Promise<void>;
  // Opens gentle-ai's interactive install wizard in a new console window.
  // Same wizard for every `not_installed` row — gentle-ai upstream doesn't
  // expose per-tool install. After the user finishes the wizard, the next
  // "Buscar ahora" refresh picks up the new state.
  openInstallWizard: () => Promise<void>;
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

// Read the cached tools payload. Returns null on missing, corrupt, or
// shape-mismatched data so the caller falls back to a real check.
function readTools(key: string): StackToolStatus[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return null;
    const ok = v.every(
      (t: Partial<StackToolStatus> | null) =>
        typeof t === "object" &&
        t !== null &&
        typeof t.name === "string" &&
        (t.installed === null || typeof t.installed === "string") &&
        typeof t.latest === "string" &&
        typeof t.state === "string"
    );
    return ok ? (v as StackToolStatus[]) : null;
  } catch {
    return null;
  }
}

function writeTools(key: string, value: StackToolStatus[]): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* ignore */
  }
}

export function useStackUpdates(): StackUpdatesState {
  const [tools, setTools] = useState<StackToolStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);
  const ranOnce = useRef(false);

  const runCheck = useCallback(async (force: boolean) => {
    if (!IS_TAURI) {
      setTools([]);
      return;
    }
    const now = Date.now();
    if (!force && now - readNumber(LS_LAST_CHECKED) <= COOLDOWN_MS) {
      const cached = readTools(LS_LAST_TOOLS);
      if (cached) {
        // Within cooldown — hydrate from the cached last result so a fresh
        // mount doesn't sit on an empty table. The cache stores the RAW
        // payload; the opencode-* filter applies at read time, same as the
        // live path below. The user can hit "Check now" for a real refresh.
        setTools(cached.filter((tool) => !tool.name.startsWith("opencode-")));
        return;
      }
      // Cache missing or corrupt — fall through to a real check.
    }
    setLoading(true);
    setError(null);
    try {
      const next = await invoke<StackToolStatus[]>("check_stack_update");
      // This app is a Claude Code companion, but gentle-ai also manages
      // OpenCode editor plugins (opencode-*). Those are noise here — the user
      // doesn't use OpenCode — so they're hidden from the stack list.
      setTools(next.filter((tool) => !tool.name.startsWith("opencode-")));
      writeNumber(LS_LAST_CHECKED, Date.now());
      writeTools(LS_LAST_TOOLS, next);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (ranOnce.current) return;
    ranOnce.current = true;
    void runCheck(false);
  }, [runCheck]);

  const checkNow = useCallback(() => {
    void runCheck(true);
  }, [runCheck]);

  const applyAll = useCallback(async (): Promise<void> => {
    if (!IS_TAURI) return;
    setApplying(true);
    setError(null);
    setSyncError(null);
    try {
      // The upgrade log is discarded — gentle-ai's stdout is already
      // visible to power users via terminal logs, and the post-run version
      // table below is the authoritative state surface for everyone else.
      // The follow-up config sync is reported separately so its failure
      // never reads as a failed upgrade.
      const outcome = await invoke<StackUpdateOutcome>("apply_stack_update");
      // Force-refresh after upgrade so the table reflects new versions.
      await runCheck(true);
      // Stack upgrade can shift gentle-ai version and may have synced its
      // config; nudge the right-panel WorkspaceCard and the drift banners.
      window.dispatchEvent(new Event("csk:workspace-invalidate"));
      window.dispatchEvent(new Event("csk:gentle-ai-synced"));
      setSyncError(outcome.sync_error);
    } catch (e) {
      setError(String(e));
    } finally {
      setApplying(false);
    }
  }, [runCheck]);

  const openInstallWizard = useCallback(async (): Promise<void> => {
    if (!IS_TAURI) return;
    setError(null);
    try {
      await invoke<void>("open_stack_install_wizard");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  return {
    tools,
    loading,
    applying,
    error,
    syncError,
    checkNow,
    applyAll,
    openInstallWizard,
  };
}
