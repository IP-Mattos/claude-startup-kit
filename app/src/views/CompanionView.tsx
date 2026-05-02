import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  ExternalLink,
  Folder,
  FolderOpen,
  RefreshCw,
  Sparkles,
  Target,
} from "lucide-react";
import type {
  AuditFinding,
  GhPullRequest,
  Insight,
  InsightAction,
  Project,
  Theme,
} from "../types";
import {
  activityLabel,
  friendlyError,
  hexId,
  projectName,
} from "../lib/format";
import { enrichProjects } from "../lib/enrichProjects";
import { FrameCorners } from "../components/FrameCorners";

function buildInsights(
  projects: Project[],
  goals: Record<string, string | null>,
  findings: AuditFinding[],
  prs: GhPullRequest[]
): Insight[] {
  const out: Insight[] = [];
  const today = projects.filter((p) => p.days_ago <= 1);
  const stale = projects.filter((p) => p.days_ago > 7);
  const crit = findings.filter((f) => f.level === "CRIT").length;
  const warn = findings.filter((f) => f.level === "WARN").length;

  if (today.length > 0) {
    const top = today[0];
    out.push({
      kind: "info",
      text: `Hoy estás en **${projectName(top.path)}**. ${
        goals[top.path] ? `Goal: "${goals[top.path]}"` : "Sin goal en Engram."
      }`,
      actions: [
        { label: `Abrir ${projectName(top.path)}`, projectPath: top.path },
      ],
    });
  } else if (projects.length > 0) {
    out.push({
      kind: "nudge",
      text: `No tocaste nada hoy todavía. ¿Arrancamos por **${projectName(
        projects[0].path
      )}**?`,
      actions: [
        { label: `Abrir ${projectName(projects[0].path)}`, projectPath: projects[0].path },
      ],
    });
  }

  if (crit > 0) {
    out.push({
      kind: "warn",
      text: `Hay **${crit} CRIT** en el audit que están sin atender. Te conviene mirarlos.`,
    });
  } else if (warn > 0) {
    out.push({
      kind: "info",
      text: `${warn} WARN en el audit — nada urgente, pero podés limpiar cuando tengas un rato.`,
    });
  } else if (findings.length > 0) {
    out.push({
      kind: "praise",
      text: `Audit limpio. Ninguna alerta. **Bien ahí, hermano**.`,
    });
  }

  if (prs.length > 0) {
    out.push({
      kind: "nudge",
      text: `Tenés **${prs.length} PR${prs.length > 1 ? "s" : ""}** esperando tu review. ${
        prs.length > 5 ? "Está creciendo la queue." : ""
      }`,
      actions: prs.slice(0, 2).map((pr) => ({
        label: pr.repository.split("/").pop() || pr.title.slice(0, 24),
        url: pr.url,
      })),
    });
  }

  if (stale.length >= 3) {
    out.push({
      kind: "info",
      text: `**${stale.length} proyectos** llevan más de una semana sin tocar (${stale
        .slice(0, 3)
        .map((p) => projectName(p.path))
        .join(", ")}${stale.length > 3 ? "…" : ""}).`,
    });
  }

  if (today.length >= 3) {
    out.push({
      kind: "praise",
      text: `**${today.length} proyectos en marcha hoy**. Día productivo.`,
    });
  }

  return out;
}

// Per-theme avatar assets. Falls back to Sia2.webp.
const AVATAR_BY_THEME: Partial<Record<Theme, string>> = {
  gameboy: "/GameBoySia.png",
};

function CompanionAvatar({ theme }: { theme: Theme }) {
  const [errored, setErrored] = useState(false);
  const src = AVATAR_BY_THEME[theme] ?? "/Sia2.webp";
  if (errored) {
    return (
      <div className="companion-frame">
        <svg
          className="companion-avatar-fallback"
          viewBox="0 0 120 140"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id="cg" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.4" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0.1" />
            </linearGradient>
          </defs>
          <ellipse cx="60" cy="58" rx="28" ry="34" fill="url(#cg)" stroke="currentColor" strokeWidth="1.2" />
          <path d="M32 60 Q32 90 60 92 Q88 90 88 60" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <path d="M30 56 Q40 30 60 32 Q80 30 90 56 L86 70 Q60 50 34 70 Z" fill="currentColor" opacity="0.5" />
          <circle cx="50" cy="60" r="2" fill="currentColor" />
          <circle cx="70" cy="60" r="2" fill="currentColor" />
          <path d="M50 70 Q60 75 70 70" fill="none" stroke="currentColor" strokeWidth="1" />
          <path d="M40 100 L40 140 L80 140 L80 100" fill="none" stroke="currentColor" strokeWidth="1.2" />
          <line x1="60" y1="100" x2="60" y2="140" stroke="currentColor" strokeWidth="0.8" opacity="0.6" />
        </svg>
        <div className="companion-missing">
          save image at
          <br />
          <code>app/public/{src.replace("/", "")}</code>
        </div>
      </div>
    );
  }
  return (
    <div className="companion-frame">
      <img
        className="companion-avatar"
        src={src}
        alt="Companion"
        onError={() => setErrored(true)}
      />
      <div className="companion-tint" aria-hidden="true" />
      <div className="companion-scan" aria-hidden="true" />
    </div>
  );
}

async function openCode(path: string, onError: (e: string) => void) {
  try {
    await invoke("open_in_vscode", { path });
  } catch (e) {
    onError(friendlyError(e));
  }
}

async function openExplorer(path: string, onError: (e: string) => void) {
  try {
    await invoke("open_path_in_explorer", { path });
  } catch (e) {
    onError(friendlyError(e));
  }
}

async function openUrl(url: string, onError: (e: string) => void) {
  try {
    await invoke("open_url", { url });
  } catch (e) {
    onError(friendlyError(e));
  }
}

function ActionChip({
  action,
  onError,
}: {
  action: InsightAction;
  onError: (e: string) => void;
}) {
  const handle = () => {
    if (action.projectPath) openCode(action.projectPath, onError);
    else if (action.url) openUrl(action.url, onError);
  };
  return (
    <button className="action-chip" onClick={handle}>
      {action.projectPath ? <FolderOpen size={12} /> : <ExternalLink size={12} />}
      {action.label}
    </button>
  );
}

function CompanionBubble({
  insight,
  delay,
  onError,
}: {
  insight: Insight;
  delay: number;
  onError: (e: string) => void;
}) {
  const parts = insight.text.split(/(\*\*[^*]+\*\*)/g);
  return (
    <div
      className={`bubble bubble-${insight.kind}`}
      style={{ animationDelay: `${delay}ms` }}
    >
      <FrameCorners />
      <p>
        {parts.map((p, i) =>
          p.startsWith("**") && p.endsWith("**") ? (
            <strong key={i}>{p.slice(2, -2)}</strong>
          ) : (
            <span key={i}>{p}</span>
          )
        )}
      </p>
      {insight.actions && insight.actions.length > 0 && (
        <div className="bubble-actions">
          {insight.actions.map((a, i) => (
            <ActionChip key={i} action={a} onError={onError} />
          ))}
        </div>
      )}
    </div>
  );
}

function ProjectQuickCard({
  project,
  goal,
  onError,
}: {
  project: Project;
  goal: string | null;
  onError: (e: string) => void;
}) {
  return (
    <article className="quick-card" style={{ animationDelay: `${Math.random() * 200}ms` }}>
      <FrameCorners />
      <div className="quick-card-head">
        <span className="quick-card-name">
          <FolderOpen size={14} /> {projectName(project.path)}
        </span>
        <span className={`badge ${project.days_ago <= 1 ? "badge-fresh" : ""}`}>
          {activityLabel(project.days_ago)}
        </span>
      </div>
      {goal && (
        <div className="quick-card-goal">
          <Target size={11} className="goal-icon" />
          <span>{goal}</span>
        </div>
      )}
      <div className="quick-card-actions">
        <button onClick={() => openCode(project.path, onError)}>
          Abrir en VS Code
        </button>
        <button
          className="ghost icon-btn"
          onClick={() => openExplorer(project.path, onError)}
          title="Abrir en Explorer"
        >
          <Folder size={13} />
        </button>
      </div>
    </article>
  );
}

export type CompanionViewProps = {
  windowDays: number;
  onCount: (n: number) => void;
  refreshNonce: number;
  theme: Theme;
};

export default function CompanionView({
  windowDays,
  onCount,
  refreshNonce,
  theme,
}: CompanionViewProps) {
  const [insights, setInsights] = useState<Insight[]>([]);
  const [topProjects, setTopProjects] = useState<Project[]>([]);
  const [goals, setGoals] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const projectsP = invoke<Project[]>("scan_projects", { windowDays });
        const knownP = invoke<string[]>("engram_known_projects").catch(
          () => [] as string[]
        );
        const findingsP = invoke<AuditFinding[]>("run_audit").catch(
          () => [] as AuditFinding[]
        );
        const prsP = invoke<GhPullRequest[]>("github_review_queue", { limit: 20 }).catch(
          () => [] as GhPullRequest[]
        );
        const [projects, known, findings, prs] = await Promise.all([
          projectsP,
          knownP,
          findingsP,
          prsP,
        ]);
        if (cancelled) return;
        const enrichment = await enrichProjects(projects, known);
        if (cancelled) return;
        const goalMap: Record<string, string | null> = {};
        for (const p of projects) goalMap[p.path] = enrichment[p.path]?.goal ?? null;
        setGoals(goalMap);
        // Show top 6 projects, prioritising freshest
        setTopProjects(projects.slice(0, 6));
        setInsights(buildInsights(projects, goalMap, findings, prs));
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
    onCount(insights.length + topProjects.length);
  }, [insights.length, topProjects.length, onCount]);

  return (
    <>
      <div className="view-bar">
        <div className="summary">
          <Sparkles size={14} className="goal-icon" />
          <strong>Compañera</strong>
          <span className="dim">
            · {insights.length} insights · {topProjects.length} proyectos
          </span>
        </div>
        <div className="filters">
          {loading && <RefreshCw size={14} className="spinning" />}
        </div>
      </div>

      {error && <div className="error">{error}</div>}

      <div className="companion-stage">
        <div className="companion-portrait">
          <FrameCorners />
          <CompanionAvatar theme={theme} />
          <div className="companion-name">
            <span className="hex-id">0x{hexId("companion")}</span>
            <span className="companion-title">Compañera</span>
          </div>
        </div>

        <div className="companion-right">
          <div className="bubbles">
            {loading ? (
              <div className="state">Leyendo el contexto…</div>
            ) : insights.length === 0 ? (
              <div className="state">Nada para reportar hoy. Todo en orden.</div>
            ) : (
              insights.map((ins, i) => (
                <CompanionBubble
                  key={i}
                  insight={ins}
                  delay={i * 120}
                  onError={setError}
                />
              ))
            )}
          </div>

          {topProjects.length > 0 && (
            <section className="quick-projects">
              <header className="quick-projects-head">
                <h3>Tus proyectos</h3>
                <span className="dim">
                  {topProjects.length} más recientes · click para abrir
                </span>
              </header>
              <div className="quick-projects-grid">
                {topProjects.map((p) => (
                  <ProjectQuickCard
                    key={p.path}
                    project={p}
                    goal={goals[p.path] ?? null}
                    onError={setError}
                  />
                ))}
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
