import { ShieldCheck } from "lucide-react";
import { plural, useT } from "../../lib/i18n";
import { SIDEBAR_SECTIONS } from "../../constants/v3Nav";
import type { Project } from "../../types";
import type { V3Tab } from "../../v3/v3types";
import { projectName } from "../../lib/format";

// Sidebar with brand block, primary nav, and a System Status card pinned
// at the bottom. The headline + dot are derived from finding counts so
// critical/warn/ok read at a glance.
//
// When the active theme is `data-dense` the sidebar additionally shows
// a flat list of all projects under the nav — same UX as the
// `mockups/04-data-dense.html` reference, where the sidebar's role
// expands from "tabs only" to "tabs + jump-to-project". Other themes
// hide the project list entirely (see CSS gate by data-theme-v3).
export function Sidebar({
  activeTab,
  onTab,
  lastScanAgo,
  onRunAudit,
  critCount,
  warnCount,
  findingTotal,
  projects,
  onOpenProject,
}: {
  activeTab: V3Tab;
  onTab: (t: V3Tab) => void;
  lastScanAgo: string;
  onRunAudit: () => void;
  critCount: number;
  warnCount: number;
  findingTotal: number;
  /** Projects already fetched at AppV3 — displayed as flat list when
   *  theme is data-dense. Other themes ignore via CSS. */
  projects: Project[];
  /** Open project in VSCode — fired from a project row click. */
  onOpenProject: (path: string) => void;
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
    <aside className="v3-sidebar" aria-label={t("window.primary_nav")}>
      <div className="v3-sidebar-logo">
        <div className="v3-sidebar-logo-mark" aria-hidden="true">
          {/* Inlined so the mark adapts per theme: the square fills with the
              theme accent and the shield strokes with its on-accent ink
              (orange+white on light/dark, mono on modern, olive+lime on
              gameboy). Geometry matches public/Shield.svg. */}
          <svg className="v3-logo-svg" viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
            <rect className="v3-logo-sq" width="512" height="512" rx="116" ry="116" />
            <g
              className="v3-logo-shield"
              transform="translate(86 86) scale(14.16667)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              fill="none"
            >
              <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
              <path d="m9 12 2 2 4-4" />
            </g>
          </svg>
        </div>
        <div className="v3-sidebar-logo-text">
          <span className="v3-sidebar-logo-line1">CLAUDE</span>
          <span className="v3-sidebar-logo-line2">STARTUP KIT</span>
        </div>
      </div>

      <nav className="v3-sidebar-nav">
        {SIDEBAR_SECTIONS.map((section, sIdx) => (
          <div
            key={section.labelKey}
            className={
              "v3-sidebar-section" + (sIdx > 0 ? " v3-sidebar-section-sep" : "")
            }
          >
            <div className="v3-sidebar-section-title">{t(section.labelKey)}</div>
            {section.entries.map(({ id, navKey, Icon }) => {
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
          </div>
        ))}
      </nav>

      {/* Project list for data-dense theme. Hidden by default in CSS;
          unhidden only when body[data-theme-v3="data-dense"]. Click
          jumps straight to the project in VS Code (no Projects view
          detour). */}
      <div className="v3-sidebar-projects" aria-label={t("nav.projects")}>
        <div className="v3-sidebar-projects-title">
          {t("nav.projects")}
          <span className="v3-sidebar-projects-count">{projects.length}</span>
        </div>
        {projects.length === 0 ? (
          <div className="v3-sidebar-projects-empty">
            {t("projects.empty_window", { days: 14 })}
          </div>
        ) : (
          <div className="v3-sidebar-projects-list">
            {projects.map((p) => (
              <button
                key={p.path}
                type="button"
                className="v3-sidebar-project"
                title={p.path}
                onClick={() => onOpenProject(p.path)}
              >
                <span className="v3-sidebar-project-name">
                  {projectName(p.path)}
                </span>
                <span className="v3-sidebar-project-ago">
                  {p.days_ago === 0
                    ? t("ago.minutes", { n: 0 }).replace(/\d+m/, "0d")
                    : t("ago.days", { n: p.days_ago })}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="v3-sidebar-spacer" />

      <div className={`v3-system-status v3-system-status-${tone}`}>
        <div className="v3-system-status-row">
          <span className="v3-status-dot" aria-hidden="true" />
          <span className="v3-system-status-headline">{headline}</span>
        </div>
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
