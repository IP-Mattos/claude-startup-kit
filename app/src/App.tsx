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

function projectName(path: string): string {
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function activityLabel(daysAgo: number): string {
  if (daysAgo <= 0) return "today";
  if (daysAgo === 1) return "yesterday";
  return `${daysAgo}d ago`;
}

function App() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [gitInfo, setGitInfo] = useState<Record<string, GitInfo | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowDays, setWindowDays] = useState(14);

  async function refresh(days: number) {
    setLoading(true);
    setError(null);
    try {
      const res = await invoke<Project[]>("scan_projects", { windowDays: days });
      setProjects(res);
      const entries = await Promise.all(
        res.map(async (p) => {
          try {
            const g = await invoke<GitInfo | null>("git_last_commit", { path: p.path });
            return [p.path, g] as const;
          } catch {
            return [p.path, null] as const;
          }
        })
      );
      setGitInfo(Object.fromEntries(entries));
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
    <main className="container">
      <header className="topbar">
        <div className="brand">
          <span className="logo-dot" />
          <h1>Claude Startup Kit</h1>
        </div>
        <div className="filters">
          <label>
            Last
            <select
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.currentTarget.value))}
            >
              <option value={1}>24h</option>
              <option value={7}>7d</option>
              <option value={14}>14d</option>
              <option value={30}>30d</option>
            </select>
          </label>
          <button className="ghost" onClick={() => refresh(windowDays)}>
            Refresh
          </button>
        </div>
      </header>

      <section className="summary">
        <span>
          <strong>{projects.length}</strong> active projects
        </span>
        <span className="dim">·</span>
        <span>
          <strong>{todayCount}</strong> touched today
        </span>
      </section>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <div className="state">Scanning…</div>
      ) : projects.length === 0 ? (
        <div className="state">
          No active projects in the last {windowDays} days.
        </div>
      ) : (
        <ul className="projects">
          {projects.map((p) => (
            <li key={p.path} className="project">
              <div className="project-main">
                <div className="project-name">{projectName(p.path)}</div>
                <div className="project-path">{p.path}</div>
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
                <button className="ghost" onClick={() => openExplorer(p.path)}>
                  Explorer
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

export default App;
