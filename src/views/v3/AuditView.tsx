import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertOctagon,
  AlertTriangle,
  Check,
  Info,
  Loader2,
  MessageSquareCode,
  RefreshCw,
  Wand2,
} from "lucide-react";
import type { AuditAction, AuditFinding } from "../../types";
import { friendlyErrorEn } from "../../lib/format";
import { plural, useT, type StringKey } from "../../lib/i18n";
import { ConfirmModal } from "../../components/v3/ConfirmModal";
import type { V3Tab } from "../../v3/v3types";

// We tag pending findings by `title + category` because the Rust side doesn't
// emit a stable id today and the pair is unique enough in practice (audit
// rules emit at most one finding per category for a given title). Good enough
// to keep two simultaneous resolves on different rows from disabling each
// other's button — and miscolliding is harmless: both rows would just disable
// while one action is in flight.
function findingKey(f: AuditFinding): string {
  return `${f.title}::${f.category}`;
}

// Map an action kind to its i18n label key. Lets each row show a verb that
// matches what the click actually does (e.g. "Show in Explorer" for
// OpenInExplorer, not the generic "Fix" / "Resolver" which lied for
// non-destructive actions).
function resolveLabelKey(kind: AuditAction["kind"] | undefined): StringKey {
  switch (kind) {
    case "open_in_explorer": return "audit.action.open_in_explorer";
    case "open_in_vscode": return "audit.action.open_in_vscode";
    case "navigate_to": return "audit.action.navigate_to";
    case "kill_process": return "audit.action.kill_process";
    case "delete_file": return "audit.action.delete_file";
    case "restore_settings_backup": return "audit.action.restore_settings_backup";
    default: return "audit.resolve";
  }
}

// All the destructive actions share the same modal state shape. We stash the
// finding the user triggered the modal from so we can run the right invoke
// after they confirm — without rebuilding the action from translation keys.
type PendingConfirm = {
  finding: AuditFinding;
  action: Extract<
    AuditAction,
    | { kind: "kill_process" }
    | { kind: "delete_file" }
    | { kind: "restore_settings_backup" }
  >;
};

interface AuditViewProps {
  onJump: (tab: V3Tab) => void;
  /** Findings already fetched at the AppV3 level. */
  findings: AuditFinding[];
  /** True while AppV3's bulk fetch is in flight. */
  loading: boolean;
  /** Bumps AppV3's refreshNonce so the workspace re-fetches. */
  onRefresh: () => void;
}

export function AuditView({
  onJump,
  findings,
  loading,
  onRefresh,
}: AuditViewProps) {
  const { t } = useT();
  // Findings render as a tight terminal-style table across every theme —
  // same data, same actions, same confirm modal. Per-theme palette comes
  // from the v3 token system; layout is uniform.
  const denseLayout = true;
  // findings/loading come from AppV3 props. Previously this view had its
  // own state + run_audit fetch on mount, duplicating what AppV3 had
  // already fetched for Overview. Re-execute via onRefresh which bumps
  // AppV3's refreshNonce.
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "CRIT" | "WARN" | "INFO">("all");
  // Second filter dimension — category (DRIFT, HOOKS, PERMS, SCRIPTS, etc).
  // Categories are derived from the findings themselves so the chips reflect
  // whatever the audit actually emitted; we don't hardcode the catalog. AND'd
  // against the level filter — both must match for a finding to render.
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  // The id of the finding whose action is currently in flight. Exactly one
  // action at a time — we don't queue. The button on every other row stays
  // active so the user can keep working in parallel-ish flow.
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  // Set to a finding key for ~2.5s after a successful action so the row can
  // flash a green "Hecho ✓" pill — without this the user can't tell whether
  // a read-only action like `open_in_vscode` actually fired (the spinner
  // disappears too quickly to register).
  const [recentlyDoneId, setRecentlyDoneId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);
  // Auto-resolver state — single-flight, surfaces a brief result banner.
  const [autoResolving, setAutoResolving] = useState(false);
  const [autoResolveResult, setAutoResolveResult] = useState<string | null>(null);
  // Ask-Claude state — id of the finding whose handoff is in flight, plus
  // the id that just successfully copied its prompt (shows a 2.5s ✓ pill).
  const [askingClaudeId, setAskingClaudeId] = useState<string | null>(null);
  const [askedClaudeId, setAskedClaudeId] = useState<string | null>(null);
  const askedTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Tracks the in-flight "Hecho ✓" pill timer so we can cancel it on unmount
  // (no setState on a dead component) AND when a fresh action fires before
  // the previous timer expired (a stale 2.5s timeout would otherwise wipe
  // the new row's "Done" badge).
  const doneTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Final cleanup — fires only on unmount. The per-action cancellation lives
  // inside runAction so a fast second click clears the prior timer too.
  useEffect(() => {
    return () => {
      if (doneTimeoutRef.current !== null) {
        clearTimeout(doneTimeoutRef.current);
        doneTimeoutRef.current = null;
      }
      if (askedTimeoutRef.current !== null) {
        clearTimeout(askedTimeoutRef.current);
        askedTimeoutRef.current = null;
      }
    };
  }, []);

  const grouped = useMemo(() => {
    const filtered = findings.filter((f) => {
      if (filter !== "all" && f.level !== filter) return false;
      if (categoryFilter !== "all" && f.category !== categoryFilter) return false;
      return true;
    });
    const map = new Map<string, AuditFinding[]>();
    for (const f of filtered) {
      const arr = map.get(f.category) ?? [];
      arr.push(f);
      map.set(f.category, arr);
    }
    return Array.from(map.entries());
  }, [findings, filter, categoryFilter]);

  // Distinct categories present in the current findings, with per-category
  // counts. Sorted by count desc so the most-active category is first. Used
  // to render the second filter chip row only when there are 2+ categories
  // (otherwise the row would be redundant noise).
  const categories = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of findings) {
      counts.set(f.category, (counts.get(f.category) ?? 0) + 1);
    }
    return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
  }, [findings]);

  const counts = useMemo(() => {
    return {
      crit: findings.filter((f) => f.level === "CRIT").length,
      warn: findings.filter((f) => f.level === "WARN").length,
      info: findings.filter((f) => f.level === "INFO").length,
      all: findings.length,
    };
  }, [findings]);

  // Run an action that's already been confirmed (or doesn't need confirmation).
  // Centralized so the spinner state, error surfacing, and post-action refresh
  // all live in one place — every action variant routes through here.
  async function runAction(finding: AuditFinding, action: AuditAction) {
    const id = findingKey(finding);
    setPendingActionId(id);
    setError(null);
    try {
      switch (action.kind) {
        case "navigate_to":
          // Pure UI nav — no Tauri round-trip. Cast is safe at the boundary
          // because the Rust side only ever emits known tab names; if a bad
          // value slips through we'd just navigate to a tab that doesn't
          // exist and the router falls back gracefully.
          onJump(action.tab as V3Tab);
          break;
        case "open_in_explorer":
          await invoke("open_path_in_explorer", { path: action.path });
          break;
        case "open_in_vscode":
          await invoke("open_in_vscode", { path: action.path });
          break;
        case "kill_process":
          await invoke("kill_process", { pid: action.pid });
          onRefresh();
          break;
        case "delete_file":
          // Audit-resolver deletes go through `audit_resolve_delete` — it
          // has an explicit allowlist (currently just settings.local.json)
          // and moves the file to ~/.claude/backups/audit-<ts>/ instead of
          // permanent delete, so the user can recover. `cleanup_apply` was
          // the wrong target: it confines to {logs,backups,projects} and
          // would reject ~/.claude/settings.local.json outright.
          await invoke("audit_resolve_delete", { path: action.path });
          onRefresh();
          break;
        case "restore_settings_backup":
          await invoke("restore_settings_backup");
          onRefresh();
          break;
      }
      // Mark this row as just-completed for ~2.5s so the user gets visible
      // feedback. Cancel any pending timer first — without this, a previous
      // action's still-running timeout would fire and wipe the freshly-set
      // "Done" badge on this row before the user could see it.
      if (doneTimeoutRef.current !== null) {
        clearTimeout(doneTimeoutRef.current);
      }
      setRecentlyDoneId(id);
      doneTimeoutRef.current = setTimeout(() => {
        setRecentlyDoneId((curr) => (curr === id ? null : curr));
        doneTimeoutRef.current = null;
      }, 2500);
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setPendingActionId((curr) => (curr === id ? null : curr));
    }
  }

  // Runs known-safe fixes the audit can apply on its own. Surfaces a one-line
  // result banner that auto-dismisses after 5s.
  async function handleAutoResolve() {
    setAutoResolving(true);
    setAutoResolveResult(null);
    setError(null);
    try {
      const report = await invoke<{
        trimmed_gentle_ai_errors: number;
        deleted_backups: number;
        notes: string[];
      }>("audit_auto_resolve");
      setAutoResolveResult(report.notes.join(" · "));
      setTimeout(() => setAutoResolveResult(null), 5000);
      onRefresh();
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setAutoResolving(false);
    }
  }

  // Opens VS Code at ~/.claude and copies a context-rich prompt to the
  // clipboard so the user can paste it directly into Claude Code. Used on
  // findings where auto-resolve isn't safe (DRIFT/HOOKS/PERMS/SCRIPTS) — and
  // available on every finding row regardless, since "ask Claude" is always
  // a valid alternative to the per-row resolver.
  async function handleAskClaude(finding: AuditFinding) {
    const id = findingKey(finding);
    setAskingClaudeId(id);
    setError(null);
    try {
      const ctx = await invoke<{ prompt: string; opened_path: string }>(
        "audit_open_in_claude",
        {
          title: finding.title,
          level: finding.level,
          category: finding.category,
          detail: finding.detail || null,
          path:
            finding.action && "path" in finding.action
              ? finding.action.path
              : null,
        }
      );
      try {
        await navigator.clipboard.writeText(ctx.prompt);
      } catch {
        // Clipboard write may fail in restricted contexts (no focus, etc.).
        // The VS Code window is already open; the user can re-trigger.
      }
      if (askedTimeoutRef.current !== null) {
        clearTimeout(askedTimeoutRef.current);
      }
      setAskedClaudeId(id);
      askedTimeoutRef.current = setTimeout(() => {
        setAskedClaudeId((curr) => (curr === id ? null : curr));
        askedTimeoutRef.current = null;
      }, 2500);
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setAskingClaudeId((curr) => (curr === id ? null : curr));
    }
  }

  // Entry point for clicks on the per-row resolve button. Decides whether to
  // pop the confirm modal or fire the action immediately. The four destructive
  // ones (kill, delete, restore, reinstall) all gate behind ConfirmModal.
  function handleResolve(finding: AuditFinding) {
    const action = finding.action;
    if (!action) return;
    switch (action.kind) {
      case "kill_process":
      case "delete_file":
      case "restore_settings_backup":
        setConfirm({ finding, action });
        break;
      default:
        void runAction(finding, action);
    }
  }

  // Translate a confirm-needing action into the title/message pair shown in
  // the modal. Kept in a helper so the JSX below stays declarative.
  function confirmStrings(c: PendingConfirm): { title: string; message: string } {
    switch (c.action.kind) {
      case "kill_process":
        return {
          title: t("audit.confirm_kill_title"),
          message: t("audit.confirm_kill_message", { pid: c.action.pid }),
        };
      case "delete_file": {
        // Custom copy when the file being deleted is settings.local.json —
        // the audit's only delete target today. Plain "delete X?" was too
        // generic for users to know whether deleting was safe.
        const isSettingsLocal = c.action.path
          .toLowerCase()
          .endsWith("settings.local.json");
        return isSettingsLocal
          ? {
              title: t("audit.confirm_delete_settings_local_title"),
              message: t("audit.confirm_delete_settings_local_message"),
            }
          : {
              title: t("audit.confirm_delete_title"),
              message: t("audit.confirm_delete_message", { path: c.action.path }),
            };
      }
      case "restore_settings_backup":
        return {
          title: t("audit.confirm_restore_title"),
          message: t("audit.confirm_restore_message"),
        };
    }
  }

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("audit.title")}</h1>
          <p className="v3-subtitle">
            {loading
              ? t("audit.running")
              : plural(t, findings.length, "audit.summary_one", "audit.summary_other")}
          </p>
        </div>
        <div className="v3-view-tools">
          <button
            className="v3-btn-ghost v3-btn-sm"
            onClick={handleAutoResolve}
            disabled={autoResolving || loading}
            title={t("audit.auto_resolve_hint")}
          >
            <Wand2 size={13} strokeWidth={2} />
            {autoResolving ? t("audit.auto_resolving") : t("audit.auto_resolve")}
          </button>
          <button
            className="v3-btn-ghost v3-btn-sm"
            onClick={onRefresh}
          >
            <RefreshCw size={13} strokeWidth={2} />
            {t("audit.rerun")}
          </button>
        </div>
      </header>

      {autoResolveResult && (
        <div className="v3-audit-resolved-banner" role="status">
          <Check size={13} strokeWidth={2.4} />
          <span>{autoResolveResult}</span>
        </div>
      )}

      <div className="v3-filter-row">
        <FilterChip
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label={t("audit.filter_all", { n: counts.all })}
        />
        <FilterChip
          active={filter === "CRIT"}
          onClick={() => setFilter("CRIT")}
          label={t("audit.filter_critical", { n: counts.crit })}
          tint="crit"
        />
        <FilterChip
          active={filter === "WARN"}
          onClick={() => setFilter("WARN")}
          label={t("audit.filter_warning", { n: counts.warn })}
          tint="warn"
        />
        <FilterChip
          active={filter === "INFO"}
          onClick={() => setFilter("INFO")}
          label={t("audit.filter_info", { n: counts.info })}
          tint="info"
        />
      </div>

      {/* Category filter row — only shown when there are 2+ distinct categories
          in the current findings (single-category audits don't need a filter).
          Categories come from the audit emitter, not a hardcoded list, so any
          new category the Rust side adds shows up automatically. */}
      {categories.length > 1 && (
        <div className="v3-filter-row v3-filter-row-cat">
          <FilterChip
            active={categoryFilter === "all"}
            onClick={() => setCategoryFilter("all")}
            label={t("audit.filter_cat_all", { n: findings.length })}
          />
          {categories.map(([cat, n]) => (
            <FilterChip
              key={cat}
              active={categoryFilter === cat}
              onClick={() => setCategoryFilter(cat)}
              label={`${cat} ${n}`}
            />
          ))}
        </div>
      )}

      {error && <div className="v3-error" role="alert" aria-live="assertive">{error}</div>}

      {loading ? (
        <div className="v3-empty">{t("audit.running")}</div>
      ) : grouped.length === 0 ? (
        <div className="v3-empty">
          {findings.length === 0 ? t("audit.clean") : t("audit.no_match")}
        </div>
      ) : denseLayout ? (
        <FindingsTable
          grouped={grouped}
          pendingActionId={pendingActionId}
          recentlyDoneId={recentlyDoneId}
          askingClaudeId={askingClaudeId}
          askedClaudeId={askedClaudeId}
          onResolve={handleResolve}
          onAskClaude={handleAskClaude}
          t={t}
        />
      ) : (
        <div className="v3-audit-groups">
          {grouped.map(([category, items]) => (
            <article key={category} className="v3-card">
              <header className="v3-card-head">
                <h2 className="v3-card-title">{category}</h2>
                <span className="v3-pill v3-pill-soft">{items.length}</span>
              </header>
              <div className="v3-finding-list">
                {items.map((f, i) => {
                  const key = findingKey(f);
                  return (
                    <FindingRow
                      key={`${category}-${i}`}
                      finding={f}
                      pending={pendingActionId === key}
                      done={recentlyDoneId === key}
                      asking={askingClaudeId === key}
                      asked={askedClaudeId === key}
                      onResolve={handleResolve}
                      onAskClaude={handleAskClaude}
                      resolveLabel={t(resolveLabelKey(f.action?.kind))}
                      doneLabel={t("audit.action_done")}
                      askLabel={t("audit.ask_claude")}
                      askingLabel={t("audit.asking_claude")}
                      askedLabel={t("audit.asked_claude")}
                    />
                  );
                })}
              </div>
            </article>
          ))}
        </div>
      )}

      {confirm && (
        <ConfirmModal
          open={true}
          title={confirmStrings(confirm).title}
          message={confirmStrings(confirm).message}
          confirmLabel={t("audit.resolve")}
          cancelLabel={t("common.cancel")}
          danger
          onCancel={() => setConfirm(null)}
          onConfirm={() => {
            const c = confirm;
            setConfirm(null);
            void runAction(c.finding, c.action);
          }}
        />
      )}
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  label,
  tint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  tint?: "crit" | "warn" | "info";
}) {
  return (
    <button
      className={
        "v3-chip" +
        (active ? " active" : "") +
        (tint ? ` v3-chip-${tint}` : "")
      }
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function FindingRow({
  finding,
  pending,
  done,
  asking,
  asked,
  onResolve,
  onAskClaude,
  resolveLabel,
  doneLabel,
  askLabel,
  askingLabel,
  askedLabel,
}: {
  finding: AuditFinding;
  pending: boolean;
  done: boolean;
  asking: boolean;
  asked: boolean;
  onResolve: (f: AuditFinding) => void;
  onAskClaude: (f: AuditFinding) => void;
  resolveLabel: string;
  doneLabel: string;
  askLabel: string;
  askingLabel: string;
  askedLabel: string;
}) {
  const Icon =
    finding.level === "CRIT"
      ? AlertOctagon
      : finding.level === "WARN"
      ? AlertTriangle
      : finding.level === "OK"
      ? Check
      : Info;
  const tint = finding.level.toLowerCase();
  return (
    <div className={`v3-finding v3-finding-${tint}`}>
      <span className={`v3-finding-icon v3-finding-icon-${tint}`} aria-hidden="true">
        <Icon size={14} strokeWidth={2} />
      </span>
      <div className="v3-finding-body">
        <div className="v3-finding-title">{finding.title}</div>
        <div className="v3-finding-detail">{finding.detail}</div>
      </div>
      <button
        type="button"
        className="v3-finding-ask"
        onClick={() => onAskClaude(finding)}
        disabled={asking}
        title={askLabel}
      >
        {asking ? (
          <Loader2 size={12} strokeWidth={2.25} className="v3-finding-resolve-spin" />
        ) : asked ? (
          <Check size={12} strokeWidth={2.5} />
        ) : (
          <MessageSquareCode size={12} strokeWidth={2} />
        )}
        {asking ? askingLabel : asked ? askedLabel : askLabel}
      </button>
      {finding.action && (
        done ? (
          // Transient confirmation pill — replaces the resolve button for
          // ~2.5s after the action completes so the user can tell something
          // happened (especially for read-only actions like opening a file
          // in VS Code, where the app itself doesn't visibly change).
          <span className="v3-finding-done" role="status" aria-live="polite">
            <Check size={12} strokeWidth={2.5} />
            {doneLabel}
          </span>
        ) : (
          <button
            type="button"
            className="v3-finding-resolve"
            onClick={() => onResolve(finding)}
            disabled={pending}
          >
            {pending ? (
              <Loader2 size={12} strokeWidth={2.25} className="v3-finding-resolve-spin" />
            ) : null}
            {resolveLabel}
          </button>
        )
      )}
      <span className={`v3-level-pill v3-level-${tint}`}>{finding.level}</span>
    </div>
  );
}

// Data-dense layout. Renders the same `grouped` data as the cards layout
// above as a tight terminal-style table. Reuses the shared resolve flow
// (handleResolve passed down → confirm modal in parent → runAction). The
// CSS lives under `body[data-theme-v3="data-dense"] .v3-audit-table`.
function FindingsTable({
  grouped,
  pendingActionId,
  recentlyDoneId,
  askingClaudeId,
  askedClaudeId,
  onResolve,
  onAskClaude,
  t,
}: {
  grouped: Array<[string, AuditFinding[]]>;
  pendingActionId: string | null;
  recentlyDoneId: string | null;
  askingClaudeId: string | null;
  askedClaudeId: string | null;
  onResolve: (f: AuditFinding) => void;
  onAskClaude: (f: AuditFinding) => void;
  t: (key: StringKey, vars?: Record<string, string | number>) => string;
}) {
  return (
    <table className="v3-audit-table">
      <thead>
        <tr>
          <th className="v3-audit-th-sev">SEV</th>
          <th className="v3-audit-th-cat">CAT</th>
          <th>HALLAZGO</th>
          <th className="v3-audit-th-act">ACCIÓN</th>
        </tr>
      </thead>
      <tbody>
        {grouped.flatMap(([category, items]) => {
          const rows: ReactNode[] = [
            <tr key={`div-${category}`} className="v3-audit-row-div">
              <td colSpan={4}>
                {category}
                <span className="v3-audit-row-div-n">{items.length}</span>
              </td>
            </tr>,
          ];
          for (let i = 0; i < items.length; i++) {
            const f = items[i];
            const key = findingKey(f);
            const lvl = f.level.toLowerCase();
            const pending = pendingActionId === key;
            const done = recentlyDoneId === key;
            rows.push(
              <tr
                key={`${category}-${i}`}
                className={`v3-audit-row v3-audit-row-${lvl}`}
              >
                <td className={`v3-audit-sev v3-audit-sev-${lvl}`}>{f.level}</td>
                <td className="v3-audit-cat">{f.category}</td>
                <td className="v3-audit-find">
                  <div className="v3-audit-find-title">{f.title}</div>
                  {f.detail && (
                    <div className="v3-audit-find-detail">{f.detail}</div>
                  )}
                </td>
                <td className="v3-audit-act">
                  <div className="v3-audit-act-row">
                    <button
                      type="button"
                      className="v3-audit-btn v3-audit-btn-ask"
                      onClick={() => onAskClaude(f)}
                      disabled={askingClaudeId === key}
                      title={t("audit.ask_claude")}
                    >
                      {askingClaudeId === key ? (
                        <Loader2
                          size={11}
                          strokeWidth={2.25}
                          className="v3-finding-resolve-spin"
                        />
                      ) : askedClaudeId === key ? (
                        <Check size={11} strokeWidth={2.5} />
                      ) : (
                        <MessageSquareCode size={11} strokeWidth={2} />
                      )}
                      {askingClaudeId === key
                        ? t("audit.asking_claude")
                        : askedClaudeId === key
                        ? t("audit.asked_claude")
                        : t("audit.ask_claude")}
                    </button>
                    {f.action ? (
                      done ? (
                        <span className="v3-audit-done" role="status" aria-live="polite">
                          <Check size={11} strokeWidth={2.5} />
                          {t("audit.action_done")}
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="v3-audit-btn"
                          onClick={() => onResolve(f)}
                          disabled={pending}
                        >
                          {pending ? (
                            <Loader2
                              size={11}
                              strokeWidth={2.25}
                              className="v3-finding-resolve-spin"
                            />
                          ) : null}
                          {t(resolveLabelKey(f.action?.kind))}
                        </button>
                      )
                    ) : null}
                  </div>
                </td>
              </tr>
            );
          }
          return rows;
        })}
      </tbody>
    </table>
  );
}
