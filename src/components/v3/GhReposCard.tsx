import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2 } from "lucide-react";
import { friendlyErrorEn } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";

// Pull the actual repo name out of a clone URL — `https://host/owner/foo.git`
// → `foo`. Used to render the directory name that will land on disk.
function repoNameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return last.replace(/\.git$/i, "");
  } catch {
    return url.split("/").pop()?.replace(/\.git$/i, "") ?? url;
  }
}

interface CloneResult {
  remote_url: string;
  path: string;
  // `cloning` is renderer-only — set optimistically while an invoke is in
  // flight so the row shows a spinner instead of a spurious error.
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

/// Lists every repo the authenticated `gh` user can see and offers a per-row
/// Clone button. Backed by the `gh_list_repos` IPC. Self-contained — lives on
/// the Projects tab (cloning a repo IS a project action). Independent of any
/// sync configuration.
export function GhReposCard() {
  const { t } = useT();
  const [repos, setRepos] = useState<GhRepo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [targetDir, setTargetDir] = useState("");
  const [cloneResults, setCloneResults] = useState<Record<string, CloneResult>>({});
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
      [r.clone_url]: { remote_url: r.clone_url, path: "", status: "cloning", message: "" },
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
          <button type="button" className="v3-link" onClick={refresh} disabled={loading}>
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
                        <div className="v3-sync-project-alias">{r.full_name}</div>
                        {r.description && <div className="v3-row-meta">{r.description}</div>}
                        {result && (
                          <div className={`v3-sync-project-status ${statusClass}`}>
                            {isCloning && (
                              <Loader2 size={11} strokeWidth={2.5} className="v3-spin" />
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
                        {isCloning ? t("sync.clone_status_cloning") : t("sync.clone_one")}
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
