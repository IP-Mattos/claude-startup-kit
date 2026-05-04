import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertOctagon,
  AlertTriangle,
  Check,
  Info,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { AuditAction, AuditFinding } from "../../types";
import { friendlyErrorEn } from "../../lib/format";
import { parseAuditFindings } from "../../lib/audit";
import { plural, useT } from "../../lib/i18n";
import { ConfirmModal } from "../../components/v3/ConfirmModal";
import type { V3Tab } from "../../v3/v3types";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// We tag pending findings by `title + category` because the Rust side doesn't
// emit a stable id today and the pair is unique enough in practice (audit
// rules emit at most one finding per category for a given title). Good enough
// to keep two simultaneous resolves on different rows from disabling each
// other's button — and miscolliding is harmless: both rows would just disable
// while one action is in flight.
function findingKey(f: AuditFinding): string {
  return `${f.title}::${f.category}`;
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
    | { kind: "reinstall_kit" }
  >;
};

interface AuditViewProps {
  onJump: (tab: V3Tab) => void;
}

export function AuditView({ onJump }: AuditViewProps) {
  const { t } = useT();
  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "CRIT" | "WARN" | "INFO">("all");
  const [refreshNonce, setRefreshNonce] = useState(0);
  // The id of the finding whose action is currently in flight. Exactly one
  // action at a time — we don't queue. The button on every other row stays
  // active so the user can keep working in parallel-ish flow.
  const [pendingActionId, setPendingActionId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<unknown>("run_audit")
      .then(parseAuditFindings)
      .then((res) => !cancelled && setFindings(res))
      .catch((e) => !cancelled && setError(friendlyErrorEn(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  const grouped = useMemo(() => {
    const filtered =
      filter === "all" ? findings : findings.filter((f) => f.level === filter);
    const map = new Map<string, AuditFinding[]>();
    for (const f of filtered) {
      const arr = map.get(f.category) ?? [];
      arr.push(f);
      map.set(f.category, arr);
    }
    return Array.from(map.entries());
  }, [findings, filter]);

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
          setRefreshNonce((n) => n + 1);
          break;
        case "delete_file":
          // Reuse cleanup_apply with a single path — the backend already
          // handles trash/permanent delete semantics there, no need for a
          // second specialized command.
          await invoke("cleanup_apply", { paths: [action.path] });
          setRefreshNonce((n) => n + 1);
          break;
        case "restore_settings_backup":
          await invoke("restore_settings_backup");
          setRefreshNonce((n) => n + 1);
          break;
        case "reinstall_kit":
          await invoke("reinstall_kit");
          setRefreshNonce((n) => n + 1);
          break;
      }
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setPendingActionId((curr) => (curr === id ? null : curr));
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
      case "reinstall_kit":
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
      case "delete_file":
        return {
          title: t("audit.confirm_delete_title"),
          message: t("audit.confirm_delete_message", { path: c.action.path }),
        };
      case "restore_settings_backup":
        return {
          title: t("audit.confirm_restore_title"),
          message: t("audit.confirm_restore_message"),
        };
      case "reinstall_kit":
        return {
          title: t("audit.confirm_reinstall_title"),
          message: t("audit.confirm_reinstall_message"),
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
            onClick={() => setRefreshNonce((n) => n + 1)}
          >
            <RefreshCw size={13} strokeWidth={2} />
            {t("audit.rerun")}
          </button>
        </div>
      </header>

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

      {error && <div className="v3-error" role="alert" aria-live="assertive">{error}</div>}

      {loading ? (
        <div className="v3-empty">{t("audit.running")}</div>
      ) : grouped.length === 0 ? (
        <div className="v3-empty">
          {findings.length === 0 ? t("audit.clean") : t("audit.no_match")}
        </div>
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
                      onResolve={handleResolve}
                      resolveLabel={t("audit.resolve")}
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
  onResolve,
  resolveLabel,
}: {
  finding: AuditFinding;
  pending: boolean;
  onResolve: (f: AuditFinding) => void;
  resolveLabel: string;
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
      {finding.action && (
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
      )}
      <span className={`v3-level-pill v3-level-${tint}`}>{finding.level}</span>
    </div>
  );
}
