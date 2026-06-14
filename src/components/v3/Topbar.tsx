import { useEffect, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";
import { TOPBAR_NAV } from "../../constants/v3Nav";
import type { V3Tab } from "../../v3/v3types";

const safeGetCurrentWindow = () => {
  try {
    return IS_TAURI ? getCurrentWindow() : null;
  } catch {
    return null;
  }
};

// 24h HH:MM:SS, zero-padded. Locale-independent so the readout is consistent
// across machines no matter what the OS regional format is set to.
function formatClock(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Brand on the left, low-frequency tabs in the middle, window controls
// on the right. Sidebar owns the high-frequency operational tabs.
export function Topbar({
  activeTab,
  onTab,
}: {
  activeTab: V3Tab;
  onTab: (t: V3Tab) => void;
}) {
  const [maximized, setMaximized] = useState(false);
  // Live clock — updated once per second. Shown next to the window controls
  // so the data-dense theme (and anyone who likes it) gets a Bloomberg-style
  // wall-clock readout. Hidden in CSS for themes where it would be visual
  // noise; cheap to compute regardless.
  const [clock, setClock] = useState(() => formatClock(new Date()));
  useEffect(() => {
    const tick = () => setClock(formatClock(new Date()));
    // Align the first interval to the next whole second so subsequent ticks
    // happen on the second boundary (no drift in display vs the OS clock).
    const now = Date.now();
    const msToNextSecond = 1000 - (now % 1000);
    let interval: ReturnType<typeof setInterval> | undefined;
    const timeout = setTimeout(() => {
      tick();
      interval = setInterval(tick, 1000);
    }, msToNextSecond);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, []);
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
          {/* Inlined to adapt per theme (see Sidebar logo). */}
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
      <span
        className="v3-topbar-clock mono"
        aria-label={t("topbar.clock_label")}
        data-tauri-drag-region
      >
        {clock}
      </span>
      <div className="v3-window-controls">
        <button
          className="v3-wc"
          onClick={() => win?.minimize()}
          aria-label={t("window.minimize")}
        >
          <Minus size={14} strokeWidth={2.4} />
        </button>
        <button
          className="v3-wc"
          onClick={() => win?.toggleMaximize()}
          aria-label={maximized ? t("window.restore") : t("window.maximize")}
        >
          <Square size={12} strokeWidth={2.2} />
        </button>
        <button
          className="v3-wc v3-wc-close"
          onClick={() => win?.close()}
          aria-label={t("window.close")}
        >
          <X size={14} strokeWidth={2.4} />
        </button>
      </div>
    </header>
  );
}
