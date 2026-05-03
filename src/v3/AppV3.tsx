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
import { nextV3Theme, loadV3Theme, readV3ThemeFromBody } from "../lib/themes";
import type { V3Theme } from "../lib/themes";
import { enrichProjects } from "../lib/enrichProjects";
import {
  ProjectsViewV3,
  PrsViewV3,
  AuditViewV3,
  CleanupViewV3,
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
  BarChart3,
  Bot,
  ChevronRight,
  Code2,
  Cog,
  FolderOpen,
  Palette,
  GitPullRequest,
  Home,
  Minus,
  RefreshCw,
  ShieldCheck,
  Sparkles,
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
  | "companions"
  | "settings";

const TOPBAR_TABS: { id: V3Tab; label: string }[] = [
  { id: "overview", label: "Overview" },
  { id: "projects", label: "Projects" },
  { id: "prs", label: "PRs" },
  { id: "audit", label: "Audit" },
  { id: "cleanup", label: "Cleanup" },
  { id: "settings", label: "Settings" },
];

const SIDEBAR_NAV: { id: V3Tab; label: string; Icon: typeof Home }[] = [
  { id: "overview", label: "Overview", Icon: Home },
  { id: "projects", label: "Projects", Icon: FolderOpen },
  { id: "prs", label: "Pull Requests", Icon: GitPullRequest },
  { id: "audit", label: "Audit", Icon: Activity },
  { id: "cleanup", label: "Cleanup", Icon: Trash2 },
  { id: "companions", label: "Companions", Icon: Bot },
  { id: "settings", label: "Settings", Icon: Cog },
];

// ===== Topbar (with Tauri drag region + window controls) =====
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

  return (
    <header className="v3-topbar" data-tauri-drag-region>
      <div className="v3-topbar-brand" data-tauri-drag-region>
        <span className="v3-brand-mark" aria-hidden="true">
          <img src="/Shield.svg" alt="" draggable={false} />
        </span>
        <span className="v3-brand-name">Claude Startup Kit</span>
      </div>

      <nav className="v3-topbar-nav" data-tauri-drag-region>
        {TOPBAR_TABS.map((t) => (
          <button
            key={t.id}
            className={"v3-topbar-tab" + (activeTab === t.id ? " active" : "")}
            onClick={() => onTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>

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
}: {
  activeTab: V3Tab;
  onTab: (t: V3Tab) => void;
  lastScanAgo: string;
  onRunAudit: () => void;
}) {
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
        {SIDEBAR_NAV.map(({ id, label, Icon }) => (
          <button
            key={id}
            className={"v3-side-link" + (activeTab === id ? " active" : "")}
            onClick={() => onTab(id)}
            aria-label={label}
          >
            <Icon size={16} strokeWidth={1.8} />
            <span>{label}</span>
          </button>
        ))}
      </nav>

      <div className="v3-sidebar-spacer" />

      <div className="v3-system-status">
        <div className="v3-system-status-title">System Status</div>
        <div className="v3-system-status-row">
          <span className="v3-status-dot" aria-hidden="true" />
          <span>All systems operational</span>
        </div>
        <div className="v3-system-status-meta">
          <div>Last scan: <strong>{lastScanAgo}</strong></div>
          <div>Manual refresh available</div>
        </div>
        <button
          className="v3-btn-ghost v3-system-status-cta"
          onClick={onRunAudit}
        >
          <ShieldCheck size={13} strokeWidth={2} />
          <span>Run Full Audit</span>
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
function CompanionWidget({
  companionName,
  companionImage,
  critCount,
  warnCount,
  prCount,
  todayProject,
  onRunAudit,
}: {
  companionName: string;
  companionImage: string | null;
  critCount: number;
  warnCount: number;
  prCount: number;
  todayProject: string | null;
  onRunAudit: () => void;
}) {
  // Pick the most relevant single insight based on signals.
  let messageBody: React.ReactNode;
  if (critCount > 0) {
    messageBody = (
      <>
        I've analyzed your workspace.
        <br />
        There are{" "}
        <strong className="v3-companion-emph">
          {critCount} critical issue{critCount === 1 ? "" : "s"}
        </strong>{" "}
        that should be addressed.
      </>
    );
  } else if (warnCount > 0) {
    messageBody = (
      <>
        Audit clean on critical. {warnCount} warning
        {warnCount === 1 ? "" : "s"} you can address when you have time.
      </>
    );
  } else if (prCount > 0) {
    messageBody = (
      <>
        Workspace healthy. You have{" "}
        <strong className="v3-companion-emph">
          {prCount} pull request{prCount === 1 ? "" : "s"}
        </strong>{" "}
        waiting for review.
      </>
    );
  } else if (todayProject) {
    messageBody = (
      <>
        You've been working on{" "}
        <strong className="v3-companion-emph">{todayProject}</strong> today. Audit's
        clean.
      </>
    );
  } else {
    messageBody = <>All systems clear. Nothing to flag right now.</>;
  }

  const avatarSrc = companionImage ?? "/Sia2.webp";

  return (
    <section className="v3-companion-widget">
      <header className="v3-companion-head">
        <span className="v3-companion-title">{companionName}</span>
        <span className="v3-companion-status">
          <span className="v3-status-dot" aria-hidden="true" />
          Online
        </span>
      </header>
      <div className="v3-companion-stage">
        <div className="v3-companion-avatar" aria-hidden="true">
          <img src={avatarSrc} alt="" draggable={false} />
        </div>
      </div>
      <div className="v3-companion-message">{messageBody}</div>
      <div className="v3-companion-actions">
        <button className="v3-btn-primary" onClick={onRunAudit}>
          <Sparkles size={13} strokeWidth={2} />
          Run Smart Audit
        </button>
      </div>
    </section>
  );
}

// ===== Quick actions =====
function QuickActions({
  onJump,
  onRefreshAll,
}: {
  onJump: (tab: V3Tab) => void;
  onRefreshAll: () => void;
}) {
  const items: { Icon: typeof Home; label: string; onClick: () => void }[] = [
    { Icon: FolderOpen, label: "Browse Projects", onClick: () => onJump("projects") },
    { Icon: GitPullRequest, label: "Open PR Queue", onClick: () => onJump("prs") },
    { Icon: Trash2, label: "Run Cleanup", onClick: () => onJump("cleanup") },
    { Icon: BarChart3, label: "View Audit", onClick: () => onJump("audit") },
    { Icon: RefreshCw, label: "Refresh Overview", onClick: onRefreshAll },
  ];
  return (
    <section className="v3-quick-actions">
      <header className="v3-quick-actions-head">Quick Actions</header>
      <div className="v3-quick-actions-list">
        {items.map(({ Icon, label, onClick }) => (
          <button key={label} className="v3-quick-action" onClick={onClick}>
            <Icon size={14} strokeWidth={1.8} />
            <span>{label}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

// ===== Status bar =====
// Right side carries real, live signals (project count, finding count, clock)
// instead of fake editor-style metadata. The clock ticks once a minute.
function StatusBarV3({
  projectCount,
  findingCount,
  lastScanAgo,
}: {
  projectCount: number;
  findingCount: number;
  lastScanAgo: string;
}) {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  const time = now.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return (
    <footer className="v3-statusbar">
      <div className="v3-statusbar-left">
        <span className="v3-statusbar-version">v0.1.0</span>
        <span className="v3-statusbar-sep" aria-hidden="true">|</span>
        <span className="v3-statusbar-state">Ready</span>
      </div>
      <div className="v3-statusbar-right">
        <span>{projectCount} project{projectCount === 1 ? "" : "s"}</span>
        <span>{findingCount} finding{findingCount === 1 ? "" : "s"}</span>
        <span>Scan {lastScanAgo}</span>
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
function agoLabel(ms: number | null): string {
  if (ms === null) return "never";
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 5) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function pickGreeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 19) return "Good afternoon";
  return "Good evening";
}

// V3 themes — must match the keys in AppV3.css and views.tsx picker.
function applyV3ThemeToBody(theme: V3Theme) {
  void loadV3Theme(theme);
  try {
    localStorage.setItem("csk-theme-v3", theme);
  } catch {
    /* ignore */
  }
}

// Tab order matches sidebar (7 entries → Ctrl+1..7).
const KEYBOARD_TAB_ORDER: ReadonlyArray<V3Tab> = [
  "overview",
  "projects",
  "prs",
  "audit",
  "cleanup",
  "companions",
  "settings",
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
    applyV3ThemeToBody(nextV3Theme(readV3ThemeFromBody()));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      // Ctrl+1..7 — switch tab in sidebar order
      if (e.key >= "1" && e.key <= "7") {
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
          lastScanAgo={agoLabel(lastScanAt)}
          onRunAudit={handleRunAudit}
        />
        <main className="appv3-content">
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
              greeting={`${pickGreeting()}.`}
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
          {tab === "companions" && (
            <CompanionsViewV3
              name={companionName}
              image={companionImage}
              onNameChange={setCompanionName}
              onImageChange={setCompanionImage}
            />
          )}
          {tab === "settings" && (
            <SettingsViewV3 onJumpCompanion={() => setTab("companions")} />
          )}
        </main>
        <aside className="appv3-rightpanel" aria-label="Companion panel">
          <CompanionWidget
            companionName={companionName}
            companionImage={companionImage}
            critCount={stats.crit}
            warnCount={stats.warn}
            prCount={prs.length}
            todayProject={todayProject}
            onRunAudit={handleRunAudit}
          />
          <QuickActions onJump={setTab} onRefreshAll={handleRunAudit} />
        </aside>
      </div>
      <StatusBarV3
        projectCount={projects.length}
        findingCount={findings.length}
        lastScanAgo={agoLabel(lastScanAt)}
      />
    </div>
  );
}
