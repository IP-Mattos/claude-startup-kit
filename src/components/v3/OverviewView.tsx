import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Activity,
  AlertTriangle,
  ArrowUp,
  Boxes,
  ChevronRight,
  Code2,
  Cog,
  FolderOpen,
  GitPullRequest,
  Home,
  Palette,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import {
  activityLabelT,
  onKeyboardActivate,
  prNumberFromUrl,
  projectName,
} from "../../lib/format";
import type {
  AuditFinding as _AuditFinding,
  GhPullRequest,
  Project,
} from "../../types";
import type { V3Tab } from "../../v3/v3types";
import { plural, useT, type StringKey } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";
import { Sparkline } from "./Sparkline";

// Mini Gentle-AI inventory shown on the Overview. Mirrors the shape of
// `GentleAiStatus` in `ClaudeView.tsx` — we keep the type local so this file
// doesn't depend on the verifier view import-wise.
interface GentleAiMiniStatus {
  cli_version: string | null;
  components: { name: string; installed: boolean }[];
}

function GentleAiOverviewCard({
  onJump,
  t,
}: {
  onJump: (tab: V3Tab) => void;
  t: (k: StringKey, vars?: Record<string, string | number>) => string;
}) {
  const [status, setStatus] = useState<GentleAiMiniStatus | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!IS_TAURI) {
      setLoaded(true);
      return;
    }
    let cancelled = false;
    invoke<GentleAiMiniStatus>("gentle_ai_status")
      .then((s) => {
        if (!cancelled) {
          setStatus(s);
          setLoaded(true);
        }
      })
      .catch(() => {
        // gentle-ai might not be installed yet — render the empty state
        // instead of bubbling the error to the whole overview.
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const total = status?.components.length ?? 0;
  const ok = status?.components.filter((c) => c.installed).length ?? 0;
  const pct = total > 0 ? Math.round((ok / total) * 100) : 0;

  return (
    <article className="v3-card v3-gai-overview-card">
      <header className="v3-card-head">
        <h2 className="v3-card-title">
          <Boxes
            size={14}
            strokeWidth={2}
            style={{ verticalAlign: "-2px", marginRight: 6 }}
          />
          {t("overview.gentle_ai_card_title")}
          {status?.cli_version && (
            <span className="v3-row-dim" style={{ marginLeft: 8 }}>
              v{status.cli_version}
            </span>
          )}
        </h2>
        <button className="v3-link" onClick={() => onJump("claude")}>
          {t("overview.gentle_ai_view_details")}
        </button>
      </header>
      {!loaded ? (
        <div className="v3-empty">{t("common.loading")}</div>
      ) : !status?.cli_version ? (
        <div className="v3-empty">{t("overview.gentle_ai_cli_missing")}</div>
      ) : (
        <div className="v3-gai-overview-body">
          <div
            className="v3-gai-overview-bar"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={ok}
          >
            <div
              className="v3-gai-overview-bar-fill"
              style={{ width: `${pct}%` }}
            />
          </div>
          <div className="v3-gai-overview-count">
            {t("overview.gentle_ai_components_count", { ok, total })}
          </div>
        </div>
      )}
    </article>
  );
}

// =============================================================
// Sub-components (only used by OverviewView, kept co-located).
// =============================================================

type StatTint = "orange" | "purple" | "amber" | "green";
type DeltaSeverity = "good" | "warn" | "crit";

function StatCard({
  Icon,
  label,
  value,
  delta,
  tint,
  severity = "good",
  trend,
}: {
  Icon: typeof Home;
  label: string;
  value: string;
  delta: string;
  tint: StatTint;
  severity?: DeltaSeverity;
  /** Optional sparkline data (oldest → newest). Rendered only by themes
   *  that opt into showing it via CSS (data-dense). On other themes
   *  the SVG element is invisible via display:none. */
  trend?: number[];
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
        {trend && trend.length > 0 && <Sparkline data={trend} />}
      </div>
    </article>
  );
}

function RecentProjectCard({
  name,
  desc,
  ago,
  freshness,
  onOpen,
  ariaLabel,
}: {
  name: string;
  desc: string;
  ago: string;
  freshness: number;
  onOpen: () => void;
  ariaLabel: string;
}) {
  const tint: "green" | "amber" = freshness >= 80 ? "green" : "amber";
  return (
    <article
      className="v3-recent-project"
      onClick={onOpen}
      onKeyDown={onKeyboardActivate(onOpen)}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
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

function PrRow({
  title,
  repo,
  num,
  onOpen,
  ariaLabel,
  openLabel,
}: {
  title: string;
  repo: string;
  num: number | null;
  onOpen: () => void;
  ariaLabel: string;
  openLabel: string;
}) {
  return (
    <div
      className="v3-pr-row"
      onClick={onOpen}
      onKeyDown={onKeyboardActivate(onOpen)}
      role="button"
      tabIndex={0}
      aria-label={ariaLabel}
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
      <span className="v3-pr-pill v3-pr-pill-open">{openLabel}</span>
    </div>
  );
}

// 0-100 freshness based on days since last activity. 0d → 100, 30d+ → 50.
function freshnessScore(daysAgo: number): number {
  if (daysAgo <= 0) return 100;
  if (daysAgo >= 30) return 50;
  return Math.round(100 - daysAgo * 1.7);
}

// =============================================================
// Audit summary — 4 hacker/data-style render modes the user picks
// from a tiny chip selector. Mode persists in localStorage so it
// sticks across reloads.
// =============================================================

type AuditMode = "tree" | "log" | "k9s" | "shell";
const AUDIT_MODES: AuditMode[] = ["tree", "log", "k9s", "shell"];

function isAuditMode(v: string): v is AuditMode {
  return (AUDIT_MODES as string[]).includes(v);
}

function useAuditMode(): [AuditMode, (m: AuditMode) => void] {
  const [mode, setMode] = useState<AuditMode>(() => {
    try {
      const saved = localStorage.getItem("csk-audit-mode");
      if (saved && isAuditMode(saved)) return saved;
    } catch {
      /* localStorage unavailable */
    }
    return "tree";
  });
  const update = (m: AuditMode) => {
    setMode(m);
    try {
      localStorage.setItem("csk-audit-mode", m);
    } catch {
      /* ignore */
    }
  };
  return [mode, update];
}

// Pad numbers to align columns inside each ASCII layout. Width 3 fits
// 0-999 which is the realistic range for a finding count.
function pad(n: number, width = 3): string {
  return String(n).padStart(width, " ");
}

interface AuditStats {
  crit: number;
  warn: number;
  info: number;
  total: number;
}

interface AuditModeProps {
  stats: AuditStats;
}

// Mode 1 — Tree diagnostic (`tree` command output style).
function AuditTreeMode({ stats }: AuditModeProps) {
  const status =
    stats.crit > 0 ? "ATTENTION" : stats.warn > 0 ? "WARNINGS" : "ALL CLEAR";
  const statusClass =
    stats.crit > 0
      ? "audit-status-crit"
      : stats.warn > 0
      ? "audit-status-warn"
      : "audit-status-ok";
  return (
    <div className="v3-audit-mode v3-audit-mode-tree">
      <div>
        <span className="audit-key">total </span>
        <span className="audit-leader">─────── </span>
        <span className="audit-num">{pad(stats.total)}</span>
      </div>
      <div className={stats.crit > 0 ? "audit-crit-active" : ""}>
        <span className="audit-leader">├─ </span>
        <span className="audit-key">crit </span>
        <span className="audit-leader">······· </span>
        <span className="audit-num">{pad(stats.crit)}</span>
      </div>
      <div>
        <span className="audit-leader">├─ </span>
        <span className="audit-key">warn </span>
        <span className="audit-leader">······· </span>
        <span className="audit-num">{pad(stats.warn)}</span>
      </div>
      <div>
        <span className="audit-leader">└─ </span>
        <span className="audit-key">info </span>
        <span className="audit-leader">······· </span>
        <span className="audit-num">{pad(stats.info)}</span>
      </div>
      <div style={{ marginTop: 8 }}>
        <span className="audit-key">status: </span>
        <span className={statusClass}>{status}</span>
      </div>
    </div>
  );
}

// Mode 2 — top/htop-style log lines with `>` prompt.
function AuditLogMode({ stats, t }: AuditModeProps & { t: (k: StringKey) => string }) {
  const status =
    stats.crit > 0 ? "crit" : stats.warn > 0 ? "warn" : "ok";
  const statusClass =
    stats.crit > 0
      ? "audit-status-crit"
      : stats.warn > 0
      ? "audit-status-warn"
      : "audit-status-ok";
  return (
    <div className="v3-audit-mode v3-audit-mode-log">
      <div>
        <span className="audit-prompt">{"> "}</span>
        <span className="audit-num">{stats.total}</span>
        <span className="audit-key"> findings</span>
        <span style={{ marginLeft: 16 }} className="audit-key">status: </span>
        <span className={statusClass}>{status}</span>
      </div>
      <div className={stats.crit > 0 ? "audit-crit-active" : ""}>
        <span className="audit-prompt">{"> "}</span>
        <span className="audit-key">crit </span>
        <span className="audit-num">{String(stats.crit).padStart(2, "0")}</span>
        <span className="audit-key">  warn </span>
        <span className="audit-num">{String(stats.warn).padStart(2, "0")}</span>
        <span className="audit-key">  info </span>
        <span className="audit-num">{String(stats.info).padStart(2, "0")}</span>
      </div>
      <div>
        <span className="audit-prompt">{"> "}</span>
        <span className="audit-key">last scan: </span>
        <span className="audit-num">{t("overview.audit_last_now")}</span>
      </div>
    </div>
  );
}

// Mode 3 — k9s tabular view with status dots (● filled when value > 0).
function AuditK9sMode({ stats }: AuditModeProps) {
  const row = (key: string, n: number, isCrit = false) => {
    const active = n > 0;
    return (
      <div
        className={
          (active ? "audit-row-active " : "") +
          (isCrit && active ? "audit-crit-active" : "")
        }
      >
        <span className="audit-dot">{active ? "●" : "○"}</span>
        <span className="audit-key">  {key.padEnd(6, " ")}</span>
        <span className="audit-num">{pad(n)}</span>
      </div>
    );
  };
  return (
    <div className="v3-audit-mode v3-audit-mode-k9s">
      {row("CRIT", stats.crit, true)}
      {row("WARN", stats.warn)}
      {row("INFO", stats.info)}
      <div className="audit-leader">─────────────────</div>
      <div>
        <span style={{ display: "inline-block", width: 8 }} />
        <span className="audit-key">  TOTAL </span>
        <span className="audit-num">{pad(stats.total)}</span>
      </div>
    </div>
  );
}

// Mode 4 — shell command echo (`$ csk audit --summary`).
function AuditShellMode({ stats }: AuditModeProps) {
  return (
    <div className="v3-audit-mode v3-audit-mode-shell">
      <div>
        <span className="audit-prompt">$ </span>
        <span className="audit-cmd">csk audit --summary</span>
      </div>
      <div style={{ marginTop: 4 }}>
        <span className="audit-key">scanning ~/.claude .. done</span>
      </div>
      <div style={{ marginTop: 8 }} className={stats.crit > 0 ? "audit-crit-active" : ""}>
        <span className="audit-key">CRIT ·· </span>
        <span className="audit-num">{pad(stats.crit)}</span>
      </div>
      <div>
        <span className="audit-key">WARN ·· </span>
        <span className="audit-num">{pad(stats.warn)}</span>
      </div>
      <div>
        <span className="audit-key">INFO ·· </span>
        <span className="audit-num">{pad(stats.info)}</span>
      </div>
      <div className="audit-leader">────────────</div>
      <div>
        <span className="audit-key">TOTAL  </span>
        <span className="audit-num">{pad(stats.total)}</span>
      </div>
    </div>
  );
}

interface AuditSummaryCardProps {
  stats: AuditStats;
  onJump: (tab: V3Tab) => void;
  t: (k: StringKey, vars?: Record<string, string | number>) => string;
}

function AuditSummaryCard({ stats, onJump, t }: AuditSummaryCardProps) {
  const [mode, setMode] = useAuditMode();
  return (
    <article className="v3-card">
      <header className="v3-card-head">
        <h2 className="v3-card-title">{t("overview.audit_summary")}</h2>
        <div className="v3-audit-modes" role="tablist" aria-label="Audit layout">
          {AUDIT_MODES.map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className={"v3-audit-mode-btn" + (mode === m ? " active" : "")}
              onClick={() => setMode(m)}
            >
              {m}
            </button>
          ))}
        </div>
        <button className="v3-link" onClick={() => onJump("audit")}>
          {t("overview.view_all")}
        </button>
      </header>
      {stats.total === 0 ? (
        <div className="v3-empty">{t("overview.audit_clean")}</div>
      ) : (
        <>
          {mode === "tree" && <AuditTreeMode stats={stats} />}
          {mode === "log" && <AuditLogMode stats={stats} t={t} />}
          {mode === "k9s" && <AuditK9sMode stats={stats} />}
          {mode === "shell" && <AuditShellMode stats={stats} />}
          {stats.crit > 0 && (
            <footer className="v3-audit-foot">
              <AlertTriangle size={14} strokeWidth={2} />
              <span>
                {plural(
                  t,
                  stats.crit,
                  "overview.crit_attention_one",
                  "overview.crit_attention_other"
                )}
              </span>
              <ChevronRight size={14} strokeWidth={2} className="v3-chev" />
            </footer>
          )}
        </>
      )}
    </article>
  );
}

// =============================================================
// Overview view — top page, stat row + recent projects + recent PRs +
// audit summary card.
// =============================================================

export function OverviewView({
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
  stats: {
    crit: number;
    warn: number;
    info: number;
    total: number;
    health: number;
  };
  loading: boolean;
  onOpenProject: (path: string) => void;
  onOpenUrl: (url: string) => void;
  onJump: (tab: V3Tab) => void;
  onCycleTheme: () => void;
}) {
  const { t } = useT();
  const recentProjects = projects.slice(0, 3);
  const recentPrs = prs.slice(0, 4);
  const projectsThisWeek = projects.filter((p) => p.days_ago <= 7).length;
  const openPrs = prs.length;

  // Welcome card shown only on first launch. Dismissible — once dismissed
  // never reappears. We use localStorage so the flag survives reinstalls
  // (the user identity is the same browser/account on this machine).
  const ONBOARDING_KEY = "csk-onboarding-dismissed";
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(
    () => {
      try {
        return localStorage.getItem(ONBOARDING_KEY) === "1";
      } catch {
        return true;
      }
    },
  );
  const dismissOnboarding = () => {
    try {
      localStorage.setItem(ONBOARDING_KEY, "1");
    } catch {
      /* ignore */
    }
    setOnboardingDismissed(true);
  };

  // Health delta — placeholder until we track history. Static label.
  const healthDelta =
    stats.crit === 0
      ? t("overview.zero_critical")
      : t("overview.n_critical", { n: stats.crit });

  return (
    <div className="v3-view v3-view-overview">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{greeting}</h1>
          <p className="v3-subtitle">{t("overview.subtitle")}</p>
        </div>
        <div className="v3-view-tools">
          <button
            className="v3-icon-btn"
            onClick={onCycleTheme}
            aria-label={t("common.cycle_theme")}
            title={t("common.cycle_theme_title")}
          >
            <Palette size={16} strokeWidth={1.8} />
          </button>
          <button
            className="v3-icon-btn"
            onClick={() => onJump("settings")}
            aria-label={t("common.open_settings")}
            title={t("common.settings_title")}
          >
            <Cog size={16} strokeWidth={1.8} />
          </button>
        </div>
      </header>

      {!onboardingDismissed && (
        <article className="v3-onboarding-card" role="region" aria-label={t("onboarding.aria")}>
          <div className="v3-onboarding-icon" aria-hidden="true">
            <Sparkles size={18} strokeWidth={2} />
          </div>
          <div className="v3-onboarding-body">
            <h2 className="v3-onboarding-title">{t("onboarding.title")}</h2>
            <p className="v3-onboarding-message">{t("onboarding.message")}</p>
            <div className="v3-onboarding-actions">
              <button
                type="button"
                className="v3-btn-ghost v3-btn-sm"
                onClick={() => onJump("sync")}
              >
                {t("onboarding.cta_sync")}
              </button>
              <button
                type="button"
                className="v3-btn-ghost v3-btn-sm"
                onClick={() => onJump("settings")}
              >
                {t("onboarding.cta_settings")}
              </button>
            </div>
          </div>
          <button
            type="button"
            className="v3-onboarding-close"
            onClick={dismissOnboarding}
            aria-label={t("onboarding.dismiss")}
            title={t("onboarding.dismiss")}
          >
            <X size={14} strokeWidth={2} />
          </button>
        </article>
      )}

      <section className="v3-stats-row">
        <StatCard
          Icon={FolderOpen}
          label={t("overview.stat_projects")}
          value={loading ? "—" : String(projects.length)}
          delta={t("overview.this_week", { n: projectsThisWeek })}
          tint="orange"
          severity={projectsThisWeek === 0 ? "warn" : "good"}
        />
        <StatCard
          Icon={Code2}
          label={t("overview.stat_prs")}
          value={loading ? "—" : String(openPrs)}
          delta={t("overview.open_count", { n: openPrs })}
          tint="purple"
          severity={openPrs > 5 ? "warn" : "good"}
        />
        <StatCard
          Icon={ShieldCheck}
          label={t("overview.stat_findings")}
          value={loading ? "—" : String(stats.total)}
          delta={t("overview.high_priority", { n: stats.crit })}
          tint="amber"
          severity={stats.crit > 0 ? "crit" : "good"}
        />
        <StatCard
          Icon={Activity}
          label={t("overview.stat_health")}
          value={loading ? "—" : `${stats.health}%`}
          delta={healthDelta}
          tint="green"
          severity={
            stats.health < 70 ? "crit" : stats.health < 90 ? "warn" : "good"
          }
        />
      </section>

      <section className="v3-card v3-recent-projects">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("overview.recent_projects")}</h2>
          <button className="v3-link" onClick={() => onJump("projects")}>
            {t("overview.view_all")}
          </button>
        </header>
        {loading ? (
          <div className="v3-empty">{t("overview.loading_projects")}</div>
        ) : recentProjects.length === 0 ? (
          <div className="v3-empty">{t("overview.no_recent_projects")}</div>
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
                  ago={activityLabelT(p.days_ago, t)}
                  freshness={freshnessScore(p.days_ago)}
                  onOpen={() => onOpenProject(p.path)}
                  ariaLabel={t("overview.open_project_label", { name })}
                />
              );
            })}
          </div>
        )}
      </section>

      <section className="v3-row-2col">
        <article className="v3-card">
          <header className="v3-card-head">
            <h2 className="v3-card-title">{t("overview.recent_prs")}</h2>
            <button className="v3-link" onClick={() => onJump("prs")}>
              {t("overview.view_all")}
            </button>
          </header>
          {loading ? (
            <div className="v3-empty">{t("overview.loading_prs")}</div>
          ) : recentPrs.length === 0 ? (
            <div className="v3-empty">{t("overview.no_prs")}</div>
          ) : (
            <div className="v3-pr-list">
              {recentPrs.map((pr) => (
                <PrRow
                  key={pr.url}
                  title={pr.title}
                  repo={pr.repository}
                  num={prNumberFromUrl(pr.url)}
                  onOpen={() => onOpenUrl(pr.url)}
                  ariaLabel={t("overview.open_pr_label", { title: pr.title })}
                  openLabel={t("prs.open")}
                />
              ))}
            </div>
          )}
        </article>

        <AuditSummaryCard stats={stats} onJump={onJump} t={t} />
      </section>

      <GentleAiOverviewCard onJump={onJump} t={t} />
    </div>
  );
}
