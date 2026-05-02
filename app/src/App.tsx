import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  FolderOpen,
  GitPullRequest,
  MessageCircle,
  Trash2,
} from "lucide-react";
import "./App.css";
import { THEMES, type Tab, type Theme } from "./types";
import { Titlebar } from "./components/Titlebar";
import { StatusBar } from "./components/StatusBar";
import { ThemePicker } from "./components/ThemePicker";
import { ViewSkeleton } from "./components/ViewSkeleton";

const CompanionView = lazy(() => import("./views/CompanionView"));
const ProjectsView = lazy(() => import("./views/ProjectsView"));
const AuditView = lazy(() => import("./views/AuditView"));
const PrsView = lazy(() => import("./views/PrsView"));
const CleanupView = lazy(() => import("./views/CleanupView"));

function Ornament() {
  return (
    <svg className="ornament" viewBox="0 0 80 12" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <line x1="0" y1="6" x2="28" y2="6" stroke="currentColor" strokeWidth="0.6" />
      <line x1="0" y1="3" x2="14" y2="3" stroke="currentColor" strokeWidth="0.4" opacity="0.5" />
      <line x1="0" y1="9" x2="14" y2="9" stroke="currentColor" strokeWidth="0.4" opacity="0.5" />
      <path d="M30 6 L34 3 L34 9 Z" fill="currentColor" opacity="0.85" />
      <path d="M40 6 m-3 0 a3 3 0 1 0 6 0 a3 3 0 1 0 -6 0" fill="none" stroke="currentColor" strokeWidth="0.6" />
      <circle cx="40" cy="6" r="1" fill="currentColor" />
      <path d="M50 6 L46 3 L46 9 Z" fill="currentColor" opacity="0.85" />
      <line x1="52" y1="6" x2="80" y2="6" stroke="currentColor" strokeWidth="0.6" />
      <line x1="66" y1="3" x2="80" y2="3" stroke="currentColor" strokeWidth="0.4" opacity="0.5" />
      <line x1="66" y1="9" x2="80" y2="9" stroke="currentColor" strokeWidth="0.4" opacity="0.5" />
    </svg>
  );
}

const TABS: ReadonlyArray<Tab> = ["companion", "projects", "audit", "prs", "cleanup"];

function App() {
  const [tab, setTab] = useState<Tab>("companion");
  const [windowDays, setWindowDays] = useState(14);
  const [statusCount, setStatusCount] = useState(0);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("csk-theme");
    return (saved && THEMES.includes(saved as Theme) ? saved : "kawaii") as Theme;
  });

  // Per-tab refresh nonces — bumping triggers re-fetch in the corresponding view.
  const [refreshNonces, setRefreshNonces] = useState<Record<Tab, number>>({
    companion: 0,
    projects: 0,
    audit: 0,
    prs: 0,
    cleanup: 0,
  });

  const projectsSearchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("csk-theme", theme);
  }, [theme]);

  const refreshCurrent = useCallback((target: Tab) => {
    setRefreshNonces((prev) => ({ ...prev, [target]: prev[target] + 1 }));
  }, []);

  // Global keyboard shortcuts: Cmd/Ctrl+1..5 switch tabs, Cmd/Ctrl+K focus search,
  // Cmd/Ctrl+R refreshes current view.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Number keys 1..5 switch tabs.
      if (e.key >= "1" && e.key <= "5") {
        const idx = Number(e.key) - 1;
        const next = TABS[idx];
        if (next) {
          e.preventDefault();
          setTab(next);
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        setTab("projects");
        // Defer to next tick so the input exists if just switched.
        window.setTimeout(() => projectsSearchRef.current?.focus(), 50);
        return;
      }
      if (k === "r") {
        e.preventDefault();
        setTab((current) => {
          refreshCurrent(current);
          return current;
        });
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [refreshCurrent]);

  return (
    <div className="app">
      <Titlebar />
      <header className="topbar">
        <Ornament />
        <nav className="tabs">
          <button
            className={"tab" + (tab === "companion" ? " active" : "")}
            onClick={() => setTab("companion")}
          >
            <MessageCircle size={14} />
            Compañera
          </button>
          <button
            className={"tab" + (tab === "projects" ? " active" : "")}
            onClick={() => setTab("projects")}
          >
            <FolderOpen size={14} />
            Proyectos
          </button>
          <button
            className={"tab" + (tab === "audit" ? " active" : "")}
            onClick={() => setTab("audit")}
          >
            <Activity size={14} />
            Auditoría
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
            Limpieza
          </button>
        </nav>
        <ThemePicker theme={theme} onChange={setTheme} />
        <Ornament />
      </header>

      <main className="container">
        <div key={tab} className="tab-content">
          <Suspense fallback={<ViewSkeleton />}>
            {tab === "companion" && (
              <CompanionView
                windowDays={windowDays}
                onCount={setStatusCount}
                refreshNonce={refreshNonces.companion}
                theme={theme}
              />
            )}
            {tab === "projects" && (
              <ProjectsView
                windowDays={windowDays}
                setWindowDays={setWindowDays}
                onCount={setStatusCount}
                refreshNonce={refreshNonces.projects}
                searchInputRef={projectsSearchRef}
              />
            )}
            {tab === "audit" && (
              <AuditView onCount={setStatusCount} refreshNonce={refreshNonces.audit} />
            )}
            {tab === "prs" && (
              <PrsView onCount={setStatusCount} refreshNonce={refreshNonces.prs} />
            )}
            {tab === "cleanup" && (
              <CleanupView onCount={setStatusCount} refreshNonce={refreshNonces.cleanup} />
            )}
          </Suspense>
        </div>
      </main>
      <StatusBar tab={tab} itemCount={statusCount} windowDays={windowDays} />
    </div>
  );
}

export default App;
