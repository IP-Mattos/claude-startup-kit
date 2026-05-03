import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";

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
  const { t, lang } = useT();
  const time = now.toLocaleTimeString(lang === "es" ? "es-AR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <footer className="v3-statusbar">
      <div className="v3-statusbar-left">
        <span className="v3-statusbar-version">v0.1.0</span>
        <span className="v3-statusbar-sep" aria-hidden="true">|</span>
        <span className="v3-statusbar-state">{t("statusbar.ready")}</span>
      </div>
      <div className="v3-statusbar-right">
        <span>{time}</span>
        <span className="v3-statusbar-dot" aria-hidden="true" />
      </div>
    </footer>
  );
}
