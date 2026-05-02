import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Folder,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  Info,
  Palette,
  RefreshCw,
  Search,
  ShieldCheck,
  Target,
  Trash2,
  CheckCircle2,
} from "lucide-react";
import "./App.css";

type Project = {
  path: string;
  mtime: number;
  days_ago: number;
  last_date: string;
};
type GitInfo = {
  hash: string;
  ago: string;
  author: string;
  subject: string;
};
type AuditFinding = {
  level: "OK" | "INFO" | "WARN" | "CRIT";
  category: string;
  title: string;
  detail: string;
};
type GhPullRequest = {
  title: string;
  url: string;
  repository: string;
  author: string;
  created_at: string;
};
type CleanupItem = {
  category: string;
  path: string;
  bytes: number;
  mtime: number;
};
type CleanupResult = {
  deleted: number;
  failed: number;
  freed_bytes: number;
  errors: string[];
};
type Tab = "projects" | "audit" | "prs" | "cleanup";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDate(unix: number): string {
  return new Date(unix * 1000).toISOString().slice(0, 10);
}

function projectName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function activityLabel(daysAgo: number): string {
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  return `${daysAgo}d ago`;
}

function ProjectsView({
  windowDays,
  setWindowDays,
}: {
  windowDays: number;
  setWindowDays: (n: number) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [gitInfo, setGitInfo] = useState<Record<string, GitInfo | null>>({});
  const [goals, setGoals] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  async function refresh(days: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<Project[]>("scan_projects", { windowDays: days });
      setProjects(res);
      setLoading(false);
      const known = await invoke<string[]>("engram_known_projects").catch(() => [] as string[]);
      const enrich = await Promise.all(
        res.map(async (p) => {
          const [git, goal] = await Promise.all([
            invoke<GitInfo | null>("git_last_commit", { path: p.path }).catch(() => null),
            invoke<string | null>("engram_project_goal", { path: p.path, known }).catch(() => null),
          ]);
          return [p.path, git, goal] as const;
        })
      );
      setGitInfo(Object.fromEntries(enrich.map(([k, g]) => [k, g])));
      setGoals(Object.fromEntries(enrich.map(([k, , goal]) => [k, goal])));
    } catch (e) {
      setError(String(e));
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh(windowDays);
  }, [windowDays]);

  async function openCode(path: string) {
    try { await invoke("open_in_vscode", { path }); } catch (e) { setError(String(e)); }
  }
  async function openExplorer(path: string) {
    try { await invoke("open_path_in_explorer", { path }); } catch (e) { setError(String(e)); }
  }

  const filtered = useMemo(() => {
    if (!query.trim()) return projects;
    const q = query.toLowerCase();
    return projects.filter((p) =>
      projectName(p.path).toLowerCase().includes(q) ||
      p.path.toLowerCase().includes(q) ||
      (goals[p.path] ?? "").toLowerCase().includes(q)
    );
  }, [projects, query, goals]);

  const todayCount = projects.filter((p) => p.days_ago <= 1).length;

  return (
    <>
      <div className="view-bar">
        <div className="search">
          <Search size={14} />
          <input
            placeholder="Search projects, paths, goals…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <div className="filters">
          <span className="summary">
            <strong>{projects.length}</strong> active <span className="dim">·</span>
            <strong>{todayCount}</strong> today
          </span>
          <label className="select-wrap">
            <select
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.currentTarget.value))}
            >
              <option value={1}>Last 24h</option>
              <option value={7}>Last 7d</option>
              <option value={14}>Last 14d</option>
              <option value={30}>Last 30d</option>
            </select>
          </label>
          <button className="ghost icon-btn" onClick={() => refresh(windowDays)} title="Refresh">
            <RefreshCw size={14} className={loading ? "spinning" : ""} />
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <ProjectsSkeleton />
      ) : filtered.length === 0 ? (
        <div className="state">
          {projects.length === 0
            ? `No active projects in the last ${windowDays} days.`
            : `No matches for "${query}".`}
        </div>
      ) : (
        <ul className="projects">
          {filtered.map((p) => (
            <li key={p.path} className="project">
              <div className="project-main">
                <div className="project-name">
                  <FolderOpen size={16} className="project-icon" />
                  {projectName(p.path)}
                </div>
                <div className="project-path">{p.path}</div>
                {goals[p.path] && (
                  <div className="project-line">
                    <Target size={12} className="line-icon goal-icon" />
                    <span className="goal-text">{goals[p.path]}</span>
                  </div>
                )}
                {gitInfo[p.path] && (
                  <div className="project-line">
                    <GitBranch size={12} className="line-icon" />
                    <span className="git-hash">{gitInfo[p.path]!.hash}</span>
                    <span className="git-subject">{gitInfo[p.path]!.subject}</span>
                    <span className="git-ago">· {gitInfo[p.path]!.ago}</span>
                  </div>
                )}
              </div>
              <div className="project-meta">
                <span className={`badge ${p.days_ago <= 1 ? "badge-fresh" : ""}`}>
                  {activityLabel(p.days_ago)}
                </span>
                <span className="date">{p.last_date}</span>
              </div>
              <div className="project-actions">
                <button onClick={() => openCode(p.path)}>Open in VS Code</button>
                <button className="ghost" onClick={() => openExplorer(p.path)} title="Open in Explorer">
                  <Folder size={14} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function ProjectsSkeleton() {
  return (
    <ul className="projects">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="project skeleton">
          <div className="project-main">
            <div className="sk-line" style={{ width: "40%", height: 16 }} />
            <div className="sk-line" style={{ width: "70%", height: 12, marginTop: 6 }} />
            <div className="sk-line" style={{ width: "55%", height: 12, marginTop: 8 }} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function AuditView() {
  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  async function run() {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<AuditFinding[]>("run_audit");
      setFindings(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { run(); }, []);

  const counts = {
    crit: findings.filter((f) => f.level === "CRIT").length,
    warn: findings.filter((f) => f.level === "WARN").length,
    info: findings.filter((f) => f.level === "INFO").length,
  };

  const grouped: Record<string, AuditFinding[]> = {};
  for (const f of findings) (grouped[f.category] ||= []).push(f);
  const categories = Object.keys(grouped).sort();

  return (
    <>
      <div className="view-bar">
        <div className="audit-summary">
          <span className={"audit-pill crit" + (counts.crit ? " active" : "")}>
            <AlertTriangle size={12} /> {counts.crit} crit
          </span>
          <span className={"audit-pill warn" + (counts.warn ? " active" : "")}>
            <AlertTriangle size={12} /> {counts.warn} warn
          </span>
          <span className={"audit-pill info" + (counts.info ? " active" : "")}>
            <Info size={12} /> {counts.info} info
          </span>
        </div>
        <div className="filters">
          <button className="ghost icon-btn" onClick={run} title="Re-run audit">
            <RefreshCw size={14} className={loading ? "spinning" : ""} />
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="state">
          <ShieldCheck size={32} className="state-icon spinning" />
          Running audit…
        </div>
      ) : findings.length === 0 ? (
        <div className="state">No findings.</div>
      ) : (
        <div className="audit-categories">
          {categories.map((cat) => {
            const isCollapsed = collapsed[cat];
            const catCounts = {
              crit: grouped[cat].filter((f) => f.level === "CRIT").length,
              warn: grouped[cat].filter((f) => f.level === "WARN").length,
            };
            return (
              <section key={cat} className="audit-category">
                <button
                  className="audit-category-header"
                  onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span>{cat}</span>
                  <span className="audit-cat-count">
                    {grouped[cat].length}
                    {catCounts.crit > 0 && <span className="dot dot-crit" />}
                    {catCounts.warn > 0 && <span className="dot dot-warn" />}
                  </span>
                </button>
                {!isCollapsed && (
                  <ul>
                    {grouped[cat].map((f, i) => (
                      <li key={i} className={"audit-finding lvl-" + f.level.toLowerCase()}>
                        <span className={"audit-level lvl-" + f.level.toLowerCase()}>{f.level}</span>
                        <div className="audit-body">
                          <div className="audit-title">{f.title}</div>
                          {f.detail && <div className="audit-detail">{f.detail}</div>}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

function PrsView() {
  const [prs, setPrs] = useState<GhPullRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<GhPullRequest[]>("github_review_queue", { limit: 20 });
      setPrs(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  async function open(url: string) {
    try { await invoke("open_url", { url }); } catch (e) { setError(String(e)); }
  }

  return (
    <>
      <div className="view-bar">
        <div className="summary">
          <strong>{prs.length}</strong> awaiting your review
        </div>
        <div className="filters">
          <button className="ghost icon-btn" onClick={load} title="Refresh">
            <RefreshCw size={14} className={loading ? "spinning" : ""} />
          </button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="state">
          <GitPullRequest size={32} className="state-icon" />
          Querying GitHub…
        </div>
      ) : prs.length === 0 ? (
        <div className="state">
          <ShieldCheck size={32} className="state-icon" />
          No PRs requesting your review. Inbox zero, hermano.
        </div>
      ) : (
        <ul className="prs">
          {prs.map((pr) => (
            <li key={pr.url} className="pr">
              <div className="pr-main">
                <div className="pr-title">
                  <GitPullRequest size={14} className="pr-icon" />
                  {pr.title}
                </div>
                <div className="pr-meta">
                  <span className="pr-repo">{pr.repository}</span>
                  <span className="dim">·</span>
                  <span>by {pr.author}</span>
                  <span className="dim">·</span>
                  <span>{pr.created_at.slice(0, 10)}</span>
                </div>
              </div>
              <button onClick={() => open(pr.url)}>
                Open <ExternalLink size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function CleanupView() {
  const [plan, setPlan] = useState<CleanupItem[]>([]);
  const [olderThan, setOlderThan] = useState(30);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [confirming, setConfirming] = useState(false);

  async function refresh(days: number) {
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await invoke<CleanupItem[]>("cleanup_plan", { olderThanDays: days });
      setPlan(res);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { refresh(olderThan); }, [olderThan]);

  async function applyCleanup() {
    setError(null);
    try {
      const res = await invoke<CleanupResult>("cleanup_apply", {
        paths: plan.map((i) => i.path),
      });
      setResult(res);
      setConfirming(false);
      refresh(olderThan);
    } catch (e) {
      setError(String(e));
      setConfirming(false);
    }
  }

  const totalBytes = plan.reduce((s, i) => s + i.bytes, 0);
  const grouped: Record<string, CleanupItem[]> = {};
  for (const i of plan) (grouped[i.category] ||= []).push(i);
  const cats = Object.keys(grouped).sort();

  return (
    <>
      <div className="view-bar">
        <div className="summary">
          <strong>{plan.length}</strong> items <span className="dim">·</span>
          <strong>{formatBytes(totalBytes)}</strong> reclaimable
        </div>
        <div className="filters">
          <label className="select-wrap">
            <select
              value={olderThan}
              onChange={(e) => setOlderThan(Number(e.currentTarget.value))}
            >
              <option value={7}>Older than 7d</option>
              <option value={14}>Older than 14d</option>
              <option value={30}>Older than 30d</option>
              <option value={60}>Older than 60d</option>
              <option value={90}>Older than 90d</option>
            </select>
          </label>
          <button className="ghost icon-btn" onClick={() => refresh(olderThan)} title="Re-scan">
            <RefreshCw size={14} className={loading ? "spinning" : ""} />
          </button>
          {plan.length > 0 && !confirming && (
            <button className="danger" onClick={() => setConfirming(true)}>
              <Trash2 size={14} /> Delete all
            </button>
          )}
          {confirming && (
            <>
              <button className="ghost" onClick={() => setConfirming(false)}>Cancel</button>
              <button className="danger" onClick={applyCleanup}>Confirm delete</button>
            </>
          )}
        </div>
      </div>

      {error && <div className="error">{error}</div>}
      {result && (
        <div className="result">
          <CheckCircle2 size={16} />
          Cleaned <strong>{result.deleted}</strong> items, freed <strong>{formatBytes(result.freed_bytes)}</strong>
          {result.failed > 0 && <span> · {result.failed} failed</span>}
        </div>
      )}

      {loading ? (
        <div className="state">Scanning disk…</div>
      ) : plan.length === 0 ? (
        <div className="state">
          <CheckCircle2 size={32} className="state-icon" />
          Nothing to clean. Disk feliz.
        </div>
      ) : (
        <div className="cleanup-categories">
          {cats.map((cat) => {
            const items = grouped[cat];
            const sum = items.reduce((s, i) => s + i.bytes, 0);
            return (
              <section key={cat} className="cleanup-cat">
                <header>
                  <span className="cleanup-cat-name">{cat}</span>
                  <span className="cleanup-cat-meta">
                    {items.length} · {formatBytes(sum)}
                  </span>
                </header>
                <ul>
                  {items.slice(0, 8).map((i) => (
                    <li key={i.path}>
                      <span className="cleanup-date">{formatDate(i.mtime)}</span>
                      <span className="cleanup-size">{formatBytes(i.bytes)}</span>
                      <span className="cleanup-name" title={i.path}>
                        {i.path.split(/[\\/]/).pop()}
                      </span>
                    </li>
                  ))}
                  {items.length > 8 && (
                    <li className="cleanup-more">… and {items.length - 8} more</li>
                  )}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </>
  );
}

const THEMES = ["default", "dracula", "nord", "solarized", "monochrome"] as const;
type Theme = typeof THEMES[number];

function ThemePicker({ theme, onChange }: { theme: Theme; onChange: (t: Theme) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="theme-picker">
      <button
        className="ghost icon-btn"
        onClick={() => setOpen((o) => !o)}
        title="Theme"
      >
        <Palette size={14} />
      </button>
      {open && (
        <div className="theme-menu" onMouseLeave={() => setOpen(false)}>
          {THEMES.map((t) => (
            <button
              key={t}
              className={"theme-option" + (t === theme ? " active" : "")}
              onClick={() => {
                onChange(t);
                setOpen(false);
              }}
            >
              <span className={`theme-swatch theme-${t}`} />
              {t}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>("projects");
  const [windowDays, setWindowDays] = useState(14);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("csk-theme");
    return (saved && THEMES.includes(saved as Theme) ? saved : "default") as Theme;
  });

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("csk-theme", theme);
  }, [theme]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="logo-dot" />
          <h1>Claude Startup Kit</h1>
        </div>
        <nav className="tabs">
          <button
            className={"tab" + (tab === "projects" ? " active" : "")}
            onClick={() => setTab("projects")}
          >
            <FolderOpen size={14} />
            Projects
          </button>
          <button
            className={"tab" + (tab === "audit" ? " active" : "")}
            onClick={() => setTab("audit")}
          >
            <Activity size={14} />
            Audit
          </button>
          <button
            className={"tab" + (tab === "prs" ? " active" : "")}
            onClick={() => setTab("prs")}
          >
            <GitPullRequest size={14} />
            PRs
          </button>
          <button
            className={"tab" + (tab === "cleanup" ? " active" : "")}
            onClick={() => setTab("cleanup")}
          >
            <Trash2 size={14} />
            Cleanup
          </button>
        </nav>
        <ThemePicker theme={theme} onChange={setTheme} />
      </header>

      <main className="container">
        <div key={tab} className="tab-content">
          {tab === "projects" && (
            <ProjectsView windowDays={windowDays} setWindowDays={setWindowDays} />
          )}
          {tab === "audit" && <AuditView />}
          {tab === "prs" && <PrsView />}
          {tab === "cleanup" && <CleanupView />}
        </div>
      </main>
    </div>
  );
}

export default App;
