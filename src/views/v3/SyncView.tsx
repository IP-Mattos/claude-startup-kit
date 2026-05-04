import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { friendlyErrorEn } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ConfirmModal } from "../../components/v3/ConfirmModal";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

interface SyncState {
  configured: boolean;
  remote_url: string;
  repo_full_name: string;
  last_sync_at: number | null;
  last_sync_kind: "export" | "import" | null;
  last_error: string | null;
}

interface SyncedProject {
  name: string;
  remote_url: string;
}
interface CloneResult {
  remote_url: string;
  path: string;
  status: "cloned" | "exists" | "error";
  message: string;
}

// Page-level wrapper for SyncCard. The card itself is reusable but lives
// today as its own top-bar tab.
export function SyncView() {
  const { t } = useT();
  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("sync.title")}</h1>
          <p className="v3-subtitle">{t("sync.lead")}</p>
        </div>
      </header>
      <SyncCard />
    </div>
  );
}

function SyncCard() {
  const { t } = useT();
  const [state, setState] = useState<SyncState | null>(null);
  const [repoName, setRepoName] = useState("claude-sync");
  // One spinner per action so the user sees which one's busy.
  const [busy, setBusy] = useState<"setup" | "export" | "import" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<SyncedProject[]>([]);
  const [targetDir, setTargetDir] = useState("");
  // remote_url -> per-row clone status
  const [cloneResults, setCloneResults] = useState<Record<string, CloneResult>>({});
  const [cloningAll, setCloningAll] = useState(false);

  // Pending confirmation. We keep the action ("import" or "disconnect") in
  // state and the modal renders/hides accordingly. The actual side-effect
  // is fired in the modal's `onConfirm` so we can preserve the original
  // happy path of each handler (state, busy flags, error capture).
  const [confirming, setConfirming] = useState<"import" | "disconnect" | null>(
    null,
  );

  // Load both status + listed projects once on mount, and re-fetch
  // projects after every successful sync action.
  const refreshProjects = () => {
    if (!IS_TAURI) return;
    invoke<SyncedProject[]>("sync_listed_projects")
      .then(setProjects)
      .catch(() => setProjects([]));
  };

  useEffect(() => {
    if (!IS_TAURI) return;
    invoke<SyncState>("sync_status")
      .then(setState)
      .catch((e) => setError(friendlyErrorEn(e)));
    refreshProjects();
  }, []);

  const handleSetup = async () => {
    setBusy("setup");
    setError(null);
    try {
      const next = await invoke<SyncState>("sync_setup", { repoName });
      setState(next);
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setBusy(null);
    }
  };

  const handleExport = async () => {
    setBusy("export");
    setError(null);
    try {
      const next = await invoke<SyncState>("sync_export");
      setState(next);
      refreshProjects();
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setBusy(null);
    }
  };

  const runImport = async () => {
    setBusy("import");
    setError(null);
    try {
      const next = await invoke<SyncState>("sync_import");
      setState(next);
      refreshProjects();
      // Reset previous clone statuses so the new list starts clean.
      setCloneResults({});
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setBusy(null);
    }
  };
  const handleImport = () => setConfirming("import");

  // Clone one repo. Updates the per-row map regardless of outcome so
  // the user sees a clear status next to each project.
  const cloneOne = async (p: SyncedProject) => {
    if (!targetDir.trim()) {
      setError(t("sync.target_required"));
      return;
    }
    setCloneResults((prev) => ({
      ...prev,
      [p.remote_url]: {
        remote_url: p.remote_url,
        path: "",
        status: "error",
        message: "...",
      },
    }));
    try {
      const res = await invoke<CloneResult>("clone_project", {
        remoteUrl: p.remote_url,
        targetDir,
        name: p.name,
      });
      setCloneResults((prev) => ({ ...prev, [p.remote_url]: res }));
    } catch (e) {
      setCloneResults((prev) => ({
        ...prev,
        [p.remote_url]: {
          remote_url: p.remote_url,
          path: "",
          status: "error",
          message: friendlyErrorEn(e),
        },
      }));
    }
  };

  const cloneAll = async () => {
    if (!targetDir.trim()) {
      setError(t("sync.target_required"));
      return;
    }
    setCloningAll(true);
    setError(null);
    try {
      // Sequential — concurrent git clones from the same auth context can
      // race the credential helper on Windows.
      for (const p of projects) {
        await cloneOne(p);
      }
    } finally {
      setCloningAll(false);
    }
  };

  const runDisconnect = async () => {
    try {
      await invoke("sync_disconnect");
      setState({
        configured: false,
        remote_url: "",
        repo_full_name: "",
        last_sync_at: null,
        last_sync_kind: null,
        last_error: null,
      });
    } catch (e) {
      setError(friendlyErrorEn(e));
    }
  };
  const handleDisconnect = () => setConfirming("disconnect");

  const lastSyncLabel = state?.last_sync_at
    ? new Date(state.last_sync_at * 1000).toLocaleString()
    : t("sync.never_synced");

  return (
    <article className="v3-card">
      {/* Title + lead live on the SyncView page header now. The card
          starts straight at the configured/setup body. */}
      {state?.configured ? (
        <div className="v3-form">
          <div className="v3-sync-row">
            <span className="v3-sync-row-label">{t("sync.connected_to")}</span>
            <code className="v3-sync-repo">{state.repo_full_name}</code>
          </div>
          <div className="v3-sync-row">
            <span className="v3-sync-row-label">{t("sync.last_sync")}</span>
            <span className="v3-sync-row-value">
              {state.last_sync_at
                ? `${lastSyncLabel} · ${
                    state.last_sync_kind === "export"
                      ? t("sync.last_sync_export")
                      : t("sync.last_sync_import")
                  }`
                : t("sync.never_synced")}
            </span>
          </div>
          <div className="v3-sync-actions">
            <button
              type="button"
              className="v3-update-banner-primary"
              onClick={handleExport}
              disabled={busy !== null}
            >
              {busy === "export" ? t("sync.exporting") : t("sync.export_now")}
            </button>
            <button
              type="button"
              className="v3-btn-ghost v3-sync-btn"
              onClick={handleImport}
              disabled={busy !== null}
            >
              {busy === "import" ? t("sync.importing") : t("sync.import_now")}
            </button>
            <button
              type="button"
              className="v3-link v3-sync-disconnect"
              onClick={handleDisconnect}
              disabled={busy !== null}
            >
              {t("sync.disconnect")}
            </button>
          </div>

          <div className="v3-sync-projects">
            <header className="v3-sync-projects-head">
              <h3 className="v3-sync-projects-title">
                {t("sync.projects_title")}{" "}
                <span className="v3-row-dim">({projects.length})</span>
              </h3>
            </header>
            {projects.length === 0 ? (
              <p className="v3-row-meta">{t("sync.projects_empty")}</p>
            ) : (
              <>
                <p className="v3-row-meta">{t("sync.projects_lead")}</p>
                <label className="v3-form-row">
                  <span className="v3-form-label">{t("sync.target_label")}</span>
                  <input
                    type="text"
                    className="v3-input"
                    value={targetDir}
                    onChange={(e) => setTargetDir(e.target.value)}
                    placeholder={t("sync.target_placeholder")}
                    disabled={cloningAll}
                  />
                </label>
                <div className="v3-sync-actions">
                  <button
                    type="button"
                    className="v3-update-banner-primary"
                    onClick={cloneAll}
                    disabled={cloningAll || !targetDir.trim()}
                  >
                    {cloningAll ? t("sync.cloning") : t("sync.clone_all")}
                  </button>
                </div>
                <ul className="v3-sync-project-list">
                  {projects.map((p) => {
                    const result = cloneResults[p.remote_url];
                    const statusClass =
                      result?.status === "cloned"
                        ? "v3-sync-project-status-ok"
                        : result?.status === "exists"
                        ? "v3-sync-project-status-dim"
                        : result?.status === "error"
                        ? "v3-sync-project-status-crit"
                        : "";
                    const statusLabel =
                      result?.status === "cloned"
                        ? t("sync.clone_status_cloned")
                        : result?.status === "exists"
                        ? t("sync.clone_status_exists")
                        : result?.status === "error"
                        ? t("sync.clone_status_error")
                        : "";
                    return (
                      <li key={p.remote_url} className="v3-sync-project-row">
                        <div className="v3-sync-project-body">
                          <div className="v3-sync-project-name">{p.name}</div>
                          <div className="v3-sync-project-remote">{p.remote_url}</div>
                          {result && (
                            <div className={`v3-sync-project-status ${statusClass}`}>
                              {statusLabel}
                              {result.message && result.status !== "cloned"
                                ? ` · ${result.message}`
                                : ""}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="v3-btn-ghost v3-sync-btn"
                          onClick={() => cloneOne(p)}
                          disabled={cloningAll || !targetDir.trim()}
                        >
                          {t("sync.clone_one")}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="v3-form">
          <label className="v3-form-row">
            <span className="v3-form-label">{t("sync.repo_label")}</span>
            <input
              type="text"
              className="v3-input"
              value={repoName}
              onChange={(e) => setRepoName(e.target.value)}
              placeholder={t("sync.repo_placeholder")}
              disabled={busy !== null}
            />
          </label>
          <p className="v3-row-meta">{t("sync.repo_hint")}</p>
          <div className="v3-sync-actions">
            <button
              type="button"
              className="v3-update-banner-primary"
              onClick={handleSetup}
              disabled={busy !== null || repoName.trim() === ""}
            >
              {busy === "setup" ? t("sync.setting_up") : t("sync.setup")}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      <ConfirmModal
        open={confirming === "import"}
        title={t("sync.confirm_import_title")}
        message={t("sync.confirm_import")}
        confirmLabel={t("common.continue")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => {
          setConfirming(null);
          void runImport();
        }}
        onCancel={() => setConfirming(null)}
      />
      <ConfirmModal
        open={confirming === "disconnect"}
        title={t("sync.confirm_disconnect_title")}
        message={t("sync.confirm_disconnect")}
        confirmLabel={t("common.continue")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => {
          setConfirming(null);
          void runDisconnect();
        }}
        onCancel={() => setConfirming(null)}
      />
    </article>
  );
}
