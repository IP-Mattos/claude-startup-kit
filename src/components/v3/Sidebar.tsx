import { ShieldCheck } from "lucide-react";
import { plural, useT } from "../../lib/i18n";
import { SIDEBAR_NAV } from "../../constants/v3Nav";
import type { V3Tab } from "../../v3/v3types";

// Sidebar with brand block, primary nav, and a System Status card pinned
// at the bottom. The headline + dot are derived from finding counts so
// critical/warn/ok read at a glance.
export function Sidebar({
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
