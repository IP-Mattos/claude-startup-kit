import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertOctagon,
  AlertTriangle,
  Check,
  Code2,
  ExternalLink,
  FolderOpen,
  GitPullRequest,
  Image as ImageIcon,
  Info,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react";
import type {
  AuditFinding,
  CleanupItem,
  CleanupResult,
  GhPullRequest,
  GitInfo,
  Project,
  ProjectEnrichment,
} from "../types";
import {
  activityLabelT,
  formatBytes,
  formatDate,
  friendlyErrorEn,
  prNumberFromUrl,
  projectName,
} from "../lib/format";
import { enrichProjects } from "../lib/enrichProjects";
import {
  V3_THEME_OPTIONS,
  applyAndPersistV3Theme,
  readSavedV3Theme,
} from "../lib/themes";
import type { V3Theme } from "../lib/themes";
import { parseAuditFindings } from "../lib/audit";
import { useUpdates } from "../lib/useUpdates";
import { plural, useT } from "../lib/i18n";
import type { LangPref } from "../lib/i18n";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

// 200ms debounce — short enough to feel live, long enough to skip every keystroke.
function useDebouncedValue<T>(value: T, delayMs = 200): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(id);
  }, [value, delayMs]);
  return debounced;
}

// =====================================================================
// ProjectsView
// =====================================================================
export function ProjectsViewV3() {
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
          invoke<string[]>("engram_known_projects").catch(
            () => [] as string[]
          ),
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

      {error && <div className="v3-error" role="alert" aria-live="assertive">{error}</div>}

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
        <span className="v3-pill v3-pill-soft">{activityLabelT(project.days_ago, t)}</span>
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

// =====================================================================
// PrsView
// =====================================================================
export function PrsViewV3() {
  const { t } = useT();
  const [prs, setPrs] = useState<GhPullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<GhPullRequest[]>("github_review_queue", { limit: 50 })
      .then((res) => {
        if (!cancelled) setPrs(res);
      })
      .catch((e) => !cancelled && setError(friendlyErrorEn(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, []);

  const debouncedQuery = useDebouncedValue(query);
  const filtered = useMemo(() => {
    const q = debouncedQuery.trim().toLowerCase();
    if (!q) return prs;
    return prs.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.repository.toLowerCase().includes(q) ||
        p.author.toLowerCase().includes(q)
    );
  }, [prs, debouncedQuery]);

  const openUrl = (url: string) => {
    if (!IS_TAURI) {
      window.open(url, "_blank");
      return;
    }
    invoke("open_url", { url }).catch((e) => setError(friendlyErrorEn(e)));
  };

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("prs.title")}</h1>
          <p className="v3-subtitle">
            {loading
              ? t("common.loading")
              : plural(t, prs.length, "prs.summary_one", "prs.summary_other")}
          </p>
        </div>
      </header>

      <div className="v3-search">
        <Search size={14} strokeWidth={2} />
        <input
          type="text"
          placeholder={t("prs.search_placeholder")}
          aria-label={t("prs.search_aria")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && <div className="v3-error" role="alert" aria-live="assertive">{error}</div>}

      {loading ? (
        <div className="v3-empty">{t("prs.loading")}</div>
      ) : filtered.length === 0 ? (
        <div className="v3-empty">
          {prs.length === 0
            ? t("prs.inbox_zero")
            : t("prs.empty_search", { q: query })}
        </div>
      ) : (
        <div className="v3-list">
          {filtered.map((pr) => (
            <article
              key={pr.url}
              className="v3-row v3-row-pr"
              onClick={() => openUrl(pr.url)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  openUrl(pr.url);
                }
              }}
              role="button"
              tabIndex={0}
              aria-label={t("prs.open_label", { title: pr.title })}
            >
              <div className="v3-row-icon" aria-hidden="true">
                <GitPullRequest size={16} strokeWidth={2} />
              </div>
              <div className="v3-row-body">
                <div className="v3-row-title">{pr.title}</div>
                <div className="v3-row-meta">
                  {(() => {
                    const num = prNumberFromUrl(pr.url);
                    return (
                      <>
                        {num !== null && <span>#{num}</span>}
                        <span className="v3-row-dot" aria-hidden="true">·</span>
                        <span>{pr.repository}</span>
                        <span className="v3-row-dot" aria-hidden="true">·</span>
                        <span>{t("prs.by_author", { author: pr.author })}</span>
                      </>
                    );
                  })()}
                </div>
              </div>
              <div className="v3-row-end">
                <span className="v3-pr-pill v3-pr-pill-open">{t("prs.open")}</span>
                <ExternalLink size={14} strokeWidth={2} className="v3-row-extra" />
              </div>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// =====================================================================
// AuditView
// =====================================================================
export function AuditViewV3() {
  const { t } = useT();
  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "CRIT" | "WARN" | "INFO">("all");
  const [refreshNonce, setRefreshNonce] = useState(0);

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
                {items.map((f, i) => (
                  <FindingRow key={`${category}-${i}`} finding={f} />
                ))}
              </div>
            </article>
          ))}
        </div>
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

function FindingRow({ finding }: { finding: AuditFinding }) {
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
      <span className={`v3-level-pill v3-level-${tint}`}>{finding.level}</span>
    </div>
  );
}

// =====================================================================
// CleanupView
// =====================================================================
export function CleanupViewV3() {
  const { t } = useT();
  const [items, setItems] = useState<CleanupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<CleanupItem[]>("cleanup_plan", { olderThanDays: 30 })
      .then((res) => !cancelled && setItems(res))
      .catch((e) => !cancelled && setError(friendlyErrorEn(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  const grouped = useMemo(() => {
    const map = new Map<string, CleanupItem[]>();
    for (const it of items) {
      const arr = map.get(it.category) ?? [];
      arr.push(it);
      map.set(it.category, arr);
    }
    return Array.from(map.entries());
  }, [items]);

  const totalBytes = useMemo(
    () => items.reduce((s, it) => s + it.bytes, 0),
    [items]
  );

  const runCleanup = async () => {
    if (!IS_TAURI || items.length === 0 || running) return;
    setRunning(true);
    setResult(null);
    try {
      const paths = items.map((it) => it.path);
      const res = await invoke<CleanupResult>("cleanup_apply", { paths });
      setResult(res);
      setRefreshNonce((n) => n + 1);
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("cleanup.title")}</h1>
          <p className="v3-subtitle">
            {loading
              ? t("cleanup.scanning")
              : items.length === 0
              ? t("cleanup.tidy")
              : t(
                  items.length === 1
                    ? "cleanup.summary_one"
                    : "cleanup.summary_other",
                  { n: items.length, bytes: formatBytes(totalBytes) }
                )}
          </p>
        </div>
        <div className="v3-view-tools">
          {items.length > 0 && (
            <button
              className="v3-btn-primary v3-btn-sm"
              onClick={runCleanup}
              disabled={running}
            >
              <Trash2 size={13} strokeWidth={2} />
              {running ? t("cleanup.cleaning") : t("cleanup.clean_all")}
            </button>
          )}
        </div>
      </header>

      {result && (
        <div className="v3-success" role="status" aria-live="polite">
          <Check size={14} strokeWidth={2.4} />
          <span>
            {t(
              result.deleted === 1
                ? "cleanup.deleted_one"
                : "cleanup.deleted_other",
              { n: result.deleted, bytes: formatBytes(result.freed_bytes) }
            )}
            {result.failed > 0 && t("cleanup.failed_suffix", { n: result.failed })}
          </span>
        </div>
      )}

      {error && <div className="v3-error" role="alert" aria-live="assertive">{error}</div>}

      {loading ? (
        <div className="v3-empty">{t("cleanup.scanning_workspace")}</div>
      ) : grouped.length === 0 ? (
        <div className="v3-empty">{t("cleanup.nothing")}</div>
      ) : (
        <div className="v3-list">
          {grouped.map(([category, list]) => {
            const catBytes = list.reduce((s, i) => s + i.bytes, 0);
            return (
              <article key={category} className="v3-card">
                <header className="v3-card-head">
                  <h2 className="v3-card-title">{category}</h2>
                  <span className="v3-row-dim">
                    {t(
                      list.length === 1 ? "cleanup.items_one" : "cleanup.items_other",
                      { n: list.length, bytes: formatBytes(catBytes) }
                    )}
                  </span>
                </header>
                <ul className="v3-cleanup-files">
                  {list.slice(0, 10).map((it) => (
                    <li key={it.path}>
                      <span className="v3-cleanup-path" title={it.path}>
                        {it.path}
                      </span>
                      <span className="v3-cleanup-meta">
                        <span>{formatBytes(it.bytes)}</span>
                        <span className="v3-row-dim">{formatDate(it.mtime)}</span>
                      </span>
                    </li>
                  ))}
                  {list.length > 10 && (
                    <li className="v3-row-dim">
                      {t("cleanup.and_more", { n: list.length - 10 })}
                    </li>
                  )}
                </ul>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =====================================================================
// CompanionsView (settings for the on-screen companion)
// =====================================================================
// =====================================================================
// ClaudeView (skills + MCP servers)
// =====================================================================
interface ClaudeSkill {
  name: string;
  description: string;
  path: string;
  usage_count: number;
}

interface McpServer {
  name: string;
  command: string;
  args: string[];
  source: "config" | "plugin" | string;
  enabled: boolean;
  path: string;
}

export function ClaudeViewV3() {
  const { t } = useT();
  const [skills, setSkills] = useState<ClaudeSkill[]>([]);
  const [mcps, setMcps] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Per-row pending state so toggling one MCP doesn't disable every switch.
  const [togglingName, setTogglingName] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Two-stage fetch: list_claude_skills returns the catalog instantly
    // (no JSONL scan), then count_claude_skill_usage enriches counts in
    // the background. Same pattern used elsewhere for project enrichment.
    Promise.all([
      invoke<ClaudeSkill[]>("list_claude_skills").catch(() => [] as ClaudeSkill[]),
      invoke<McpServer[]>("list_mcp_servers").catch(() => [] as McpServer[]),
    ])
      .then(([s, m]) => {
        if (cancelled) return;
        setSkills(s);
        setMcps(m);
        setLoading(false);
        // Kick the usage scan AFTER the UI shows skills. Don't block render.
        if (s.length > 0) {
          invoke<Record<string, number>>("count_claude_skill_usage", {
            names: s.map((sk) => sk.name),
          })
            .then((counts) => {
              if (cancelled) return;
              setSkills((prev) =>
                prev
                  .map((sk) => ({ ...sk, usage_count: counts[sk.name] ?? 0 }))
                  // After counts arrive, sort by usage so the picker reflects
                  // 'most used' as soon as the data is available.
                  .sort(
                    (a, b) =>
                      b.usage_count - a.usage_count || a.name.localeCompare(b.name)
                  )
              );
            })
            .catch(() => {
              /* usage scan is best-effort — silent fail keeps the list visible */
            });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(friendlyErrorEn(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  const openSkill = (path: string) =>
    invoke("open_in_vscode", { path }).catch((e) => setError(friendlyErrorEn(e)));

  const toggleMcp = async (mcp: McpServer) => {
    setTogglingName(mcp.name);
    try {
      await invoke("toggle_mcp_server", {
        name: mcp.name,
        source: mcp.source,
        enabled: !mcp.enabled,
      });
      setRefreshNonce((n) => n + 1);
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setTogglingName(null);
    }
  };

  // Highest-usage skill drives the badge color so the most-used row pops
  // visually without making everything orange.
  const maxUsage = useMemo(
    () => skills.reduce((m, s) => Math.max(m, s.usage_count), 0),
    [skills]
  );

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("claude.title")}</h1>
          <p className="v3-subtitle">{t("claude.subtitle")}</p>
        </div>
        <div className="v3-view-tools">
          <button
            type="button"
            className="v3-link"
            onClick={() => setRefreshNonce((n) => n + 1)}
            disabled={loading}
          >
            <RefreshCw size={12} strokeWidth={2.4} />
            {loading ? ` ${t("claude.refreshing")}` : ` ${t("claude.refresh")}`}
          </button>
        </div>
      </header>

      {error && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("claude.mcp_title")}</h2>
          <span className="v3-row-dim">
            {t("claude.mcp_active", {
              active: mcps.filter((m) => m.enabled).length,
              total: mcps.length,
            })}
          </span>
        </header>
        {loading ? (
          <div className="v3-empty">{t("claude.mcp_loading")}</div>
        ) : mcps.length === 0 ? (
          <div className="v3-empty">{t("claude.mcp_empty")}</div>
        ) : (
          <ul className="v3-list">
            {mcps.map((m) => (
              <li key={`${m.source}:${m.name}`} className="v3-claude-row">
                <div className="v3-claude-row-body">
                  <div className="v3-claude-row-title">
                    <span className="v3-claude-row-name">{m.name}</span>
                    <span
                      className={
                        "v3-pill v3-pill-soft v3-pill-source-" + m.source
                      }
                    >
                      {m.source}
                    </span>
                  </div>
                  <div className="v3-claude-row-meta">
                    {m.command
                      ? `${m.command} ${m.args.join(" ")}`.trim()
                      : t("claude.mcp_bundled")}
                  </div>
                </div>
                <label
                  className="v3-switch"
                  aria-label={t("claude.mcp_toggle", { name: m.name })}
                >
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    disabled={togglingName === m.name}
                    onChange={() => toggleMcp(m)}
                  />
                  <span className="v3-switch-slider" aria-hidden="true" />
                </label>
              </li>
            ))}
          </ul>
        )}
      </article>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("claude.skills_title")}</h2>
          <span className="v3-row-dim">
            {plural(
              t,
              skills.length,
              "claude.skills_count_one",
              "claude.skills_count_other"
            )}
          </span>
        </header>
        {loading ? (
          <div className="v3-empty">{t("claude.skills_loading")}</div>
        ) : skills.length === 0 ? (
          <div className="v3-empty">{t("claude.skills_empty")}</div>
        ) : (
          <ul className="v3-list">
            {skills.map((s) => (
              <li key={s.name} className="v3-claude-row">
                <div className="v3-claude-row-body">
                  <div className="v3-claude-row-title">
                    <span className="v3-claude-row-name">{s.name}</span>
                    {s.usage_count > 0 && (
                      <span
                        className={
                          "v3-usage-badge " +
                          (s.usage_count === maxUsage
                            ? "v3-usage-badge-top"
                            : "v3-usage-badge-some")
                        }
                        title={t("claude.usage_title", { n: s.usage_count })}
                      >
                        {s.usage_count}
                      </span>
                    )}
                  </div>
                  <div className="v3-claude-row-meta">
                    {s.description || t("claude.no_description")}
                  </div>
                </div>
                <button
                  type="button"
                  className="v3-btn-ghost"
                  onClick={() => openSkill(s.path)}
                >
                  <ExternalLink size={13} strokeWidth={2} />
                  {t("claude.open")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </article>
    </div>
  );
}

interface CompanionsViewV3Props {
  name: string;
  image: string | null;
  onNameChange: (v: string) => void;
  onImageChange: (v: string | null) => void;
}
export function CompanionsViewV3({
  name,
  image,
  onNameChange,
  onImageChange,
}: CompanionsViewV3Props) {
  const { t } = useT();
  const setName = onNameChange;
  const setImage = onImageChange;
  const [imgError, setImgError] = useState<string | null>(null);

  const handleFile = (file: File | undefined) => {
    setImgError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setImgError(t("companions.err_not_image"));
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setImgError(t("companions.err_too_large"));
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      if (typeof r.result === "string") setImage(r.result);
    };
    r.onerror = () => setImgError(t("companions.err_read"));
    r.readAsDataURL(file);
  };

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("companions.title")}</h1>
          <p className="v3-subtitle">{t("companions.subtitle")}</p>
        </div>
      </header>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("companions.identity")}</h2>
        </header>
        <div className="v3-form">
          <label className="v3-form-row">
            <span className="v3-form-label">{t("companions.name")}</span>
            <input
              type="text"
              className="v3-input"
              value={name}
              maxLength={48}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("companions.placeholder")}
            />
          </label>

          <div className="v3-form-row">
            <span className="v3-form-label">{t("companions.image")}</span>
            <div className="v3-avatar-row">
              <div className="v3-avatar-preview">
                {image ? (
                  <img src={image} alt="" />
                ) : (
                  <div className="v3-avatar-empty">
                    <ImageIcon size={20} />
                    <span>{t("companions.no_image")}</span>
                  </div>
                )}
              </div>
              <div className="v3-avatar-controls">
                <label className="v3-btn-ghost v3-btn-sm">
                  {t("companions.choose_image")}
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => handleFile(e.target.files?.[0])}
                  />
                </label>
                {image && (
                  <button
                    className="v3-btn-ghost v3-btn-sm"
                    onClick={() => setImage(null)}
                  >
                    <Trash2 size={13} strokeWidth={2} />
                    {t("companions.remove")}
                  </button>
                )}
                <p className="v3-form-hint">{t("companions.image_hint")}</p>
                {imgError && (
                  <p className="v3-form-error" role="alert" aria-live="polite">
                    {imgError}
                  </p>
                )}
              </div>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}

// =====================================================================
// SettingsView
// =====================================================================
export function SettingsViewV3() {
  const [theme, setTheme] = useState<V3Theme>(() => readSavedV3Theme());
  const updates = useUpdates();
  const { t, pref, setPref } = useT();

  const pick = (next: V3Theme) => {
    setTheme(applyAndPersistV3Theme(next));
  };

  const langOptions: { value: LangPref; label: string }[] = [
    { value: "auto", label: t("settings.language_auto") },
    { value: "en", label: t("settings.language_en") },
    { value: "es", label: t("settings.language_es") },
  ];

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("settings.title")}</h1>
          <p className="v3-subtitle">{t("settings.subtitle")}</p>
        </div>
      </header>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("settings.language")}</h2>
        </header>
        <div className="v3-form">
          <div className="v3-lang-row">
            {langOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={
                  "v3-lang-option" + (pref === opt.value ? " active" : "")
                }
                onClick={() => setPref(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </article>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("settings.updates")}</h2>
          <button
            type="button"
            className="v3-link"
            onClick={updates.checkNow}
            disabled={updates.checking}
          >
            {updates.checking ? t("settings.checking") : t("settings.check_now")}
          </button>
        </header>
        <div className="v3-form">
          <UpdateRow
            label={t("settings.update_app_label")}
            status={updates.app}
            notConfiguredHint={t("settings.update_app_hint")}
          />
          <UpdateRow
            label={t("settings.update_gentle_ai_label")}
            status={updates.gentleAi}
            notConfiguredHint={t("settings.update_gentle_ai_hint")}
          />
          {updates.error && (
            <div className="v3-error" role="alert" aria-live="assertive">
              {updates.error}
            </div>
          )}
          <p className="v3-row-meta">{t("settings.updates_auto_hint")}</p>
        </div>
      </article>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("settings.theme")}</h2>
          <span className="v3-row-dim">
            {t("settings.curated_palettes", { n: V3_THEME_OPTIONS.length })}
          </span>
        </header>
        <div className="v3-theme-grid">
          {V3_THEME_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              className={"v3-theme-card" + (theme === opt.id ? " active" : "")}
              onClick={() => pick(opt.id)}
            >
              <div className="v3-theme-swatch">
                <span style={{ background: opt.swatch[0] }} />
                <span style={{ background: opt.swatch[1] }} />
                <span style={{ background: opt.swatch[2] }} />
              </div>
              <div className="v3-theme-label">{opt.label}</div>
              {theme === opt.id && (
                <span className="v3-theme-check" aria-hidden="true">
                  <Check size={12} strokeWidth={3} />
                </span>
              )}
            </button>
          ))}
        </div>
      </article>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("settings.shortcuts")}</h2>
        </header>
        <div className="v3-form">
          <div className="v3-shortcuts">
            <div className="v3-shortcut">
              <kbd>Ctrl</kbd> + <kbd>1</kbd>…<kbd>7</kbd>
              <span>{t("settings.shortcut_switch_tabs")}</span>
            </div>
            <div className="v3-shortcut">
              <kbd>Ctrl</kbd> + <kbd>R</kbd>
              <span>{t("settings.shortcut_refresh")}</span>
            </div>
            <div className="v3-shortcut">
              <kbd>Ctrl</kbd> + <kbd>,</kbd>
              <span>{t("settings.shortcut_open_settings")}</span>
            </div>
            <div className="v3-shortcut">
              <kbd>Ctrl</kbd> + <kbd>T</kbd>
              <span>{t("settings.shortcut_cycle_theme")}</span>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}

// Code2 import keeps lucide tree-shaking happy; reference it so unused-imports
// rule doesn't fire if a future revision drops the icon.
void Code2;

// Renders one row of the Updates card. Shows current/latest with a status
// badge — "up to date", "update available", or "not configured" when the
// channel can't be reached (no published release / gentle-ai not on PATH).
// =====================================================================
// SyncCard — workspace sync (engram-only, private GitHub repo)
// =====================================================================
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
export function SyncViewV3() {
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

  const handleImport = async () => {
    if (!window.confirm(t("sync.confirm_import"))) return;
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

  const handleDisconnect = async () => {
    if (!window.confirm(t("sync.confirm_disconnect"))) return;
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

  const lastSyncLabel = state?.last_sync_at
    ? new Date(state.last_sync_at * 1000).toLocaleString()
    : t("sync.never_synced");

  return (
    <article className="v3-card">
      {/* Title + lead live on the SyncViewV3 page header now. The card
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
    </article>
  );
}

function UpdateRow({
  label,
  status,
  notConfiguredHint,
}: {
  label: string;
  status: import("../lib/useUpdates").UpdateStatus | null;
  notConfiguredHint: string;
}) {
  const { t } = useT();
  if (!status) {
    return (
      <div className="v3-update-row">
        <div className="v3-update-row-label">{label}</div>
        <div className="v3-update-row-status v3-update-row-status-dim">
          {t("common.loading")}
        </div>
      </div>
    );
  }
  if (!status.configured) {
    return (
      <div className="v3-update-row">
        <div className="v3-update-row-label">{label}</div>
        <div className="v3-update-row-status v3-update-row-status-dim">
          {t("settings.update_not_configured")}
          <div className="v3-row-meta">{notConfiguredHint}</div>
        </div>
      </div>
    );
  }
  if (status.available) {
    return (
      <div className="v3-update-row">
        <div className="v3-update-row-label">{label}</div>
        <div className="v3-update-row-status v3-update-row-status-warn">
          v{status.current} → v{status.latest}
        </div>
      </div>
    );
  }
  return (
    <div className="v3-update-row">
      <div className="v3-update-row-label">{label}</div>
      <div className="v3-update-row-status v3-update-row-status-ok">
        v{status.current} · {t("settings.update_up_to_date")}
      </div>
    </div>
  );
}
