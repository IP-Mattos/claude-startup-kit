// Stack-update channel hook (gentle-ai delegate).
//
// Mirrors the shape of `useUpdates` for app/gentle-ai self-update, but the
// truth lives in `gentle-ai update` and we just parse it. This is what
// powers the dynamic "Stack tools" card in Settings → Updates: every tool
// gentle-ai manages (engram, gga, opencode-*, gentle-ai itself) shows up
// here automatically without code changes when upstream adds new ones.
//
// Same 24h cooldown pattern as the other channels, persisted in
// localStorage. Manual "Check now" forces a refresh ignoring the cooldown.

import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_TAURI } from "./env";

const COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24h
const LS_LAST_CHECKED = "csk-update-stack-last-checked";

export interface StackToolStatus {
  name: string;
  installed: string | null; // null when gentle-ai prints "-"
  latest: string;
  state: "up_to_date" | "update_available" | "not_installed" | string;
}

export interface StackUpdatesState {
  tools: StackToolStatus[];
  // True while the initial check (or a manual refresh) is in flight.
  loading: boolean;
  // True while `gentle-ai upgrade` is running across the whole stack.
  applying: boolean;
  // Last error, cleared on next successful operation.
  error: string | null;

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

export function useStackUpdates(): StackUpdatesState {
  const [tools, setTools] = useState<StackToolStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ranOnce = useRef(false);

  const runCheck = useCallback(async (force: boolean) => {
    if (!IS_TAURI) {
      setTools([]);
      return;
    }
    const now = Date.now();
    if (!force && now - readNumber(LS_LAST_CHECKED) <= COOLDOWN_MS) {
      // Within cooldown — keep whatever's already in state. Don't fight the
      // cooldown by re-fetching; the user can hit "Check now" if they want.
      return;
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
    try {
      // The upgrade output is discarded — gentle-ai's stdout is already
      // visible to power users via terminal logs, and the post-run version
      // table below is the authoritative state surface for everyone else.
      await invoke<string>("apply_stack_update");
      // Force-refresh after upgrade so the table reflects new versions.
      await runCheck(true);
      // Stack upgrade can shift gentle-ai version; nudge the
      // right-panel WorkspaceCard.
      window.dispatchEvent(new Event("csk:workspace-invalidate"));
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
    checkNow,
    applyAll,
    openInstallWizard,
  };
}
