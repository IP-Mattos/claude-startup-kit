import { Search } from "lucide-react";
import "./ModernHero.css";
import type { V3Tab } from "../../../v3/v3types";
import { useT } from "../../../lib/i18n";

interface Stats {
  crit: number;
  warn: number;
  info: number;
  total: number;
  health: number;
}

interface Props {
  greeting: string;
  stats: Stats;
  projectsCount: number;
  onJump: (tab: V3Tab) => void;
  onOpenPalette: () => void;
}

// The glossy 3D orb — verbatim from the modern mockup. White sphere, tilted
// orbital ring, one moon. Ring/shadow/moon colours flip per theme via the
// .mov-orb-* classes in ModernHero.css.
function Orb() {
  return (
    <div className="mov-orb" aria-hidden="true">
      <svg className="mov-orb-svg" viewBox="0 0 260 180" width="260" height="180">
        <defs>
          <radialGradient id="movOrbGloss" cx="36%" cy="28%" r="82%">
            <stop offset="0%" stopColor="#ffffff" />
            <stop offset="38%" stopColor="#f6f7f9" />
            <stop offset="66%" stopColor="#e6e9ed" />
            <stop offset="86%" stopColor="#cdd2d8" />
            <stop offset="100%" stopColor="#b3b9c1" />
          </radialGradient>
          <radialGradient id="movOrbHi" cx="33%" cy="24%" r="38%">
            <stop offset="0%" stopColor="#ffffff" stopOpacity="0.95" />
            <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="movMoon" cx="34%" cy="28%" r="80%">
            <stop offset="0%" stopColor="#3a3f47" />
            <stop offset="55%" stopColor="#1a1d22" />
            <stop offset="100%" stopColor="#000000" />
          </radialGradient>
        </defs>
        <ellipse className="mov-orb-shadow" cx="120" cy="156" rx="50" ry="9" />
        <g transform="rotate(-9 124 96)">
          <ellipse className="mov-orb-ring back" cx="124" cy="96" rx="106" ry="27" />
        </g>
        <circle className="mov-orb-body" cx="116" cy="88" r="58" fill="url(#movOrbGloss)" />
        <ellipse cx="100" cy="68" rx="28" ry="21" fill="url(#movOrbHi)" />
        <g transform="rotate(-9 124 96)">
          <path className="mov-orb-ring front" d="M18 96 A106 27 0 0 0 230 96" />
        </g>
        <circle className="mov-orb-moon" cx="188" cy="116" r="8" fill="url(#movMoon)" />
      </svg>
    </div>
  );
}

// The modern dashboard header: a centered search, the big greeting + actions,
// and the orb hero card. Rendered by OverviewView in place of the default
// header when a modern theme is active; the real Overview sections follow.
export function ModernHero({ greeting, stats, projectsCount, onJump, onOpenPalette }: Props) {
  const { t } = useT();

  const headline =
    stats.crit > 0
      ? t("modern.hero_crit", { n: stats.crit })
      : stats.warn > 0
        ? t("modern.hero_warn", { n: stats.warn })
        : t("modern.hero_stable");
  const sub = t("modern.hero_sub", { findings: stats.total, projects: projectsCount });

  return (
    <div className="mov-hero">
      <header className="mov-topbar">
        <button className="mov-search" onClick={onOpenPalette} type="button">
          <Search size={16} strokeWidth={2} aria-hidden="true" />
          <span>{t("modern.search_placeholder")}</span>
          <kbd>⌘ K</kbd>
        </button>
      </header>

      <section className="mov-hero-head">
        <div>
          <p className="mov-eyebrow">{t("modern.eyebrow")}</p>
          <h2>{greeting}</h2>
          <span>{t("modern.subtitle")}</span>
        </div>
        <div className="mov-hero-actions">
          <button className="mov-btn-ghost" type="button" onClick={onOpenPalette}>
            {t("modern.search")}
          </button>
          <button className="mov-btn-dark" type="button" onClick={() => onJump("projects")}>
            <span className="mov-plus">+</span> {t("modern.new_project")}
          </button>
        </div>
      </section>

      <section className="mov-hero-card">
        <div className="mov-hero-body">
          <span className="mov-status-pill">
            <span className="mov-dot" aria-hidden="true" /> {t("modern.gentle_online")}
          </span>
          <h3>{headline}</h3>
          <p>{sub}</p>
        </div>
        <Orb />
      </section>
    </div>
  );
}
