import { useState } from "react";
import { Check } from "lucide-react";
import {
  V3_THEME_OPTIONS,
  applyAndPersistV3Theme,
  readSavedV3Theme,
} from "../../lib/themes";
import type { V3Theme } from "../../lib/themes";
import { useUpdates } from "../../lib/useUpdates";
import { useT } from "../../lib/i18n";
import type { LangPref } from "../../lib/i18n";

export function SettingsView() {
  const [theme, setTheme] = useState<V3Theme>(() => readSavedV3Theme());
  const updates = useUpdates();
  const { t, pref, setPref } = useT();

  const pick = (next: V3Theme) => {
    setTheme(applyAndPersistV3Theme(next));
  };

  const langOptions: { value: LangPref; label: string }[] = [
    { value: "auto", label: t("settings.language_auto") },
    { value: "en", label: t("settings.language_en") },
    { value: "es", label: t("settings.language_es") },
  ];

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("settings.title")}</h1>
          <p className="v3-subtitle">{t("settings.subtitle")}</p>
        </div>
      </header>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("settings.language")}</h2>
        </header>
        <div className="v3-form">
          <div className="v3-lang-row">
            {langOptions.map((opt) => (
              <button
                key={opt.value}
                type="button"
                className={
                  "v3-lang-option" + (pref === opt.value ? " active" : "")
                }
                onClick={() => setPref(opt.value)}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </article>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("settings.updates")}</h2>
          <button
            type="button"
            className="v3-link"
            onClick={updates.checkNow}
            disabled={updates.checking}
          >
            {updates.checking ? t("settings.checking") : t("settings.check_now")}
          </button>
        </header>
        <div className="v3-form">
          <UpdateRow
            label={t("settings.update_app_label")}
            status={updates.app}
            notConfiguredHint={t("settings.update_app_hint")}
          />
          <UpdateRow
            label={t("settings.update_gentle_ai_label")}
            status={updates.gentleAi}
            notConfiguredHint={t("settings.update_gentle_ai_hint")}
          />
          {updates.error && (
            <div className="v3-error" role="alert" aria-live="assertive">
              {updates.error}
            </div>
          )}
          <p className="v3-row-meta">{t("settings.updates_auto_hint")}</p>
        </div>
      </article>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("settings.theme")}</h2>
          <span className="v3-row-dim">
            {t("settings.curated_palettes", { n: V3_THEME_OPTIONS.length })}
          </span>
        </header>
        <div className="v3-theme-grid">
          {V3_THEME_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              className={"v3-theme-card" + (theme === opt.id ? " active" : "")}
              onClick={() => pick(opt.id)}
            >
              <div className="v3-theme-swatch">
                <span style={{ background: opt.swatch[0] }} />
                <span style={{ background: opt.swatch[1] }} />
                <span style={{ background: opt.swatch[2] }} />
              </div>
              <div className="v3-theme-label">{opt.label}</div>
              {theme === opt.id && (
                <span className="v3-theme-check" aria-hidden="true">
                  <Check size={12} strokeWidth={3} />
                </span>
              )}
            </button>
          ))}
        </div>
      </article>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("settings.shortcuts")}</h2>
        </header>
        <div className="v3-form">
          <div className="v3-shortcuts">
            <div className="v3-shortcut">
              <kbd>Ctrl</kbd> + <kbd>1</kbd>…<kbd>7</kbd>
              <span>{t("settings.shortcut_switch_tabs")}</span>
            </div>
            <div className="v3-shortcut">
              <kbd>Ctrl</kbd> + <kbd>R</kbd>
              <span>{t("settings.shortcut_refresh")}</span>
            </div>
            <div className="v3-shortcut">
              <kbd>Ctrl</kbd> + <kbd>,</kbd>
              <span>{t("settings.shortcut_open_settings")}</span>
            </div>
            <div className="v3-shortcut">
              <kbd>Ctrl</kbd> + <kbd>T</kbd>
              <span>{t("settings.shortcut_cycle_theme")}</span>
            </div>
          </div>
        </div>
      </article>
    </div>
  );
}

// Renders one row of the Updates card. Shows current/latest with a status
// badge — "up to date", "update available", or "not configured" when the
// channel can't be reached (no published release / gentle-ai not on PATH).
function UpdateRow({
  label,
  status,
  notConfiguredHint,
}: {
  label: string;
  status: import("../../lib/useUpdates").UpdateStatus | null;
  notConfiguredHint: string;
}) {
  const { t } = useT();
  if (!status) {
    return (
      <div className="v3-update-row">
        <div className="v3-update-row-label">{label}</div>
        <div className="v3-update-row-status v3-update-row-status-dim">
          {t("common.loading")}
        </div>
      </div>
    );
  }
  if (!status.configured) {
    return (
      <div className="v3-update-row">
        <div className="v3-update-row-label">{label}</div>
        <div className="v3-update-row-status v3-update-row-status-dim">
          {t("settings.update_not_configured")}
          <div className="v3-row-meta">{notConfiguredHint}</div>
        </div>
      </div>
    );
  }
  if (status.available) {
    return (
      <div className="v3-update-row">
        <div className="v3-update-row-label">{label}</div>
        <div className="v3-update-row-status v3-update-row-status-warn">
          v{status.current} → v{status.latest}
        </div>
      </div>
    );
  }
  return (
    <div className="v3-update-row">
      <div className="v3-update-row-label">{label}</div>
      <div className="v3-update-row-status v3-update-row-status-ok">
        v{status.current} · {t("settings.update_up_to_date")}
      </div>
    </div>
  );
}
