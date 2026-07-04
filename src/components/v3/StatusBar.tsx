import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { useT } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";

// Minimal bottom strip: identity (version + ready state) on the left,
// live clock + activity dot on the right. Project / finding counts
// moved out — they're already shown in the sidebar System Status card
// and per-tab headers.
export function StatusBar() {
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  // Real app version from tauri.conf.json — hidden while loading and in
  // plain browser preview where the IPC isn't available.
  const [version, setVersion] = useState<string | null>(null);
  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    getVersion()
      .then((v) => {
        if (!cancelled) setVersion(v);
      })
      .catch(() => {
        /* leave hidden */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const { t, lang } = useT();
  const time = now.toLocaleTimeString(lang === "es" ? "es-AR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <footer className="v3-statusbar">
      <div className="v3-statusbar-left">
        {version && (
          <>
            <span className="v3-statusbar-version">v{version}</span>
            <span className="v3-statusbar-sep" aria-hidden="true">|</span>
          </>
        )}
        <span className="v3-statusbar-state">{t("statusbar.ready")}</span>
      </div>
      <div className="v3-statusbar-right">
        <span>{time}</span>
        <span className="v3-statusbar-dot" aria-hidden="true" />
      </div>
    </footer>
  );
}
