import React from "react";
import { useT } from "../../lib/i18n";
import { THEME_COMPANIONS, useV3Theme } from "../../lib/themes";
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

  // A theme that ships its own character ("guardian") takes over the avatar
  // while it's active; otherwise the user's chosen image (or the default).
  const theme = useV3Theme();
  const avatarSrc = THEME_COMPANIONS[theme] ?? companionImage ?? "/Sia2.webp";

  return (
    <section className="v3-companion-widget">
      <div className="v3-companion-hero">
        <img
          className="v3-companion-hero-img"
          src={avatarSrc}
          alt=""
          draggable={false}
        />
        <div className="v3-companion-hero-scrim" aria-hidden="true" />
        <span className="v3-companion-chip">
          <span className="v3-status-dot" aria-hidden="true" />
          <span className="v3-companion-chip-name">{companionName}</span>
        </span>
      </div>
      <div className="v3-companion-glass">
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
      </div>
    </section>
  );
}
