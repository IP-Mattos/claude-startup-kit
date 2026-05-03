import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertOctagon,
  AlertTriangle,
  Bot,
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
  activityLabelEn,
  formatBytes,
  formatDate,
  friendlyErrorEn,
  prNumberFromUrl,
  projectName,
} from "../lib/format";
import { enrichProjects } from "../lib/enrichProjects";
import { isV3Theme, loadV3Theme } from "../lib/themes";
import type { V3Theme } from "../lib/themes";
import { parseAuditFindings } from "../lib/audit";
import { useUpdates } from "../lib/useUpdates";

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
          <h1 className="v3-greeting">Projects</h1>
          <p className="v3-subtitle">
            {loading
              ? "Scanning…"
              : `${filtered.length} of ${projects.length} project${
                  projects.length === 1 ? "" : "s"
                } in the last ${windowDays} days.`}
          </p>
        </div>
        <div className="v3-view-tools">
          <select
            className="v3-select"
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
            aria-label="Time window"
          >
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
          </select>
        </div>
      </header>

      <div className="v3-search">
        <Search size={14} strokeWidth={2} />
        <input
          type="text"
          placeholder="Search projects…"
          aria-label="Search projects"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && <div className="v3-error" role="alert" aria-live="assertive">{error}</div>}

      {loading ? (
        <div className="v3-empty">Loading projects…</div>
      ) : filtered.length === 0 ? (
        <div className="v3-empty">
          {projects.length === 0
            ? `No projects detected in the last ${windowDays} days.`
            : `No projects match "${query}".`}
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
        <span className="v3-pill v3-pill-soft">{activityLabelEn(project.days_ago)}</span>
        <div className="v3-row-actions">
          <button className="v3-btn-primary v3-btn-sm" onClick={onOpen}>
            Open
          </button>
          <button
            className="v3-btn-ghost v3-btn-sm v3-btn-icon"
            onClick={onOpenExplorer}
            title="Open in Explorer"
            aria-label="Open in Explorer"
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
          <h1 className="v3-greeting">Pull Requests</h1>
          <p className="v3-subtitle">
            {loading ? "Loading…" : `${prs.length} PR${prs.length === 1 ? "" : "s"} awaiting your review.`}
          </p>
        </div>
      </header>

      <div className="v3-search">
        <Search size={14} strokeWidth={2} />
        <input
          type="text"
          placeholder="Search PRs by title, repo, or author…"
          aria-label="Search pull requests"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {error && <div className="v3-error" role="alert" aria-live="assertive">{error}</div>}

      {loading ? (
        <div className="v3-empty">Loading pull requests…</div>
      ) : filtered.length === 0 ? (
        <div className="v3-empty">
          {prs.length === 0
            ? "No PRs awaiting your review. Inbox zero."
            : `No PRs match "${query}".`}
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
              aria-label={`Open pull request ${pr.title}`}
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
                        <span>by {pr.author}</span>
                      </>
                    );
                  })()}
                </div>
              </div>
              <div className="v3-row-end">
                <span className="v3-pr-pill v3-pr-pill-open">Open</span>
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
          <h1 className="v3-greeting">Audit</h1>
          <p className="v3-subtitle">
            {loading
              ? "Running audit…"
              : `${findings.length} finding${findings.length === 1 ? "" : "s"} across your workspace.`}
          </p>
        </div>
        <div className="v3-view-tools">
          <button
            className="v3-btn-ghost v3-btn-sm"
            onClick={() => setRefreshNonce((n) => n + 1)}
          >
            <RefreshCw size={13} strokeWidth={2} />
            Re-run
          </button>
        </div>
      </header>

      <div className="v3-filter-row">
        <FilterChip
          active={filter === "all"}
          onClick={() => setFilter("all")}
          label={`All ${counts.all}`}
        />
        <FilterChip
          active={filter === "CRIT"}
          onClick={() => setFilter("CRIT")}
          label={`Critical ${counts.crit}`}
          tint="crit"
        />
        <FilterChip
          active={filter === "WARN"}
          onClick={() => setFilter("WARN")}
          label={`Warning ${counts.warn}`}
          tint="warn"
        />
        <FilterChip
          active={filter === "INFO"}
          onClick={() => setFilter("INFO")}
          label={`Info ${counts.info}`}
          tint="info"
        />
      </div>

      {error && <div className="v3-error" role="alert" aria-live="assertive">{error}</div>}

      {loading ? (
        <div className="v3-empty">Running audit…</div>
      ) : grouped.length === 0 ? (
        <div className="v3-empty">
          {findings.length === 0
            ? "Audit clean. Nothing to report."
            : "No findings match the current filter."}
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
          <h1 className="v3-greeting">Cleanup</h1>
          <p className="v3-subtitle">
            {loading
              ? "Scanning…"
              : items.length === 0
              ? "Nothing to clean. Disk is tidy."
              : `${items.length} stale item${
                  items.length === 1 ? "" : "s"
                } · ${formatBytes(totalBytes)} can be freed.`}
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
              {running ? "Cleaning…" : "Clean all"}
            </button>
          )}
        </div>
      </header>

      {result && (
        <div className="v3-success" role="status" aria-live="polite">
          <Check size={14} strokeWidth={2.4} />
          <span>
            Deleted <strong>{result.deleted}</strong> item
            {result.deleted === 1 ? "" : "s"}, freed{" "}
            <strong>{formatBytes(result.freed_bytes)}</strong>
            {result.failed > 0 && ` · ${result.failed} failed`}
          </span>
        </div>
      )}

      {error && <div className="v3-error" role="alert" aria-live="assertive">{error}</div>}

      {loading ? (
        <div className="v3-empty">Scanning workspace…</div>
      ) : grouped.length === 0 ? (
        <div className="v3-empty">Nothing to clean.</div>
      ) : (
        <div className="v3-list">
          {grouped.map(([category, list]) => {
            const catBytes = list.reduce((s, i) => s + i.bytes, 0);
            return (
              <article key={category} className="v3-card">
                <header className="v3-card-head">
                  <h2 className="v3-card-title">{category}</h2>
                  <span className="v3-row-dim">
                    {list.length} item{list.length === 1 ? "" : "s"} ·{" "}
                    {formatBytes(catBytes)}
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
                      … and {list.length - 10} more
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
    Promise.all([
      invoke<ClaudeSkill[]>("list_claude_skills").catch(() => [] as ClaudeSkill[]),
      invoke<McpServer[]>("list_mcp_servers").catch(() => [] as McpServer[]),
    ])
      .then(([s, m]) => {
        if (cancelled) return;
        setSkills(s);
        setMcps(m);
      })
      .catch((e) => !cancelled && setError(friendlyErrorEn(e)))
      .finally(() => !cancelled && setLoading(false));
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
          <h1 className="v3-greeting">Claude</h1>
          <p className="v3-subtitle">
            Skills available to Claude Code and MCP servers configured on this
            machine.
          </p>
        </div>
        <div className="v3-view-tools">
          <button
            type="button"
            className="v3-link"
            onClick={() => setRefreshNonce((n) => n + 1)}
            disabled={loading}
          >
            <RefreshCw size={12} strokeWidth={2.4} />
            {loading ? " Refreshing…" : " Refresh"}
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
          <h2 className="v3-card-title">Skills</h2>
          <span className="v3-row-dim">
            {skills.length} {skills.length === 1 ? "skill" : "skills"} · sorted
            by recent usage
          </span>
        </header>
        {loading ? (
          <div className="v3-empty">Loading skills…</div>
        ) : skills.length === 0 ? (
          <div className="v3-empty">No skills found in ~/.claude/skills/.</div>
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
                        title={`${s.usage_count} mentions in the last 30 days`}
                      >
                        {s.usage_count}
                      </span>
                    )}
                  </div>
                  <div className="v3-claude-row-meta">
                    {s.description || "No description provided."}
                  </div>
                </div>
                <button
                  type="button"
                  className="v3-btn-ghost"
                  onClick={() => openSkill(s.path)}
                >
                  <ExternalLink size={13} strokeWidth={2} />
                  Open
                </button>
              </li>
            ))}
          </ul>
        )}
      </article>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">MCP servers</h2>
          <span className="v3-row-dim">
            {mcps.filter((m) => m.enabled).length} active of {mcps.length}
          </span>
        </header>
        {loading ? (
          <div className="v3-empty">Loading MCP servers…</div>
        ) : mcps.length === 0 ? (
          <div className="v3-empty">
            No MCP servers configured under ~/.claude/mcp/ or settings.json.
          </div>
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
                      : "Bundled plugin — no explicit command."}
                  </div>
                </div>
                <label className="v3-switch" aria-label={`Toggle ${m.name}`}>
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
  const setName = onNameChange;
  const setImage = onImageChange;
  const [imgError, setImgError] = useState<string | null>(null);

  const handleFile = (file: File | undefined) => {
    setImgError(null);
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setImgError("File is not an image.");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setImgError("Image is over 2 MB. Use a smaller one.");
      return;
    }
    const r = new FileReader();
    r.onload = () => {
      if (typeof r.result === "string") setImage(r.result);
    };
    r.onerror = () => setImgError("Could not read file.");
    r.readAsDataURL(file);
  };

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">Companion</h1>
          <p className="v3-subtitle">
            Configure the assistant shown in the right panel.
          </p>
        </div>
      </header>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">Identity</h2>
        </header>
        <div className="v3-form">
          <label className="v3-form-row">
            <span className="v3-form-label">Name</span>
            <input
              type="text"
              className="v3-input"
              value={name}
              maxLength={48}
              onChange={(e) => setName(e.target.value)}
              placeholder="Companion"
            />
          </label>

          <div className="v3-form-row">
            <span className="v3-form-label">Image</span>
            <div className="v3-avatar-row">
              <div className="v3-avatar-preview">
                {image ? (
                  <img src={image} alt="" />
                ) : (
                  <div className="v3-avatar-empty">
                    <ImageIcon size={20} />
                    <span>no image</span>
                  </div>
                )}
              </div>
              <div className="v3-avatar-controls">
                <label className="v3-btn-ghost v3-btn-sm">
                  Choose image
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
                    Remove
                  </button>
                )}
                <p className="v3-form-hint">PNG, JPG or WebP — up to 2 MB.</p>
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
// V3Theme + V3_THEME_ORDER live in lib/themes — single source of truth.
// V3_THEMES below carries the visual catalog (swatches + labels) used by the
// theme picker grid; its `id` field is constrained to V3Theme for safety.
const V3_THEMES: { id: V3Theme; label: string; swatch: string[] }[] = [
  { id: "light", label: "Light", swatch: ["#F8F9FB", "#FFFFFF", "#ED7B26"] },
  { id: "dark",  label: "Dark",  swatch: ["#0F172A", "#1E293B", "#ED7B26"] },
];

function applyV3Theme(theme: V3Theme) {
  void loadV3Theme(theme);
  try {
    localStorage.setItem("csk-theme-v3", theme);
  } catch {
    /* ignore */
  }
}

function readV3Theme(): V3Theme {
  try {
    const saved = localStorage.getItem("csk-theme-v3");
    if (saved && isV3Theme(saved)) return saved;
  } catch {
    /* ignore */
  }
  return "light";
}

export function SettingsViewV3({
  onJumpCompanion,
}: {
  onJumpCompanion: () => void;
}) {
  const [theme, setTheme] = useState<V3Theme>(() => readV3Theme());
  const updates = useUpdates();

  const pick = (t: V3Theme) => {
    setTheme(t);
    applyV3Theme(t);
  };

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">Settings</h1>
          <p className="v3-subtitle">App preferences and configuration.</p>
        </div>
      </header>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">Updates</h2>
          <button
            type="button"
            className="v3-link"
            onClick={updates.checkNow}
            disabled={updates.checking}
          >
            {updates.checking ? "Checking…" : "Check now"}
          </button>
        </header>
        <div className="v3-form">
          <UpdateRow
            label="Claude Startup Kit"
            status={updates.app}
            notConfiguredHint="No release published yet on GitHub. Configure once a release pipeline ships."
          />
          <UpdateRow
            label="gentle-ai"
            status={updates.gentleAi}
            notConfiguredHint="gentle-ai is not on PATH. Install it from gentle-ai's repo."
          />
          {updates.error && (
            <div className="v3-error" role="alert" aria-live="assertive">
              {updates.error}
            </div>
          )}
          <p className="v3-row-meta">
            Updates are checked automatically once every 24 hours. Click "Check
            now" to refresh immediately.
          </p>
        </div>
      </article>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">Theme</h2>
          <span className="v3-row-dim">{V3_THEMES.length} curated palettes</span>
        </header>
        <div className="v3-theme-grid">
          {V3_THEMES.map((t) => (
            <button
              key={t.id}
              className={"v3-theme-card" + (theme === t.id ? " active" : "")}
              onClick={() => pick(t.id)}
            >
              <div className="v3-theme-swatch">
                <span style={{ background: t.swatch[0] }} />
                <span style={{ background: t.swatch[1] }} />
                <span style={{ background: t.swatch[2] }} />
              </div>
              <div className="v3-theme-label">{t.label}</div>
              {theme === t.id && (
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
          <h2 className="v3-card-title">Companion</h2>
        </header>
        <div
          className="v3-settings-row"
          onClick={onJumpCompanion}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onJumpCompanion();
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Customize companion"
        >
          <div className="v3-settings-row-icon">
            <Bot size={16} strokeWidth={2} />
          </div>
          <div className="v3-settings-row-body">
            <div className="v3-row-title">Customize companion</div>
            <div className="v3-row-meta">
              Set the name and avatar shown in the right panel.
            </div>
          </div>
          <span className="v3-row-extra">→</span>
        </div>
      </article>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">Keyboard Shortcuts</h2>
        </header>
        <div className="v3-form">
          <div className="v3-shortcuts">
            <div className="v3-shortcut">
              <kbd>Ctrl</kbd> + <kbd>1</kbd>…<kbd>7</kbd>
              <span>Switch tabs (Overview → Settings)</span>
            </div>
            <div className="v3-shortcut">
              <kbd>Ctrl</kbd> + <kbd>R</kbd>
              <span>Refresh current tab data</span>
            </div>
            <div className="v3-shortcut">
              <kbd>Ctrl</kbd> + <kbd>,</kbd>
              <span>Open Settings</span>
            </div>
            <div className="v3-shortcut">
              <kbd>Ctrl</kbd> + <kbd>T</kbd>
              <span>Cycle theme</span>
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
function UpdateRow({
  label,
  status,
  notConfiguredHint,
}: {
  label: string;
  status: import("../lib/useUpdates").UpdateStatus | null;
  notConfiguredHint: string;
}) {
  if (!status) {
    return (
      <div className="v3-update-row">
        <div className="v3-update-row-label">{label}</div>
        <div className="v3-update-row-status v3-update-row-status-dim">Loading…</div>
      </div>
    );
  }
  if (!status.configured) {
    return (
      <div className="v3-update-row">
        <div className="v3-update-row-label">{label}</div>
        <div className="v3-update-row-status v3-update-row-status-dim">
          Not configured
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
        v{status.current} · up to date
      </div>
    </div>
  );
}
