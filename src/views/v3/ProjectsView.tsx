import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { FolderOpen, Info, Search } from "lucide-react";
import type { GitInfo, Project, ProjectEnrichment } from "../../types";
import {
  activityLabelT,
  friendlyErrorEn,
  projectName,
} from "../../lib/format";
import { enrichProjects } from "../../lib/enrichProjects";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { useT } from "../../lib/i18n";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function ProjectsView() {
  const { t } = useT();
  const [projects, setProjects] = useState<Project[]>([]);
  const [enrichment, setEnrichment] = useState<Record<string, ProjectEnrichment>>(
    {}
  );
  const [windowDays, setWindowDays] = useState<number>(() => {
    const saved = parseInt(localStorage.getItem("csk-window-days") ?? "", 10);
    return Number.isFinite(saved) && saved > 0 ? saved : 14;
  });
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    localStorage.setItem("csk-window-days", String(windowDays));
  }, [windowDays]);

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        // scan_projects + engram_known_projects are independent — kick them
        // off together to halve perceived load time.
        const [projectsRes, known] = await Promise.all([
          invoke<Project[]>("scan_projects", { windowDays }),
          invoke<string[]>("engram_known_projects").catch(() => [] as string[]),
        ]);
        if (cancelled) return;
        const enr = await enrichProjects(projectsRes, known).catch(() => ({}));
        if (cancelled) return;
        setProjects(projectsRes);
        setEnrichment(enr);
      } catch (e) {
        if (!cancelled) setError(friendlyErrorEn(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [windowDays]);

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
