import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2 } from "lucide-react";
import { friendlyErrorEn } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";
import { ConfirmModal } from "../../components/v3/ConfirmModal";

// Pull the actual repo name out of a clone URL — `https://host/owner/foo.git` → `foo`.
// We use this to render the directory name that will land on disk, which can
// differ from the optional display `name` carried in projects.json.
function repoNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return last.replace(/\.git$/i, "");
  } catch {
    return url
      .split("/")
      .pop()
      ?.replace(/\.git$/i, "") ?? url;
  }
}

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
  // `cloning` is renderer-only — the backend never returns it. We set it
  // optimistically when an invoke is in flight so the row shows a spinner
  // instead of a spurious red "error · ...".
  status: "cloning" | "cloned" | "exists" | "error";
  message: string;
}

interface GhRepo {
  name: string;
  full_name: string;
  description: string;
  url: string;
  clone_url: string;
  updated_at: string;
  is_private: boolean;
}

// Page-level wrapper for SyncCard + GhReposCard. The cards live as
// independent components so the browse-and-clone-all-my-GitHub-repos
// flow works even when sync isn't configured.
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
      <GhReposCard />
    </div>
  );
}

/// Lists every repo the authenticated `gh` user can see and offers a per-row
/// Clone button. Backed by the new `gh_list_repos` IPC. Independent of the
/// Sync card's state — does NOT require sync setup.
function GhReposCard() {
  const { t } = useT();
  const [repos, setRepos] = useState<GhRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [targetDir, setTargetDir] = useState("");
  const [cloneResults, setCloneResults] = useState<Record<string, CloneResult>>(
    {},
  );
  const [query, setQuery] = useState("");

  const refresh = () => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    invoke<GhRepo[]>("gh_list_repos")
      .then(setRepos)
      .catch((e) => setError(friendlyErrorEn(e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
  }, []);

  const pickTargetDir = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("sync.target_picker_title"),
      });
      if (typeof picked === "string" && picked.length > 0) {
        setTargetDir(picked);
      }
    } catch (e) {
      setError(friendlyErrorEn(e));
    }
  };

  const cloneOne = async (r: GhRepo) => {
    const dirName = repoNameFromUrl(r.clone_url);
    setCloneResults((prev) => ({
      ...prev,
      [r.clone_url]: {
        remote_url: r.clone_url,
        path: "",
        status: "cloning",
        message: "",
      },
    }));
    try {
      const res = await invoke<CloneResult>("clone_project", {
        remoteUrl: r.clone_url,
        targetDir,
        name: dirName,
      });
      setCloneResults((prev) => ({ ...prev, [r.clone_url]: res }));
    } catch (e) {
      setCloneResults((prev) => ({
        ...prev,
        [r.clone_url]: {
          remote_url: r.clone_url,
          path: "",
          status: "error",
          message: friendlyErrorEn(e),
        },
      }));
    }
  };

  const filtered = query.trim()
    ? repos.filter((r) => {
        const q = query.trim().toLowerCase();
        return (
          r.name.toLowerCase().includes(q) ||
          r.full_name.toLowerCase().includes(q) ||
          r.description.toLowerCase().includes(q)
        );
      })
    : repos;

  return (
    <article className="v3-card">
      <header className="v3-card-head">
        <h2 className="v3-card-title">{t("sync.gh_repos_title")}</h2>
        <div className="v3-card-actions">
          <button
            type="button"
            className="v3-link"
            onClick={refresh}
            disabled={loading}
          >
            {loading ? t("settings.checking") : t("settings.check_now")}
          </button>
        </div>
      </header>
      <div className="v3-form">
        <p className="v3-row-meta">{t("sync.gh_repos_lead")}</p>
        {error && (
          <div className="v3-error" role="alert" aria-live="assertive">
            {error}
          </div>
        )}
        {!error && (
          <>
            <div className="v3-form-row">
              <span className="v3-form-label">{t("sync.target_label")}</span>
              <div className="v3-input-with-action">
                <input
                  type="text"
                  className="v3-input"
                  value={targetDir}
                  onChange={(e) => setTargetDir(e.target.value)}
                  placeholder={t("sync.target_placeholder")}
                  readOnly
                />
                <button
                  type="button"
                  className="v3-btn-ghost v3-btn-sm"
                  onClick={() => {
                    void pickTargetDir();
                  }}
                >
                  <FolderOpen size={13} strokeWidth={2} />
                  {t("sync.target_pick")}
                </button>
              </div>
            </div>
            <div className="v3-search">
              <input
                type="text"
                className="v3-input"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("sync.gh_repos_search_placeholder")}
              />
            </div>
            {loading ? (
              <p className="v3-row-meta">{t("common.loading")}</p>
            ) : filtered.length === 0 ? (
              <p className="v3-row-meta">
                {repos.length === 0
                  ? t("sync.gh_repos_empty")
                  : t("sync.gh_repos_empty_search")}
              </p>
            ) : (
              <ul className="v3-sync-project-list">
                {filtered.map((r) => {
                  const result = cloneResults[r.clone_url];
                  const isCloning = result?.status === "cloning";
                  const statusClass =
                    result?.status === "cloned"
                      ? "v3-sync-project-status-ok"
                      : result?.status === "exists"
                        ? "v3-sync-project-status-dim"
                        : result?.status === "cloning"
                          ? "v3-sync-project-status-dim"
                          : result?.status === "error"
                            ? "v3-sync-project-status-crit"
                            : "";
                  const statusLabel =
                    result?.status === "cloned"
                      ? t("sync.clone_status_cloned")
                      : result?.status === "exists"
                        ? t("sync.clone_status_exists")
                        : result?.status === "cloning"
                          ? t("sync.clone_status_cloning")
                          : result?.status === "error"
                            ? t("sync.clone_status_error")
                            : "";
                  return (
                    <li key={r.clone_url} className="v3-sync-project-row">
                      <div className="v3-sync-project-body">
                        <div className="v3-sync-project-name">
                          {r.name}
                          {r.is_private && (
                            <span className="v3-pill v3-pill-soft">
                              {t("sync.gh_repo_private")}
                            </span>
                          )}
                        </div>
                        <div className="v3-sync-project-alias">
                          {r.full_name}
                        </div>
                        {r.description && (
                          <div className="v3-row-meta">{r.description}</div>
                        )}
                        {result && (
                          <div className={`v3-sync-project-status ${statusClass}`}>
                            {isCloning && (
                              <Loader2
                                size={11}
                                strokeWidth={2.5}
                                className="v3-spin"
                              />
                            )}
                            {statusLabel}
                            {result.message &&
                            result.status !== "cloned" &&
                            result.status !== "cloning"
                              ? ` · ${result.message}`
                              : ""}
                          </div>
                        )}
                      </div>
                      <button
                        type="button"
                        className="v3-btn-ghost v3-sync-btn"
                        onClick={() => cloneOne(r)}
                        disabled={isCloning || !targetDir.trim()}
                      >
                        {isCloning
                          ? t("sync.clone_status_cloning")
                          : t("sync.clone_one")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}
      </div>
    </article>
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

  // GitHub login of the authenticated `gh` user — fetched once when the
  // sync setup form is visible so we can show a live preview of the full
  // repo path that's about to be created. Empty string = not authed yet.
  const [ghUser, setGhUser] = useState<string>("");

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
    // Preview the GitHub login for the setup form. Best-effort — if `gh`
    // isn't authed we just leave the preview empty.
    invoke<string>("gh_username")
      .then(setGhUser)
      .catch(() => setGhUser(""));
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

  // Clone one repo. Updates the per-row map regardless of outcome so the user
  // sees a clear status next to each project. The "Clone" button is already
  // gated on `targetDir.trim()` from the JSX, so we don't re-check here —
  // the previous redundant guard set an error string the user couldn't see
  // (the disabled button never fired the handler).
  //
  // We use the actual directory name git creates on disk (derived from the
  // clone URL) instead of the optional display `name` from projects.json,
  // because the backend used to write `<targetDir>/<display name>` which
  // produced confusing folders like "PolyMarket" pointing at PolyTry.git.
  const cloneOne = async (p: SyncedProject) => {
    const dirName = repoNameFromUrl(p.remote_url);
    setCloneResults((prev) => ({
      ...prev,
      [p.remote_url]: {
        remote_url: p.remote_url,
        path: "",
        status: "cloning",
        message: "",
      },
    }));
    try {
      const res = await invoke<CloneResult>("clone_project", {
        remoteUrl: p.remote_url,
        targetDir,
        name: dirName,
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

  const pickTargetDir = async () => {
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("sync.target_picker_title"),
      });
      if (typeof picked === "string" && picked.length > 0) {
        setTargetDir(picked);
      }
    } catch (e) {
      setError(friendlyErrorEn(e));
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
                <div className="v3-form-row">
                  <span className="v3-form-label">{t("sync.target_label")}</span>
                  <div className="v3-input-with-action">
                    <input
                      type="text"
                      className="v3-input"
                      value={targetDir}
                      onChange={(e) => setTargetDir(e.target.value)}
                      placeholder={t("sync.target_placeholder")}
                      disabled={cloningAll}
                      readOnly
                    />
                    <button
                      type="button"
                      className="v3-btn-ghost v3-btn-sm"
                      onClick={() => {
                        void pickTargetDir();
                      }}
                      disabled={cloningAll}
                    >
                      <FolderOpen size={13} strokeWidth={2} />
                      {t("sync.target_pick")}
                    </button>
                  </div>
                </div>
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
                        : result?.status === "cloning"
                        ? "v3-sync-project-status-dim"
                        : result?.status === "error"
                        ? "v3-sync-project-status-crit"
                        : "";
                    const statusLabel =
                      result?.status === "cloned"
                        ? t("sync.clone_status_cloned")
                        : result?.status === "exists"
                        ? t("sync.clone_status_exists")
                        : result?.status === "cloning"
                        ? t("sync.clone_status_cloning")
                        : result?.status === "error"
                        ? t("sync.clone_status_error")
                        : "";
                    const realName = repoNameFromUrl(p.remote_url);
                    // Show the on-disk directory name as the primary label
                    // (it's what the user will actually see in Explorer).
                    // The display name from projects.json appears as a hint
                    // only when it differs.
                    const showDisplayHint =
                      p.name && p.name.toLowerCase() !== realName.toLowerCase();
                    const isCloning = result?.status === "cloning";
                    return (
                      <li key={p.remote_url} className="v3-sync-project-row">
                        <div className="v3-sync-project-body">
                          <div className="v3-sync-project-name">{realName}</div>
                          {showDisplayHint && (
                            <div className="v3-sync-project-alias">
                              {t("sync.alias_label")}: {p.name}
                            </div>
                          )}
                          <div className="v3-sync-project-remote">{p.remote_url}</div>
                          {result && (
                            <div className={`v3-sync-project-status ${statusClass}`}>
                              {isCloning && (
                                <Loader2
                                  size={11}
                                  strokeWidth={2.5}
                                  className="v3-spin"
                                />
                              )}
                              {statusLabel}
                              {result.message &&
                              result.status !== "cloned" &&
                              result.status !== "cloning"
                                ? ` · ${result.message}`
                                : ""}
                            </div>
                          )}
                        </div>
                        <button
                          type="button"
                          className="v3-btn-ghost v3-sync-btn"
                          onClick={() => cloneOne(p)}
                          disabled={cloningAll || isCloning || !targetDir.trim()}
                        >
                          {isCloning
                            ? t("sync.clone_status_cloning")
                            : t("sync.clone_one")}
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
          {repoName.trim() !== "" && (
            <p className="v3-row-meta">
              {ghUser
                ? t("sync.repo_preview", {
                    full: `${ghUser}/${repoName.trim()}`,
                  })
                : t("sync.repo_preview_no_user", { name: repoName.trim() })}
            </p>
          )}
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
