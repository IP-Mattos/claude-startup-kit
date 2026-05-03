import React, { useEffect, useMemo, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import type {
  AuditFinding,
  GhPullRequest,
  Project,
  ProjectEnrichment,
} from "../types";
import { activityLabelEn, projectName, friendlyErrorEn, prNumberFromUrl } from "../lib/format";
import { parseAuditFindings } from "../lib/audit";
import { nextV3Theme, applyAndPersistV3Theme, readV3ThemeFromBody } from "../lib/themes";
import { enrichProjects } from "../lib/enrichProjects";
import { useUpdates } from "../lib/useUpdates";
import { useT, plural } from "../lib/i18n";
import {
  ProjectsViewV3,
  PrsViewV3,
  AuditViewV3,
  CleanupViewV3,
  ClaudeViewV3,
  CompanionsViewV3,
  SettingsViewV3,
} from "./views";

// Tauri APIs throw when loaded from a plain browser at localhost:1420
// (no __TAURI_INTERNALS__ global). Guard so AppV3 still renders for previews.
const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const safeGetCurrentWindow = () => {
  try {
    return IS_TAURI ? getCurrentWindow() : null;
  } catch {
    return null;
  }
};
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  Bot,
  Boxes,
  ChevronRight,
  Code2,
  Cog,
  FolderOpen,
  Palette,
  GitPullRequest,
  Home,
  Minus,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from "lucide-react";
import "./AppV3.css";

type V3Tab =
  | "overview"
  | "projects"
  | "prs"
  | "audit"
  | "cleanup"
  | "settings"
  | "claude"
  | "companions";

// Two-track navigation:
//   • SIDEBAR_NAV — high-frequency, operational tabs (one click away).
//   • TOPBAR_NAV  — low-frequency, meta tabs (config / introspection).
// The id stays English (canonical state); the label is resolved per render
// via useT() inside the component that consumes the array.
const SIDEBAR_NAV: {
  id: V3Tab;
  navKey: import("../lib/i18n").StringKey;
  Icon: typeof Home;
}[] = [
  { id: "overview", navKey: "nav.overview", Icon: Home },
  { id: "projects", navKey: "nav.projects", Icon: FolderOpen },
  { id: "prs", navKey: "nav.prs", Icon: GitPullRequest },
  { id: "audit", navKey: "nav.audit", Icon: Activity },
  { id: "cleanup", navKey: "nav.cleanup", Icon: Trash2 },
];

const TOPBAR_NAV: {
  id: V3Tab;
  navKey: import("../lib/i18n").StringKey;
  Icon: typeof Home;
}[] = [
  { id: "claude", navKey: "nav.claude", Icon: Boxes },
  { id: "companions", navKey: "nav.companions", Icon: Bot },
  { id: "settings", navKey: "nav.settings", Icon: Cog },
];

// ===== Topbar =====
// Brand on the left, low-frequency tabs (Claude / Companion / Settings)
// in the middle, window controls on the right. Sidebar owns the
// high-frequency operational tabs.
function TopbarV3({
  activeTab,
  onTab,
}: {
  activeTab: V3Tab;
  onTab: (t: V3Tab) => void;
}) {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    const win = safeGetCurrentWindow();
    if (!win) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    win.isMaximized().then((m) => !cancelled && setMaximized(m));
    win
      .onResized(() => {
        win.isMaximized().then((m) => !cancelled && setMaximized(m));
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  const win = safeGetCurrentWindow();
  const { t } = useT();

  return (
    <header className="v3-topbar" data-tauri-drag-region>
      <div className="v3-topbar-brand" data-tauri-drag-region>
        <span className="v3-brand-mark" aria-hidden="true">
          <img src="/Shield.svg" alt="" draggable={false} />
        </span>
        <span className="v3-brand-name">Claude Startup Kit</span>
      </div>
      <nav className="v3-topbar-nav">
        {TOPBAR_NAV.map(({ id, navKey, Icon }) => {
          const label = t(navKey);
          return (
            <button
              key={id}
              type="button"
              className={"v3-topbar-tab" + (activeTab === id ? " active" : "")}
              onClick={() => onTab(id)}
              aria-label={label}
            >
              <Icon size={13} strokeWidth={2} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>
      <div className="v3-topbar-spacer" data-tauri-drag-region />
      <div className="v3-window-controls">
        <button
          className="v3-wc"
          onClick={() => win?.minimize()}
          aria-label="Minimize"
        >
          <Minus size={14} strokeWidth={2.4} />
        </button>
        <button
          className="v3-wc"
          onClick={() => win?.toggleMaximize()}
          aria-label={maximized ? "Restore" : "Maximize"}
        >
          <Square size={12} strokeWidth={2.2} />
        </button>
        <button
          className="v3-wc v3-wc-close"
          onClick={() => win?.close()}
          aria-label="Close"
        >
          <X size={14} strokeWidth={2.4} />
        </button>
      </div>
    </header>
  );
}

// ===== Sidebar =====
function SidebarV3({
  activeTab,
  onTab,
  lastScanAgo,
  onRunAudit,
  critCount,
  warnCount,
  findingTotal,
}: {
  activeTab: V3Tab;
  onTab: (t: V3Tab) => void;
  lastScanAgo: string;
  onRunAudit: () => void;
  critCount: number;
  warnCount: number;
  findingTotal: number;
}) {
  const { t } = useT();
  // Single source of truth for the colored dot + headline. Critical wins
  // over warning, warning wins over OK; "no scan yet" is its own state so
  // the green light doesn't lie before the first audit runs.
  const tone =
    findingTotal === 0 && lastScanAgo === t("common.never")
      ? "idle"
      : critCount > 0
      ? "crit"
      : warnCount > 0
      ? "warn"
      : "ok";
  const headline =
    tone === "idle"
      ? t("status.idle")
      : tone === "crit"
      ? plural(t, critCount, "status.crit_one", "status.crit_other")
      : tone === "warn"
      ? plural(t, warnCount, "status.warn_one", "status.warn_other")
      : t("status.operational");
  return (
    <aside className="v3-sidebar" aria-label="Primary navigation">
      <div className="v3-sidebar-logo">
        <div className="v3-sidebar-logo-mark" aria-hidden="true">
          <img src="/Shield.svg" alt="" draggable={false} />
        </div>
        <div className="v3-sidebar-logo-text">
          <span className="v3-sidebar-logo-line1">CLAUDE</span>
          <span className="v3-sidebar-logo-line2">STARTUP KIT</span>
        </div>
      </div>

      <nav className="v3-sidebar-nav">
        {SIDEBAR_NAV.map(({ id, navKey, Icon }) => {
          const label = t(navKey);
          return (
            <button
              key={id}
              className={"v3-side-link" + (activeTab === id ? " active" : "")}
              onClick={() => onTab(id)}
              aria-label={label}
            >
              <Icon size={16} strokeWidth={1.8} />
              <span>{label}</span>
            </button>
          );
        })}
      </nav>

      <div className="v3-sidebar-spacer" />

      <div className={`v3-system-status v3-system-status-${tone}`}>
        <div className="v3-system-status-row">
          <span className="v3-status-dot" aria-hidden="true" />
          <span className="v3-system-status-headline">{headline}</span>
        </div>
        {(critCount > 0 || warnCount > 0) && (
          <div className="v3-system-status-stats">
            {critCount > 0 && (
              <span className="v3-system-status-stat v3-system-status-stat-crit">
                <span className="v3-system-status-stat-num">{critCount}</span>
                <span>{t("status.crit_short")}</span>
              </span>
            )}
            {warnCount > 0 && (
              <span className="v3-system-status-stat v3-system-status-stat-warn">
                <span className="v3-system-status-stat-num">{warnCount}</span>
                <span>{t("status.warn_short")}</span>
              </span>
            )}
          </div>
        )}
        <div className="v3-system-status-meta">
          {t("status.last_scan")} <strong>{lastScanAgo}</strong>
        </div>
        <button
          className="v3-btn-ghost v3-system-status-cta"
          onClick={onRunAudit}
        >
          <ShieldCheck size={13} strokeWidth={2} />
          <span>{t("status.run_audit")}</span>
        </button>
      </div>
    </aside>
  );
}

// ===== Stat card =====
type StatTint = "orange" | "purple" | "amber" | "green";
type DeltaSeverity = "good" | "warn" | "crit";
function StatCard({
  Icon,
  label,
  value,
  delta,
  tint,
  severity = "good",
}: {
  Icon: typeof Home;
  label: string;
  value: string;
  delta: string;
  tint: StatTint;
  severity?: DeltaSeverity;
}) {
  return (
    <article className="v3-stat-card">
      <div className={`v3-stat-icon v3-stat-icon-${tint}`} aria-hidden="true">
        <Icon size={18} strokeWidth={2} />
      </div>
      <div className="v3-stat-body">
        <div className="v3-stat-value">{value}</div>
        <div className="v3-stat-label">{label}</div>
        <div className={`v3-stat-delta v3-stat-delta-${severity}`}>
          <ArrowUp size={11} strokeWidth={2.2} />
          {delta}
        </div>
      </div>
    </article>
  );
}

// ===== Recent project card =====
function RecentProjectCard({
  name,
  desc,
  ago,
  freshness,
  onOpen,
}: {
  name: string;
  desc: string;
  ago: string;
  freshness: number;
  onOpen: () => void;
}) {
  const tint: "green" | "amber" = freshness >= 80 ? "green" : "amber";
  return (
    <article
      className="v3-recent-project"
      onClick={onOpen}
      onKeyDown={onKeyboardActivate(onOpen)}
      role="button"
      tabIndex={0}
      aria-label={`Open project ${name}`}
    >
      <header className="v3-recent-project-head">
        <span className="v3-recent-project-icon" aria-hidden="true">
          <Code2 size={13} strokeWidth={2} />
        </span>
        <span className="v3-recent-project-name">{name}</span>
      </header>
      <p className="v3-recent-project-desc">{desc}</p>
      <footer className="v3-recent-project-foot">
        <span className="v3-recent-ago">{ago}</span>
        <span className={`v3-pct-pill v3-pct-${tint}`}>{freshness}%</span>
      </footer>
    </article>
  );
}

// ===== Audit donut (CSS conic-gradient) =====
function AuditDonut({
  crit,
  warn,
  info,
}: {
  crit: number;
  warn: number;
  info: number;
}) {
  const total = crit + warn + info;
  if (total === 0) {
    return (
      <div
        className="v3-donut v3-donut-empty"
        role="img"
        aria-label="No audit findings"
      >
        <div className="v3-donut-hole">
          <div className="v3-donut-num">0</div>
          <div className="v3-donut-label">Total Findings</div>
        </div>
      </div>
    );
  }
  const critPct = (crit / total) * 100;
  const warnPct = (warn / total) * 100;
  const ring = `conic-gradient(
    #DC2626 0% ${critPct}%,
    #F59E0B ${critPct}% ${critPct + warnPct}%,
    #FCD34D ${critPct + warnPct}% 100%
  )`;
  return (
    <div
      className="v3-donut"
      style={{ background: ring }}
      role="img"
      aria-label={`Audit findings: ${crit} critical, ${warn} warning, ${info} info`}
    >
      <div className="v3-donut-hole">
        <div className="v3-donut-num">{total}</div>
        <div className="v3-donut-label">Total Findings</div>
      </div>
    </div>
  );
}

// Keyboard activation helper — turns role="button" divs into Enter/Space-clickable
const onKeyboardActivate = (fn: () => void) => (e: React.KeyboardEvent) => {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    fn();
  }
};

// ===== PR row =====
function PrRowV3({
  title,
  repo,
  num,
  onOpen,
}: {
  title: string;
  repo: string;
  num: number | null;
  onOpen: () => void;
}) {
  return (
    <div
      className="v3-pr-row"
      onClick={onOpen}
      onKeyDown={onKeyboardActivate(onOpen)}
      role="button"
      tabIndex={0}
      aria-label={`Open pull request ${title}`}
    >
      <span className="v3-pr-icon" aria-hidden="true">
        <GitPullRequest size={14} strokeWidth={2} />
      </span>
      <div className="v3-pr-body">
        <div className="v3-pr-title">{title}</div>
        <div className="v3-pr-meta">
          {num !== null ? `#${num} · ` : ""}
          {repo}
        </div>
      </div>
      <span className="v3-pr-pill v3-pr-pill-open">Open</span>
    </div>
  );
}

// Compute project freshness (0-100). days_ago = 0 → 100, days_ago = 14+ → 50.
function freshnessScore(daysAgo: number): number {
  if (daysAgo <= 0) return 100;
  if (daysAgo >= 30) return 50;
  return Math.round(100 - daysAgo * 1.7);
}

// ===== Companion widget =====
// Sidebar System Status already carries the crit/warn/scan counts. The
// companion is intentionally a soft nudge — single line that names the
// next thing worth looking at, never repeats the numbers themselves.
function CompanionWidget({
  companionName,
  companionImage,
  critCount,
  warnCount,
  prCount,
  todayProject,
  todayProjectPath,
  lastScanAgo,
  onJump,
  onOpenProject,
}: {
  companionName: string;
  companionImage: string | null;
  critCount: number;
  warnCount: number;
  prCount: number;
  todayProject: string | null;
  todayProjectPath: string | null;
  lastScanAgo: string;
  onJump: (tab: V3Tab) => void;
  onOpenProject: (path: string) => void;
}) {
  const { t } = useT();
  // The message keys for has_crits/has_warns/has_prs include a {n} that
  // should pop visually. We replace the first run of digits with a styled
  // span so the rest of the sentence stays plain — keeps i18n simple while
  // still drawing the eye to the number.
  const rawMessage =
    critCount > 0
      ? t("companion.has_crits", { n: critCount })
      : warnCount > 0
      ? t("companion.has_warns", { n: warnCount })
      : prCount > 0
      ? t("companion.has_prs", { n: prCount })
      : todayProject
      ? t("companion.today", { project: todayProject })
      : t("companion.idle");
  const message: React.ReactNode = (() => {
    const m = rawMessage.match(/^(.*?)(\d+)(.*)$/s);
    if (!m) return rawMessage;
    return (
      <>
        {m[1]}
        <strong className="v3-companion-emph">{m[2]}</strong>
        {m[3]}
      </>
    );
  })();

  // Pick the single most relevant action for the current state. Priority
  // matches the message above so the headline + button always agree.
  const action: { label: string; onClick: () => void } =
    critCount > 0 || warnCount > 0
      ? {
          label: t("companion.action_review_audit"),
          onClick: () => onJump("audit"),
        }
      : prCount > 0
      ? {
          label: t("companion.action_open_prs"),
          onClick: () => onJump("prs"),
        }
      : todayProject && todayProjectPath
      ? {
          label: t("companion.action_open_project"),
          onClick: () => onOpenProject(todayProjectPath),
        }
      : {
          label: t("companion.action_browse_projects"),
          onClick: () => onJump("projects"),
        };

  const avatarSrc = companionImage ?? "/Sia2.webp";

  return (
    <section className="v3-companion-widget">
      <header className="v3-companion-head">
        <span className="v3-companion-title">{companionName}</span>
        <span className="v3-companion-status">
          <span className="v3-status-dot" aria-hidden="true" />
          {t("companion.online")}
        </span>
      </header>
      <div className="v3-companion-stage">
        <div className="v3-companion-avatar" aria-hidden="true">
          <img src={avatarSrc} alt="" draggable={false} />
        </div>
      </div>
      <div className="v3-companion-message">{message}</div>
      <div className="v3-companion-foot">
        <span className="v3-companion-scan">
          {t("companion.stat_scan")} · <strong>{lastScanAgo}</strong>
        </span>
        <button className="v3-btn-primary v3-companion-cta" onClick={action.onClick}>
          {action.label}
        </button>
      </div>
    </section>
  );
}

// ===== Workspace card (second slot of the right panel) =====
// Surfaces the four signals the user wanted at a glance: skills usage,
// engram memory volume, and the two version pins. Distinct from Overview
// (which carries project / pr / finding counts) — this card is about the
// *tooling state* of the machine.
interface WorkspaceSummary {
  app_version: string;
  gentle_ai_version: string | null;
  engram_sessions: number | null;
  engram_observations: number | null;
  skills_total: number;
  skills_used: number;
}

function WorkspaceCard() {
  const { t } = useT();
  const [summary, setSummary] = useState<WorkspaceSummary | null>(null);
  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    invoke<WorkspaceSummary>("workspace_summary")
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        /* card stays in skeleton state — non-fatal for the UI */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const skillsPct = summary
    ? summary.skills_total === 0
      ? 0
      : Math.round((summary.skills_used / summary.skills_total) * 100)
    : 0;
  const dash = "—";

  return (
    <section className="v3-workspace-card">
      <header className="v3-workspace-head">
        <h3 className="v3-workspace-title">{t("workspace.title")}</h3>
      </header>
      <div className="v3-workspace-section">
        <div className="v3-workspace-row">
          <span className="v3-workspace-row-label">{t("workspace.skills")}</span>
          <span className="v3-workspace-row-value">
            {summary ? `${summary.skills_used} / ${summary.skills_total}` : dash}
          </span>
        </div>
        <div
          className="v3-workspace-bar-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={skillsPct}
          aria-label={t("workspace.skills")}
        >
          <div
            className="v3-workspace-bar-fill v3-workspace-bar-fill-accent"
            style={{ width: `${skillsPct}%` }}
          />
        </div>
        <div className="v3-workspace-row">
          <span className="v3-workspace-row-label">{t("workspace.engram")}</span>
          <span className="v3-workspace-row-value">
            {summary?.engram_observations != null
              ? t("workspace.engram_obs", { n: summary.engram_observations })
              : dash}
          </span>
        </div>
      </div>
      <div className="v3-workspace-divider" aria-hidden="true" />
      <div className="v3-workspace-section">
        <div className="v3-workspace-row">
          <span className="v3-workspace-row-label">{t("workspace.app")}</span>
          <span className="v3-workspace-row-value v3-workspace-version">
            v{summary?.app_version ?? dash}
          </span>
        </div>
        <div className="v3-workspace-row">
          <span className="v3-workspace-row-label">{t("workspace.gentle_ai")}</span>
          <span className="v3-workspace-row-value v3-workspace-version">
            {summary?.gentle_ai_version ? `v${summary.gentle_ai_version}` : dash}
          </span>
        </div>
      </div>
    </section>
  );
}

// ===== Status bar =====
// Statusbar is reduced to identity (version + ready state) on the left and
// a live clock + activity dot on the right. Project/finding counts moved
// out — they're already shown in the sidebar System Status card and the
// per-tab headers.
function StatusBarV3() {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const { t, lang } = useT();
  const time = now.toLocaleTimeString(lang === "es" ? "es-AR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <footer className="v3-statusbar">
      <div className="v3-statusbar-left">
        <span className="v3-statusbar-version">v0.1.0</span>
        <span className="v3-statusbar-sep" aria-hidden="true">|</span>
        <span className="v3-statusbar-state">{t("statusbar.ready")}</span>
      </div>
      <div className="v3-statusbar-right">
        <span>{time}</span>
        <span className="v3-statusbar-dot" aria-hidden="true" />
      </div>
    </footer>
  );
}

// ===== Overview view =====
function OverviewView({
  greeting,
  projects,
  prs,
  goals,
  stats,
  loading,
  onOpenProject,
  onOpenUrl,
  onJump,
  onCycleTheme,
}: {
  greeting: string;
  projects: Project[];
  prs: GhPullRequest[];
  goals: Record<string, string | null>;
  stats: { crit: number; warn: number; info: number; total: number; health: number };
  loading: boolean;
  onOpenProject: (path: string) => void;
  onOpenUrl: (url: string) => void;
  onJump: (tab: V3Tab) => void;
  onCycleTheme: () => void;
}) {
  const recentProjects = projects.slice(0, 3);
  const recentPrs = prs.slice(0, 4);
  const projectsThisWeek = projects.filter((p) => p.days_ago <= 7).length;
  const openPrs = prs.length;

  // Health delta — placeholder until we track history. Use a static label.
  const healthDelta = stats.crit === 0 ? "0 critical" : `${stats.crit} critical`;

  return (
    <div className="v3-view v3-view-overview">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{greeting}</h1>
          <p className="v3-subtitle">
            Here's what's happening across your workspace.
          </p>
        </div>
        <div className="v3-view-tools">
          <button
            className="v3-icon-btn"
            onClick={onCycleTheme}
            aria-label="Cycle theme"
            title="Cycle theme (Ctrl+T)"
          >
            <Palette size={16} strokeWidth={1.8} />
          </button>
          <button
            className="v3-icon-btn"
            onClick={() => onJump("settings")}
            aria-label="Open settings"
            title="Settings (Ctrl+,)"
          >
            <Cog size={16} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      <section className="v3-stats-row">
        <StatCard
          Icon={FolderOpen}
          label="Projects"
          value={loading ? "—" : String(projects.length)}
          delta={`${projectsThisWeek} this week`}
          tint="orange"
          severity={projectsThisWeek === 0 ? "warn" : "good"}
        />
        <StatCard
          Icon={Code2}
          label="Pull Requests"
          value={loading ? "—" : String(openPrs)}
          delta={`${openPrs} open`}
          tint="purple"
          severity={openPrs > 5 ? "warn" : "good"}
        />
        <StatCard
          Icon={ShieldCheck}
          label="Audit Findings"
          value={loading ? "—" : String(stats.total)}
          delta={`${stats.crit} high priority`}
          tint="amber"
          severity={stats.crit > 0 ? "crit" : "good"}
        />
        <StatCard
          Icon={Activity}
          label="Health Score"
          value={loading ? "—" : `${stats.health}%`}
          delta={healthDelta}
          tint="green"
          severity={stats.health < 70 ? "crit" : stats.health < 90 ? "warn" : "good"}
        />
      </section>

      <section className="v3-card v3-recent-projects">
        <header className="v3-card-head">
          <h2 className="v3-card-title">Recent Projects</h2>
          <button className="v3-link" onClick={() => onJump("projects")}>
            View all
          </button>
        </header>
        {loading ? (
          <div className="v3-empty">Loading projects…</div>
        ) : recentProjects.length === 0 ? (
          <div className="v3-empty">No recent projects detected.</div>
        ) : (
          <div className="v3-recent-projects-grid">
            {recentProjects.map((p) => {
              const name = projectName(p.path);
              const goal = goals[p.path];
              return (
                <RecentProjectCard
                  key={p.path}
                  name={name}
                  desc={goal ?? p.last_date}
                  ago={activityLabelEn(p.days_ago)}
                  freshness={freshnessScore(p.days_ago)}
                  onOpen={() => onOpenProject(p.path)}
                />
              );
            })}
          </div>
        )}
      </section>

      <section className="v3-row-2col">
        <article className="v3-card">
          <header className="v3-card-head">
            <h2 className="v3-card-title">Recent Pull Requests</h2>
            <button className="v3-link" onClick={() => onJump("prs")}>
              View all
            </button>
          </header>
          {loading ? (
            <div className="v3-empty">Loading PRs…</div>
          ) : recentPrs.length === 0 ? (
            <div className="v3-empty">No PRs awaiting your review.</div>
          ) : (
            <div className="v3-pr-list">
              {recentPrs.map((pr) => (
                <PrRowV3
                  key={pr.url}
                  title={pr.title}
                  repo={pr.repository}
                  num={prNumberFromUrl(pr.url)}
                  onOpen={() => onOpenUrl(pr.url)}
                />
              ))}
            </div>
          )}
        </article>

        <article className="v3-card">
          <header className="v3-card-head">
            <h2 className="v3-card-title">Audit Summary</h2>
            <button className="v3-link" onClick={() => onJump("audit")}>
              View all
            </button>
          </header>
          {stats.total === 0 ? (
            <div className="v3-empty">Audit clean. No findings.</div>
          ) : (
            <>
              <div className="v3-audit-body">
                <AuditDonut crit={stats.crit} warn={stats.warn} info={Math.max(stats.info, 1)} />
                <ul className="v3-audit-legend">
                  <li>
                    <span className="v3-legend-dot" style={{ background: "#DC2626" }} />
                    <span className="v3-legend-num">{stats.crit}</span>
                    <span className="v3-legend-label">Critical</span>
                  </li>
                  <li>
                    <span className="v3-legend-dot" style={{ background: "#F59E0B" }} />
                    <span className="v3-legend-num">{stats.warn}</span>
                    <span className="v3-legend-label">Warning</span>
                  </li>
                  <li>
                    <span className="v3-legend-dot" style={{ background: "#FCD34D" }} />
                    <span className="v3-legend-num">{stats.info}</span>
                    <span className="v3-legend-label">Info</span>
                  </li>
                </ul>
              </div>
              {stats.crit > 0 && (
                <footer className="v3-audit-foot">
                  <AlertTriangle size={14} strokeWidth={2} />
                  <span>
                    {stats.crit} critical issue{stats.crit === 1 ? "" : "s"} need
                    {stats.crit === 1 ? "s" : ""} your attention
                  </span>
                  <ChevronRight size={14} strokeWidth={2} className="v3-chev" />
                </footer>
              )}
            </>
          )}
        </article>
      </section>
    </div>
  );
}


// Compute "X ago" for a unix-ms timestamp.
// `t` flows in from useT() at the call site so these stay pure (no closure
// over hook state) and the locale switch updates them on next render.
function agoLabel(
  ms: number | null,
  t: (k: import("../lib/i18n").StringKey, vars?: Record<string, string | number>) => string
): string {
  if (ms === null) return t("common.never");
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 5) return t("common.just_now");
  if (sec < 60) return t("ago.seconds", { n: sec });
  const m = Math.floor(sec / 60);
  if (m < 60) return t("ago.minutes", { n: m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("ago.hours", { n: h });
  return t("ago.days", { n: Math.floor(h / 24) });
}

function pickGreeting(
  t: (k: import("../lib/i18n").StringKey) => string
): string {
  const h = new Date().getHours();
  if (h < 12) return t("greeting.morning");
  if (h < 19) return t("greeting.afternoon");
  return t("greeting.evening");
}

// Keyboard shortcuts cover the operational sidebar tabs (Ctrl+1..5). The
// topbar tabs (Claude / Companion / Settings) are low-frequency — Ctrl+,
// still jumps to Settings; the others are click-only.
const KEYBOARD_TAB_ORDER: ReadonlyArray<V3Tab> = [
  "overview",
  "projects",
  "prs",
  "audit",
  "cleanup",
];

// ===== Root =====
export default function AppV3() {
  const [tab, setTab] = useState<V3Tab>("overview");
  const [projects, setProjects] = useState<Project[]>([]);
  const [prs, setPrs] = useState<GhPullRequest[]>([]);
  const [findings, setFindings] = useState<AuditFinding[]>([]);
  const [goals, setGoals] = useState<Record<string, string | null>>({});
  const [loading, setLoading] = useState(true);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);
  const [lastScanTick, setLastScanTick] = useState(0); // forces re-render of "X ago"
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Per-source fetch errors — surfaced via the retry banner so backend
  // failures stop masquerading as empty states.
  const [fetchErrors, setFetchErrors] = useState<{ source: string; msg: string }[]>([]);

  // i18n hook — every helper that produces user-facing strings (greeting,
  // ago labels, headlines) takes `t` as a parameter so they stay pure.
  const { t } = useT();

  // Update channels (this app + gentle-ai). 24h cooldown is internal to the
  // hook; banners below render from the returned state.
  const updates = useUpdates();
  const [gentleAiApplying, setGentleAiApplying] = useState(false);
  const [gentleAiResult, setGentleAiResult] = useState<string | null>(null);
  const handleApplyGentleAi = async () => {
    setGentleAiApplying(true);
    setGentleAiResult(null);
    const after = await updates.applyGentleAi();
    setGentleAiApplying(false);
    setGentleAiResult(after ? `gentle-ai upgraded to v${after}` : "Update failed");
  };

  // Companion config — owned here so the right-panel widget updates live when
  // the user edits their companion in the Companions view. Persistence to
  // localStorage happens here too; CompanionsViewV3 just calls the setters.
  const [companionName, setCompanionName] = useState<string>(
    () => localStorage.getItem("csk-companion-name") ?? "Companion"
  );
  const [companionImage, setCompanionImage] = useState<string | null>(
    () => localStorage.getItem("csk-companion-image")
  );
  useEffect(() => {
    try {
      localStorage.setItem("csk-companion-name", companionName);
    } catch {
      /* ignore */
    }
  }, [companionName]);
  useEffect(() => {
    try {
      if (companionImage) localStorage.setItem("csk-companion-image", companionImage);
      else localStorage.removeItem("csk-companion-image");
    } catch {
      /* storage full — ignore */
    }
  }, [companionImage]);

  // Fetch all data on mount + refresh nonce.
  useEffect(() => {
    if (!IS_TAURI) {
      // Pure-browser preview: no Tauri APIs. Show empty state.
      setLoading(false);
      setLastScanAt(Date.now());
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFetchErrors([]);
    (async () => {
      // Capture per-source errors as they happen; the banner reads from this.
      const errors: { source: string; msg: string }[] = [];
      const trap =
        <T,>(source: string, fallback: T) =>
        (e: unknown): T => {
          errors.push({ source, msg: friendlyErrorEn(e) });
          return fallback;
        };
      try {
        const [projectsP, knownP, findingsP, prsP] = [
          invoke<Project[]>("scan_projects", { windowDays: 14 }).catch(
            trap<Project[]>("Projects", [])
          ),
          invoke<string[]>("engram_known_projects").catch(
            trap<string[]>("Engram", [])
          ),
          invoke<unknown>("run_audit")
            .then(parseAuditFindings)
            .catch(trap<AuditFinding[]>("Audit", [])),
          invoke<GhPullRequest[]>("github_review_queue", { limit: 20 }).catch(
            trap<GhPullRequest[]>("Pull requests", [])
          ),
        ];
        const [projectsRes, known, findingsRes, prsRes] = await Promise.all([
          projectsP,
          knownP,
          findingsP,
          prsP,
        ]);
        if (cancelled) return;
        const enrichment: Record<string, ProjectEnrichment> = await enrichProjects(
          projectsRes,
          known
        ).catch(trap<Record<string, ProjectEnrichment>>("Project enrichment", {}));
        if (cancelled) return;
        const goalMap: Record<string, string | null> = {};
        for (const p of projectsRes) {
          goalMap[p.path] = enrichment[p.path]?.goal ?? null;
        }
        setProjects(projectsRes);
        setPrs(prsRes);
        setFindings(findingsRes);
        setGoals(goalMap);
        setLastScanAt(Date.now());
        setFetchErrors(errors);
      } catch (e) {
        console.error("AppV3 fetch failed", friendlyErrorEn(e));
        if (!cancelled) {
          setFetchErrors([
            ...errors,
            { source: "Workspace", msg: friendlyErrorEn(e) },
          ]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  // Tick for "X ago" updates every 30s.
  useEffect(() => {
    const id = setInterval(() => setLastScanTick((t) => t + 1), 30_000);
    return () => clearInterval(id);
  }, []);
  void lastScanTick; // referenced to subscribe

  const stats = useMemo(() => {
    const crit = findings.filter((f) => f.level === "CRIT").length;
    const warn = findings.filter((f) => f.level === "WARN").length;
    const info = findings.filter((f) => f.level === "INFO").length;
    const total = findings.length;
    const health = Math.max(0, 100 - crit * 4 - warn);
    return { crit, warn, info, total, health };
  }, [findings]);

  const todayProject = useMemo(() => {
    const today = projects.find((p) => p.days_ago <= 1);
    return today ? projectName(today.path) : null;
  }, [projects]);
  const todayProjectPath = useMemo(() => {
    const today = projects.find((p) => p.days_ago <= 1);
    return today ? today.path : null;
  }, [projects]);

  const handleOpenProject = (path: string) => {
    if (!IS_TAURI) return;
    invoke("open_in_vscode", { path }).catch((e) =>
      console.error(friendlyErrorEn(e))
    );
  };
  const handleOpenUrl = (url: string) => {
    if (!IS_TAURI) {
      window.open(url, "_blank");
      return;
    }
    invoke("open_url", { url }).catch((e) => console.error(friendlyErrorEn(e)));
  };
  const handleRunAudit = () => setRefreshNonce((n) => n + 1);

  const handleCycleTheme = () => {
    applyAndPersistV3Theme(nextV3Theme(readV3ThemeFromBody()));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Ctrl+1..7 — switch tab in sidebar order
      if (e.key >= "1" && e.key <= "5") {
        const idx = Number(e.key) - 1;
        const next = KEYBOARD_TAB_ORDER[idx];
        if (next) {
          e.preventDefault();
          setTab(next);
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "r") {
        e.preventDefault();
        setRefreshNonce((n) => n + 1);
        return;
      }
      if (e.key === ",") {
        e.preventDefault();
        setTab("settings");
        return;
      }
      if (k === "t") {
        e.preventDefault();
        handleCycleTheme();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
    // handleCycleTheme is stable in practice (reads from DOM each call); skip dep array
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="appv3">
      <TopbarV3 activeTab={tab} onTab={setTab} />
      <div className="appv3-body">
        <SidebarV3
          activeTab={tab}
          onTab={setTab}
          lastScanAgo={agoLabel(lastScanAt, t)}
          onRunAudit={handleRunAudit}
          critCount={stats.crit}
          warnCount={stats.warn}
          findingTotal={stats.total}
        />
        <main className="appv3-content">
          {updates.app?.available && (
            <div className="v3-update-banner" role="status" aria-live="polite">
              <div className="v3-update-banner-body">
                <strong>Claude Startup Kit v{updates.app.latest}</strong>{" "}
                <span className="v3-update-banner-meta">
                  is available (you're on v{updates.app.current})
                </span>
              </div>
              <div className="v3-update-banner-actions">
                <button
                  type="button"
                  className="v3-update-banner-primary"
                  onClick={() => handleOpenUrl(updates.app!.release_url)}
                >
                  Open release
                </button>
                <button
                  type="button"
                  className="v3-update-banner-ghost"
                  onClick={() => updates.dismissApp(updates.app!.latest)}
                >
                  Later
                </button>
              </div>
            </div>
          )}
          {updates.gentleAi?.available && (
            <div className="v3-update-banner" role="status" aria-live="polite">
              <div className="v3-update-banner-body">
                <strong>gentle-ai v{updates.gentleAi.latest}</strong>{" "}
                <span className="v3-update-banner-meta">
                  is available (you're on v{updates.gentleAi.current})
                </span>
                {gentleAiResult && (
                  <span className="v3-update-banner-result"> · {gentleAiResult}</span>
                )}
              </div>
              <div className="v3-update-banner-actions">
                <button
                  type="button"
                  className="v3-update-banner-primary"
                  onClick={handleApplyGentleAi}
                  disabled={gentleAiApplying}
                >
                  {gentleAiApplying ? "Updating…" : "Update now"}
                </button>
                <button
                  type="button"
                  className="v3-update-banner-ghost"
                  onClick={() => updates.dismissGentleAi(updates.gentleAi!.latest)}
                  disabled={gentleAiApplying}
                >
                  Later
                </button>
              </div>
            </div>
          )}
          {fetchErrors.length > 0 && (
            <div className="v3-fetch-banner" role="alert" aria-live="polite">
              <div className="v3-fetch-banner-body">
                <strong>Some data failed to load.</strong>{" "}
                <span>
                  {fetchErrors.map((e, i) => (
                    <span key={e.source}>
                      {i > 0 ? " · " : ""}
                      <span className="v3-fetch-banner-source">{e.source}</span>: {e.msg}
                    </span>
                  ))}
                </span>
              </div>
              <button
                type="button"
                className="v3-fetch-banner-retry"
                onClick={handleRunAudit}
              >
                Retry
              </button>
            </div>
          )}
          {tab === "overview" && (
            <OverviewView
              greeting={`${pickGreeting(t)}.`}
              projects={projects}
              prs={prs}
              goals={goals}
              stats={stats}
              loading={loading}
              onOpenProject={handleOpenProject}
              onOpenUrl={handleOpenUrl}
              onJump={setTab}
              onCycleTheme={handleCycleTheme}
            />
          )}
          {tab === "projects" && <ProjectsViewV3 />}
          {tab === "prs" && <PrsViewV3 />}
          {tab === "audit" && <AuditViewV3 />}
          {tab === "cleanup" && <CleanupViewV3 />}
          {tab === "claude" && <ClaudeViewV3 />}
          {tab === "companions" && (
            <CompanionsViewV3
              name={companionName}
              image={companionImage}
              onNameChange={setCompanionName}
              onImageChange={setCompanionImage}
            />
          )}
          {tab === "settings" && <SettingsViewV3 />}
        </main>
        <aside className="appv3-rightpanel" aria-label="Companion panel">
          <CompanionWidget
            companionName={companionName}
            companionImage={companionImage}
            critCount={stats.crit}
            warnCount={stats.warn}
            prCount={prs.length}
            todayProject={todayProject}
            todayProjectPath={todayProjectPath}
            lastScanAgo={agoLabel(lastScanAt, t)}
            onJump={setTab}
            onOpenProject={handleOpenProject}
          />
          <WorkspaceCard />
        </aside>
      </div>
      <StatusBarV3 />
    </div>
  );
}
