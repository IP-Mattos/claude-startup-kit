import React from "react";
import { useT } from "../../lib/i18n";
import type { V3Tab } from "../../v3/v3types";

// Soft right-panel nudge — single line that names the next thing worth
// looking at. Sidebar System Status already carries the count, so the
// companion never repeats numbers without context.
export function CompanionWidget({
  companionName,
  companionImage,
  critCount,
  warnCount,
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
  todayProject: string | null;
  todayProjectPath: string | null;
  lastScanAgo: string;
  onJump: (tab: V3Tab) => void;
  onOpenProject: (path: string) => void;
}) {
  const { t } = useT();
  // i18n strings carry {n} as the only digit run; replace it with a
  // styled span so the count pops without complicating the catalog.
  const rawMessage =
    critCount > 0
      ? t("companion.has_crits", { n: critCount })
      : warnCount > 0
      ? t("companion.has_warns", { n: warnCount })
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

  // Action and message agree in priority so headline + button never
  // contradict each other.
  const action: { label: string; onClick: () => void } =
    critCount > 0 || warnCount > 0
      ? {
          label: t("companion.action_review_audit"),
          onClick: () => onJump("audit"),
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
        <span
          className="v3-companion-scan"
          title={`${t("companion.stat_scan")}: ${lastScanAgo}`}
        >
          {lastScanAgo}
        </span>
        <button
          className="v3-btn-primary v3-companion-cta"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      </div>
    </section>
  );
}
