import { useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, GitBranch, Info, Search } from "lucide-react";
import type { GitInfo, Project, ProjectEnrichment } from "../../types";
import {
  activityLabelT,
  friendlyErrorEn,
  projectName,
} from "../../lib/format";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useT } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";

interface DiskGitRepo {
  path: string;
  name: string;
  remote: string;
}

interface ProjectsViewProps {
  /** Claude-Code-active projects already fetched at the AppV3 level. */
  projects: Project[];
  /** Full enrichment (goal + git) keyed by project path — also from AppV3. */
  enrichment: Record<string, ProjectEnrichment>;
  /** True while AppV3's bulk fetch is in flight. */
  loading: boolean;
  /** Lifted dropdown state — drives AppV3's scan_projects call. */
  windowDays: number;
  setWindowDays: (n: number) => void;
}

export function ProjectsView({
  projects,
  enrichment,
  loading,
  windowDays,
  setWindowDays,
}: ProjectsViewProps) {
  const { t } = useT();
  // projects/enrichment/loading/windowDays now come from AppV3 props.
  // Previously this view had its own scan_projects + enrichProjects
  // fetch, duplicating what AppV3 did for Overview. AppV3's effect now
  // depends on windowDays so dropdown changes still re-fetch — just
  // once, shared with Overview.
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Disk-scan results — repos found by walking common dev parent dirs for
  // `.git/`. Distinct from the JSONL-driven `projects` list above: this
  // surface includes repos the user has on disk but hasn't touched with
  // Claude Code recently. Empty until the user clicks "Buscar más".
  const [diskRepos, setDiskRepos] = useState<DiskGitRepo[]>([]);
  const [diskScanRunning, setDiskScanRunning] = useState(false);
  const [diskScanError, setDiskScanError] = useState<string | null>(null);
  const [diskScanRan, setDiskScanRan] = useState(false);

  const debouncedQuery = useDebouncedValue(query);
  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter(
      (p) =>
        projectName(p.path).toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q)
    );
  }, [projects, debouncedQuery]);

  const open = (path: string) =>
    invoke("open_in_vscode", { path }).catch((e) => setError(friendlyErrorEn(e)));
  const openExplorer = (path: string) =>
    invoke("open_path_in_explorer", { path }).catch((e) =>
      setError(friendlyErrorEn(e))
    );

  // Trigger the disk walk. We resolve sensible default roots from the
  // backend (Desktop/Code, OneDrive/Desktop, etc. — only those that
  // exist), then walk each one. Sequential UX: button shows "Buscando…"
  // until the walk finishes.
  const runDiskScan = async () => {
    if (!IS_TAURI) return;
    setDiskScanRunning(true);
    setDiskScanError(null);
    try {
      const roots = await invoke<string[]>("default_disk_scan_roots");
      // Run disk scan + VS Code workspace folder lookup in parallel.
      // VS Code keeps a perfect list of every folder you've ever opened
      // — surface those too so the Projects view stops missing folders
      // the user works in but never ran `claude` inside.
      const [found, vsFolders] = await Promise.all([
        invoke<DiskGitRepo[]>("disk_scan_git_repos", { roots, maxDepth: 4 }),
        invoke<string[]>("vscode_workspace_folders").catch(() => [] as string[]),
      ]);
      // Convert VS Code folder paths to the same DiskGitRepo shape so the
      // existing render path works unchanged. `remote` stays empty — VS
      // Code's storage doesn't track git remotes.
      const vsRepos: DiskGitRepo[] = vsFolders.map((p) => {
        const segments = p.split(/[\\/]/).filter(Boolean);
        const name = segments[segments.length - 1] || p;
        return { path: p, name, remote: "" };
      });
      // Union + dedupe by canonical path (case-insensitive on Windows).
      // Filter out anything already in the Claude-active list so we
      // don't show the same row twice.
      const claudeSeen = new Set(
        projects.map((p) => p.path.toLowerCase().replace(/\\/g, "/"))
      );
      const merged = new Map<string, DiskGitRepo>();
      for (const r of [...found, ...vsRepos]) {
        const key = r.path.toLowerCase().replace(/\\/g, "/");
        if (claudeSeen.has(key)) continue;
        if (!merged.has(key)) merged.set(key, r);
      }
      setDiskRepos(Array.from(merged.values()));
      setDiskScanRan(true);
    } catch (e) {
      setDiskScanError(friendlyErrorEn(e));
    } finally {
      setDiskScanRunning(false);
    }
  };

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("projects.title")}</h1>
          <p className="v3-subtitle">
            {loading
              ? t("projects.scanning")
              : t(
                  projects.length === 1
                    ? "projects.summary_one"
                    : "projects.summary_other",
                  {
                    filtered: filtered.length,
                    total: projects.length,
                    days: windowDays,
                  }
                )}
          </p>
        </div>
        <div className="v3-view-tools">
          <select
            className="v3-select"
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            aria-label={t("projects.time_window")}
          >
            <option value={7}>{t("projects.window_7d")}</option>
            <option value={14}>{t("projects.window_14d")}</option>
            <option value={30}>{t("projects.window_30d")}</option>
            <option value={90}>{t("projects.window_90d")}</option>
          </select>
        </div>
      </header>

      <div className="v3-search">
        <Search size={14} strokeWidth={2} />
        <input
          type="text"
          placeholder={t("projects.search_placeholder")}
          aria-label={t("projects.search_aria")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      {loading ? (
        <div className="v3-empty">{t("projects.loading")}</div>
      ) : filtered.length === 0 ? (
        <div className="v3-empty">
          {projects.length === 0
            ? t("projects.empty_window", { days: windowDays })
            : t("projects.empty_search", { q: query })}
        </div>
      ) : (
        <div className="v3-list">
          {filtered.map((p) => {
            const goal = enrichment[p.path]?.goal ?? null;
            const git = enrichment[p.path]?.git ?? null;
            return (
              <ProjectListRow
                key={p.path}
                project={p}
                goal={goal}
                git={git}
                onOpen={() => open(p.path)}
                onOpenExplorer={() => openExplorer(p.path)}
              />
            );
          })}
        </div>
      )}

      {/* Disk scan section — surfaces git repos on disk that don't have
          recent Claude Code activity. Hidden until the user clicks Buscar,
          since the walk can take a few seconds on large trees. */}
      <div className="v3-section-divider">
        <h2 className="v3-section-title">
          <GitBranch size={14} strokeWidth={2} />
          {t("projects.disk_scan_title")}
        </h2>
        <button
          type="button"
          className="v3-link"
          onClick={() => {
            void runDiskScan();
          }}
          disabled={diskScanRunning}
        >
          {diskScanRunning
            ? t("projects.disk_scan_running")
            : diskScanRan
              ? t("projects.disk_scan_rerun")
              : t("projects.disk_scan_run")}
        </button>
      </div>
      {diskScanError && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {diskScanError}
        </div>
      )}
      {!diskScanError && (
        <p className="v3-row-meta">{t("projects.disk_scan_lead")}</p>
      )}
      {diskScanRan && !diskScanError && diskRepos.length === 0 && (
        <div className="v3-empty">{t("projects.disk_scan_empty")}</div>
      )}
      {diskRepos.length > 0 && (
        <div className="v3-list">
          {diskRepos.map((r) => (
            <article key={r.path} className="v3-row v3-row-project">
              <div className="v3-row-icon" aria-hidden="true">
                <GitBranch size={16} strokeWidth={2} />
              </div>
              <div className="v3-row-body">
                <div className="v3-row-title">{r.name}</div>
                <div className="v3-row-meta">
                  <span className="v3-row-path" title={r.path}>
                    {r.path}
                  </span>
                </div>
                {r.remote && (
                  <div className="v3-row-meta">
                    <span className="v3-row-dim">{r.remote}</span>
                  </div>
                )}
              </div>
              <div className="v3-row-end">
                <div className="v3-row-actions">
                  <button
                    className="v3-btn-primary v3-btn-sm"
                    onClick={() => open(r.path)}
                  >
                    {t("common.open")}
                  </button>
                  <button
                    className="v3-btn-ghost v3-btn-sm v3-btn-icon"
                    onClick={() => openExplorer(r.path)}
                    title={t("projects.open_in_explorer")}
                    aria-label={t("projects.open_in_explorer")}
                  >
                    <FolderOpen size={13} strokeWidth={2} />
                  </button>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectListRow({
  project,
  goal,
  git,
  onOpen,
  onOpenExplorer,
}: {
  project: Project;
  goal: string | null;
  git: GitInfo | null;
  onOpen: () => void;
  onOpenExplorer: () => void;
}) {
  const { t } = useT();
  return (
    <article className="v3-row v3-row-project">
      <div className="v3-row-icon" aria-hidden="true">
        <FolderOpen size={16} strokeWidth={2} />
      </div>
      <div className="v3-row-body">
        <div className="v3-row-title">{projectName(project.path)}</div>
        <div className="v3-row-meta">
          <span className="v3-row-path" title={project.path}>
            {project.path}
          </span>
        </div>
        {goal && (
          <div className="v3-row-goal">
            <Info size={11} strokeWidth={2} />
            <span>{goal}</span>
          </div>
        )}
        {git && (
          <div className="v3-row-git">
            <code className="v3-git-hash">{git.hash}</code>
            <span className="v3-git-subject">{git.subject}</span>
            <span className="v3-row-dim">{git.ago}</span>
          </div>
        )}
      </div>
      <div className="v3-row-end">
        <span className="v3-pill v3-pill-soft">
          {activityLabelT(project.days_ago, t)}
        </span>
        <div className="v3-row-actions">
          <button className="v3-btn-primary v3-btn-sm" onClick={onOpen}>
            {t("common.open")}
          </button>
          <button
            className="v3-btn-ghost v3-btn-sm v3-btn-icon"
            onClick={onOpenExplorer}
            title={t("projects.open_in_explorer")}
            aria-label={t("projects.open_in_explorer")}
          >
            <FolderOpen size={13} strokeWidth={2} />
          </button>
        </div>
      </div>
    </article>
  );
}
