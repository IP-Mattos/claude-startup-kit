import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Search } from "lucide-react";

import type { GitInfo, Project } from "../types";
import { friendlyError, projectName } from "../lib/format";
import { enrichProjects } from "../lib/enrichProjects";
import { useDebouncedValue } from "../hooks/useDebouncedValue";
import { FrameCorners } from "../components/FrameCorners";
import { ProjectRow } from "../components/ProjectRow";

function ProjectsSkeleton() {
  return (
    <ul className="projects">
      {[0, 1, 2, 3].map((i) => (
        <li key={i} className="project skeleton">
          <FrameCorners />
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

export type ProjectsViewProps = {
  windowDays: number;
  setWindowDays: (n: number) => void;
  onCount: (n: number) => void;
  refreshNonce: number;
  searchInputRef?: RefObject<HTMLInputElement | null>;
};

export default function ProjectsView({
  windowDays,
  setWindowDays,
  onCount,
  refreshNonce,
  searchInputRef,
}: ProjectsViewProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [gitInfo, setGitInfo] = useState<Record<string, GitInfo | null>>({});
  const [goals, setGoals] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 300);
  const localInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = searchInputRef ?? localInputRef;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const res = await invoke<Project[]>("scan_projects", { windowDays });
        if (cancelled) return;
        setProjects(res);
        const known = await invoke<string[]>("engram_known_projects").catch(
          () => [] as string[]
        );
        if (cancelled) return;
        const enrichment = await enrichProjects(res, known);
        if (cancelled) return;
        const gits: Record<string, GitInfo | null> = {};
        const gs: Record<string, string | null> = {};
        for (const p of res) {
          const e = enrichment[p.path];
          gits[p.path] = e?.git ?? null;
          gs[p.path] = e?.goal ?? null;
        }
        setGitInfo(gits);
        setGoals(gs);
      } catch (e) {
        if (!cancelled) setError(friendlyError(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [windowDays, refreshNonce]);

  useEffect(() => {
    onCount(projects.length);
  }, [projects.length, onCount]);

  async function openCode(path: string) {
    try {
      await invoke("open_in_vscode", { path });
    } catch (e) {
      setError(friendlyError(e));
    }
  }
  async function openExplorer(path: string) {
    try {
      await invoke("open_path_in_explorer", { path });
    } catch (e) {
      setError(friendlyError(e));
    }
  }

  const filtered = useMemo(() => {
    if (!debouncedQuery.trim()) return projects;
    const q = debouncedQuery.toLowerCase();
    return projects.filter(
      (p) =>
        projectName(p.path).toLowerCase().includes(q) ||
        p.path.toLowerCase().includes(q) ||
        (goals[p.path] ?? "").toLowerCase().includes(q)
    );
  }, [projects, debouncedQuery, goals]);

  const todayCount = projects.filter((p) => p.days_ago <= 1).length;

  return (
    <>
      <div className="view-bar">
        <div className="search">
          <Search size={14} />
          <input
            ref={inputRef}
            placeholder="Buscar proyectos, rutas, goals…"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
        <div className="filters">
          <span className="summary">
            <strong>{projects.length}</strong> activos <span className="dim">·</span>
            <strong>{todayCount}</strong> hoy
          </span>
          <label className="select-wrap">
            <select
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.currentTarget.value))}
            >
              <option value={1}>Últimas 24h</option>
              <option value={7}>Últimos 7 días</option>
              <option value={14}>Últimos 14 días</option>
              <option value={30}>Últimos 30 días</option>
            </select>
          </label>
          {loading && <RefreshCw size={14} className="spinning" />}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      {loading ? (
        <ProjectsSkeleton />
      ) : filtered.length === 0 ? (
        <div className="state">
          {projects.length === 0
            ? `No hay proyectos activos en los últimos ${windowDays} días.`
            : `Sin resultados para "${debouncedQuery}".`}
        </div>
      ) : (
        <ul className="projects">
          {filtered.map((p, i) => (
            <ProjectRow
              key={p.path}
              project={p}
              index={i}
              git={gitInfo[p.path] ?? null}
              goal={goals[p.path] ?? null}
              onOpenCode={openCode}
              onOpenExplorer={openExplorer}
            />
          ))}
        </ul>
      )}
    </>
  );
}
