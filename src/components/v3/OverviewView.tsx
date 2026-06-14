import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  ChevronRight,
  Code2,
  Cog,
  Palette,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import {
  activityLabelT,
  onKeyboardActivate,
  projectName,
} from "../../lib/format";
import type { Project } from "../../types";
import type { V3Tab } from "../../v3/v3types";
import { useT, type StringKey } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";
import { useUpdates } from "../../lib/useUpdates";
import { useStackUpdates } from "../../lib/useStackUpdates";
import { useV3Theme } from "../../lib/themes";
import { Sparkline } from "./Sparkline";
import { ModernHero } from "./modern/ModernHero";

// Only nag about reclaimable space once it's worth a click.
const CLEANUP_REMINDER_THRESHOLD = 50 * 1024 * 1024; // 50 MB
interface CleanupItem {
  bytes: number;
}

type T = (k: StringKey, vars?: Record<string, string | number>) => string;

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

// 0-100 freshness based on days since last activity. 0d → 100, 30d+ → 50.
function freshnessScore(daysAgo: number): number {
  if (daysAgo <= 0) return 100;
  if (daysAgo >= 30) return 50;
  return Math.round(100 - daysAgo * 1.7);
}

// =============================================================
// Signal feed — the Overview leads with what needs a DECISION, not
// counts. Only actionable items raise a row: critical/warning audit
// findings (INFO is never shown), and an "all clear" when there's
// nothing. Updates/cleanup reminders plug in here as later phases add
// their data sources.
// =============================================================

// Bytes → "12.3 MB". Reclaimable space below the reminder threshold is
// treated as "nothing worth nagging about".
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

interface SignalFeedProps {
  crit: number;
  warn: number;
  reclaimableBytes: number;
  updateCount: number;
  loading: boolean;
  onJump: (tab: V3Tab) => void;
  t: T;
}

function SignalFeed({
  crit,
  warn,
  reclaimableBytes,
  updateCount,
  loading,
  onJump,
  t,
}: SignalFeedProps) {
  if (loading) {
    return (
      <section className="v3-card v3-signal-feed">
        <div className="v3-empty">{t("overview.signal_checking")}</div>
      </section>
    );
  }
  const showCleanup = reclaimableBytes > 0;
  const showUpdates = updateCount > 0;
  const hasSignal = crit > 0 || warn > 0 || showCleanup || showUpdates;
  return (
    <section className="v3-card v3-signal-feed">
      <header className="v3-card-head">
        <h2 className="v3-card-title">{t("overview.signal_title")}</h2>
      </header>
      {!hasSignal ? (
        <div className="v3-signal-clear">
          <CheckCircle2 size={16} strokeWidth={2.2} />
          <span>{t("overview.signal_all_clear")}</span>
        </div>
      ) : (
        <div className="v3-signal-list">
          {crit > 0 && (
            <button
              type="button"
              className="v3-signal-row v3-signal-crit"
              onClick={() => onJump("audit")}
            >
              <AlertTriangle size={15} strokeWidth={2.2} />
              <span className="v3-signal-text">
                {t("overview.signal_crit", { n: crit })}
              </span>
              <ChevronRight size={15} strokeWidth={2} className="v3-chev" />
            </button>
          )}
          {warn > 0 && (
            <button
              type="button"
              className="v3-signal-row v3-signal-warn"
              onClick={() => onJump("audit")}
            >
              <ShieldAlert size={15} strokeWidth={2.2} />
              <span className="v3-signal-text">
                {t("overview.signal_warn", { n: warn })}
              </span>
              <ChevronRight size={15} strokeWidth={2} className="v3-chev" />
            </button>
          )}
          {showUpdates && (
            <button
              type="button"
              className="v3-signal-row v3-signal-info"
              onClick={() => onJump("settings")}
            >
              <ArrowUpCircle size={15} strokeWidth={2.2} />
              <span className="v3-signal-text">
                {t("overview.signal_updates", { n: updateCount })}
              </span>
              <ChevronRight size={15} strokeWidth={2} className="v3-chev" />
            </button>
          )}
          {showCleanup && (
            <button
              type="button"
              className="v3-signal-row v3-signal-info"
              onClick={() => onJump("cleanup")}
            >
              <Trash2 size={15} strokeWidth={2.2} />
              <span className="v3-signal-text">
                {t("overview.signal_cleanup", { size: formatBytes(reclaimableBytes) })}
              </span>
              <ChevronRight size={15} strokeWidth={2} className="v3-chev" />
            </button>
          )}
        </div>
      )}
    </section>
  );
}

// =============================================================
// Tokens panel — inline on the Overview (no longer its own tab). A
// simple day/week/month filter over the existing token_usage IPC.
// =============================================================

interface DayUsage {
  date: string;
  total: number;
  sessions: number;
}
interface TokenStats {
  by_day: DayUsage[];
  range_start: string;
  range_end: string;
  total_all: number;
  sessions: number;
}

const TOKEN_RANGES: { key: StringKey; days: number }[] = [
  { key: "overview.tokens_day", days: 1 },
  { key: "overview.tokens_week", days: 7 },
  { key: "overview.tokens_month", days: 30 },
];

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const s = Math.trunc(n).toString();
  const out: string[] = [];
  let i = s.length;
  while (i > 0) {
    const start = Math.max(0, i - 3);
    out.unshift(s.slice(start, i));
    i = start;
  }
  return out.join(" ");
}

// Abbreviated token total: 2 410 000 → { value: "2.41", unit: "M" }. K / M /
// B / T, ~3 significant figures. The exact count stays available on the
// num's title (hover).
function formatTokensShort(n: number): { value: string; unit: string } {
  if (!Number.isFinite(n) || n <= 0) return { value: "0", unit: "" };
  if (n < 1000) return { value: String(Math.trunc(n)), unit: "" };
  const units = ["K", "M", "B", "T"];
  let v = n;
  let u = -1;
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000;
    u += 1;
  }
  const value = v >= 100 ? String(Math.round(v)) : v.toFixed(v >= 10 ? 1 : 2);
  return { value, unit: units[u] };
}

// Calm monochrome bar chart for the modern theme (replaces the sparkline).
// Heights are proportional to the window max; the most recent bar is hi-lit.
function TokenBars({ data }: { data: number[] }) {
  if (data.length === 0) return null;
  const max = Math.max(1, ...data);
  return (
    <div className="v3-token-bars" aria-hidden="true">
      {data.map((v, i) => (
        <span
          key={i}
          className={"v3-token-bar" + (i === data.length - 1 ? " is-last" : "")}
          style={{ height: `${Math.max(4, Math.round((v / max) * 100))}%` }}
        />
      ))}
    </div>
  );
}

function TokensPanel({ t }: { t: T }) {
  const [days, setDays] = useState(7);
  const [stats, setStats] = useState<TokenStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    invoke<TokenStats>("token_usage", { windowDays: days })
      .then((res) => {
        if (!cancelled) setStats(res);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const spark = useMemo(() => (stats ? stats.by_day.map((d) => d.total) : []), [stats]);
  // Modern theme swaps the line sparkline for a calm monochrome bar chart.
  const isModern = useV3Theme().startsWith("modern");

  return (
    <article className="v3-card v3-tokens-panel">
      <header className="v3-card-head">
        <h2 className="v3-card-title">{t("overview.tokens_title")}</h2>
        <div className="v3-tokens-range-filter">
          {TOKEN_RANGES.map((r) => (
            <button
              key={r.days}
              type="button"
              className={"v3-tokens-range-btn" + (days === r.days ? " active" : "")}
              onClick={() => setDays(r.days)}
            >
              {t(r.key)}
            </button>
          ))}
        </div>
      </header>
      {loading ? (
        <div className="v3-empty">{t("common.loading")}</div>
      ) : !stats || stats.total_all === 0 ? (
        <div className="v3-empty">{t("overview.tokens_empty")}</div>
      ) : (
        <div className="v3-tokens-panel-body">
          <div className="v3-tokens-panel-kpi">
            <span
              className="v3-tokens-panel-num"
              title={`${formatTokens(stats.total_all)} tokens`}
            >
              {formatTokensShort(stats.total_all).value}
              <span className="v3-tokens-panel-unit">
                {formatTokensShort(stats.total_all).unit}
              </span>
            </span>
            <span className="v3-tokens-panel-sub">
              {t("overview.tokens_sub", { n: stats.sessions })}
            </span>
          </div>
          {isModern ? (
            <TokenBars data={spark} />
          ) : (
            <Sparkline data={spark} width={420} height={48} />
          )}
        </div>
      )}
    </article>
  );
}

// =============================================================
// Overview view — leads with the signal feed, then recent projects,
// an inline tokens panel, and the gentle-ai inventory.
// =============================================================

export function OverviewView({
  greeting,
  projects,
  goals,
  stats,
  loading,
  onOpenProject,
  onJump,
  onCycleTheme,
  onOpenPalette,
}: {
  greeting: string;
  projects: Project[];
  goals: Record<string, string | null>;
  stats: { crit: number; warn: number; info: number; total: number; health: number };
  loading: boolean;
  onOpenProject: (path: string) => void;
  onJump: (tab: V3Tab) => void;
  onCycleTheme: () => void;
  onOpenPalette?: () => void;
}) {
  const { t } = useT();
  // Modern themes get the bespoke orb hero in place of the plain header; the
  // real sections (signal feed / projects / tokens / gentle-ai) stay.
  const theme = useV3Theme();
  const isModern = theme === "modern-light" || theme === "modern-dark";
  const recentProjects = projects.slice(0, 3);

  // Reclaimable space (cleanup reminder). Sum the cleanup plan's bytes for
  // items older than 30 days; only surfaced past the threshold.
  const [reclaimableBytes, setReclaimableBytes] = useState(0);
  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    invoke<CleanupItem[]>("cleanup_plan", { olderThanDays: 30 })
      .then((items) => {
        if (cancelled) return;
        const total = items.reduce((sum, it) => sum + (it.bytes || 0), 0);
        setReclaimableBytes(total >= CLEANUP_REMINDER_THRESHOLD ? total : 0);
      })
      .catch(() => {
        /* best-effort — no reminder if the scan fails */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Available updates (app self-update + gentle-ai stack tools). Both hooks
  // do their own IPCs on mount; we only read the resulting counts.
  const updates = useUpdates();
  const stack = useStackUpdates();
  const updateCount =
    (updates.app?.available ? 1 : 0) +
    stack.tools.filter((tool) => tool.state === "update_available").length;

  const ONBOARDING_KEY = "csk-onboarding-dismissed";
  const [onboardingDismissed, setOnboardingDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(ONBOARDING_KEY) === "1";
    } catch {
      return true;
    }
  });
  const dismissOnboarding = () => {
    try {
      localStorage.setItem(ONBOARDING_KEY, "1");
    } catch {
      /* ignore */
    }
    setOnboardingDismissed(true);
  };

  return (
    <div className="v3-view v3-view-overview">
      {isModern ? (
        <ModernHero
          greeting={greeting}
          stats={stats}
          projectsCount={projects.length}
          onOpenPalette={onOpenPalette ?? (() => {})}
        />
      ) : (
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
      )}

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
                onClick={() => onJump("claude")}
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

      {/* Modern's orb hero card already carries the review status ("All clear"
          / "N need review"), so the signal feed would just repeat it. Other
          themes have no hero summary, so they keep it. */}
      {!isModern && (
        <SignalFeed
          crit={stats.crit}
          warn={stats.warn}
          reclaimableBytes={reclaimableBytes}
          updateCount={updateCount}
          loading={loading}
          onJump={onJump}
          t={t}
        />
      )}

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

      <TokensPanel t={t} />
    </div>
  );
}
