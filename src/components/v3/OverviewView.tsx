import { useState } from "react";
import {
  Activity,
  AlertTriangle,
  ArrowUp,
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
import { plural, useT } from "../../lib/i18n";

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

        <article className="v3-card">
          <header className="v3-card-head">
            <h2 className="v3-card-title">{t("overview.audit_summary")}</h2>
            <button className="v3-link" onClick={() => onJump("audit")}>
              {t("overview.view_all")}
            </button>
          </header>
          {stats.total === 0 ? (
            <div className="v3-empty">{t("overview.audit_clean")}</div>
          ) : (
            <>
              {/* Stacked bar: proportional widths per severity, no donut. */}
              <div
                className="v3-audit-bar"
                role="progressbar"
                aria-label={t("overview.audit_bar_label", {
                  total: stats.total,
                  crit: stats.crit,
                  warn: stats.warn,
                  info: stats.info,
                })}
              >
                {stats.crit > 0 && (
                  <span
                    className="v3-audit-bar-seg v3-audit-bar-crit"
                    style={{ width: `${(stats.crit / stats.total) * 100}%` }}
                  />
                )}
                {stats.warn > 0 && (
                  <span
                    className="v3-audit-bar-seg v3-audit-bar-warn"
                    style={{ width: `${(stats.warn / stats.total) * 100}%` }}
                  />
                )}
                {stats.info > 0 && (
                  <span
                    className="v3-audit-bar-seg v3-audit-bar-info"
                    style={{ width: `${(stats.info / stats.total) * 100}%` }}
                  />
                )}
              </div>
              <div className="v3-audit-tiles">
                <div className="v3-audit-tile v3-audit-tile-crit">
                  <span className="v3-audit-tile-stripe" aria-hidden="true" />
                  <div className="v3-audit-tile-body">
                    <div className="v3-audit-tile-num">{stats.crit}</div>
                    <div className="v3-audit-tile-label">{t("overview.tile_critical")}</div>
                  </div>
                </div>
                <div className="v3-audit-tile v3-audit-tile-warn">
                  <span className="v3-audit-tile-stripe" aria-hidden="true" />
                  <div className="v3-audit-tile-body">
                    <div className="v3-audit-tile-num">{stats.warn}</div>
                    <div className="v3-audit-tile-label">{t("overview.tile_warning")}</div>
                  </div>
                </div>
                <div className="v3-audit-tile v3-audit-tile-info">
                  <span className="v3-audit-tile-stripe" aria-hidden="true" />
                  <div className="v3-audit-tile-body">
                    <div className="v3-audit-tile-num">{stats.info}</div>
                    <div className="v3-audit-tile-label">{t("overview.tile_info")}</div>
                  </div>
                </div>
              </div>
              <footer className="v3-audit-meta">
                <span className="v3-audit-meta-num">{stats.total}</span>
                <span className="v3-audit-meta-label">{t("overview.total_findings")}</span>
              </footer>
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
      </section>
    </div>
  );
}
