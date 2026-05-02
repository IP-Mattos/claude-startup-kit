import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
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

type Tab = "projects" | "audit" | "prs";

function projectName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function activityLabel(daysAgo: number): string {
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  return `${daysAgo}d ago`;
}

function ProjectsView({ windowDays, setWindowDays }: { windowDays: number; setWindowDays: (n: number) => void }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [gitInfo, setGitInfo] = useState<Record<string, GitInfo | null>>({});
  const [goals, setGoals] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function refresh(days: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<Project[]>("scan_projects", { windowDays: days });
      setProjects(res);
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
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh(windowDays);
  }, [windowDays]);

  async function openCode(path: string) {
    try {
      await invoke("open_in_vscode", { path });
    } catch (e) {
      setError(String(e));
    }
  }

  async function openExplorer(path: string) {
    try {
      await invoke("open_path_in_explorer", { path });
    } catch (e) {
      setError(String(e));
    }
  }

  const todayCount = projects.filter((p) => p.days_ago <= 1).length;

  return (
    <>
      <div className="view-bar">
        <div className="summary">
          <span><strong>{projects.length}</strong> active projects</span>
          <span className="dim">·</span>
          <span><strong>{todayCount}</strong> touched today</span>
        </div>
        <div className="filters">
          <label>
            Last
            <select value={windowDays} onChange={(e) => setWindowDays(Number(e.currentTarget.value))}>
              <option value={1}>24h</option>
              <option value={7}>7d</option>
              <option value={14}>14d</option>
              <option value={30}>30d</option>
            </select>
          </label>
          <button className="ghost" onClick={() => refresh(windowDays)}>Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="state">Scanning…</div>
      ) : projects.length === 0 ? (
        <div className="state">No active projects in the last {windowDays} days.</div>
      ) : (
        <ul className="projects">
          {projects.map((p) => (
            <li key={p.path} className="project">
              <div className="project-main">
                <div className="project-name">{projectName(p.path)}</div>
                <div className="project-path">{p.path}</div>
                {goals[p.path] && (
                  <div className="project-goal">
                    <span className="goal-label">Goal</span>
                    <span className="goal-text">{goals[p.path]}</span>
                  </div>
                )}
                {gitInfo[p.path] && (
                  <div className="project-git">
                    <span className="git-hash">{gitInfo[p.path]!.hash}</span>
                    <span className="git-subject">{gitInfo[p.path]!.subject}</span>
                    <span className="git-ago">· {gitInfo[p.path]!.ago}</span>
                  </div>
                )}
              </div>
              <div className="project-meta">
                <span className="badge">{activityLabel(p.days_ago)}</span>
                <span className="date">{p.last_date}</span>
              </div>
              <div className="project-actions">
                <button onClick={() => openCode(p.path)}>Open in VS Code</button>
                <button className="ghost" onClick={() => openExplorer(p.path)}>Explorer</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function AuditView() {
  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
  for (const f of findings) {
    (grouped[f.category] ||= []).push(f);
  }
  const categories = Object.keys(grouped).sort();

  return (
    <>
      <div className="view-bar">
        <div className="audit-summary">
          <span className={"audit-pill crit" + (counts.crit ? " active" : "")}>{counts.crit} CRIT</span>
          <span className={"audit-pill warn" + (counts.warn ? " active" : "")}>{counts.warn} WARN</span>
          <span className={"audit-pill info" + (counts.info ? " active" : "")}>{counts.info} INFO</span>
        </div>
        <div className="filters">
          <button className="ghost" onClick={run}>Re-run</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="state">Running audit…</div>
      ) : findings.length === 0 ? (
        <div className="state">No findings.</div>
      ) : (
        <div className="audit-categories">
          {categories.map((cat) => (
            <section key={cat} className="audit-category">
              <h3>{cat}</h3>
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
            </section>
          ))}
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
          <span><strong>{prs.length}</strong> awaiting your review</span>
        </div>
        <div className="filters">
          <button className="ghost" onClick={load}>Refresh</button>
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="state">Querying GitHub…</div>
      ) : prs.length === 0 ? (
        <div className="state">No PRs requesting your review. Inbox zero, hermano.</div>
      ) : (
        <ul className="prs">
          {prs.map((pr) => (
            <li key={pr.url} className="pr">
              <div className="pr-main">
                <div className="pr-title">{pr.title}</div>
                <div className="pr-meta">
                  <span className="pr-repo">{pr.repository}</span>
                  <span className="dim">·</span>
                  <span>by {pr.author}</span>
                  <span className="dim">·</span>
                  <span>{pr.created_at.slice(0, 10)}</span>
                </div>
              </div>
              <button onClick={() => open(pr.url)}>Open</button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function App() {
  const [tab, setTab] = useState<Tab>("projects");
  const [windowDays, setWindowDays] = useState(14);

  return (
    <main className="container">
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
            Projects
          </button>
          <button
            className={"tab" + (tab === "audit" ? " active" : "")}
            onClick={() => setTab("audit")}
          >
            Audit
          </button>
          <button
            className={"tab" + (tab === "prs" ? " active" : "")}
            onClick={() => setTab("prs")}
          >
            PRs
          </button>
        </nav>
      </header>

      {tab === "projects" && (
        <ProjectsView windowDays={windowDays} setWindowDays={setWindowDays} />
      )}
      {tab === "audit" && <AuditView />}
      {tab === "prs" && <PrsView />}
    </main>
  );
}

export default App;
