import { useEffect, useState } from "react";
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useT } from "../../lib/i18n";
import { TOPBAR_NAV } from "../../constants/v3Nav";
import type { V3Tab } from "../../v3/v3types";

// Tauri APIs throw when loaded from a plain browser at localhost:1420 (no
// __TAURI_INTERNALS__). Guard so the topbar still renders for previews.
const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const safeGetCurrentWindow = () => {
  try {
    return IS_TAURI ? getCurrentWindow() : null;
  } catch {
    return null;
  }
};

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
          <img src="/Shield.svg" alt="" draggable={false} />
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
