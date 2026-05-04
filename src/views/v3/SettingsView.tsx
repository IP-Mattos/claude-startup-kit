import { useEffect, useState } from "react";
import { Check } from "lucide-react";
import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import {
  V3_THEME_OPTIONS,
  applyAndPersistV3Theme,
  readSavedV3Theme,
} from "../../lib/themes";
import type { V3Theme } from "../../lib/themes";
import { useUpdates } from "../../lib/useUpdates";
import { useStackUpdates } from "../../lib/useStackUpdates";
import type { StackToolStatus } from "../../lib/useStackUpdates";
import { useT } from "../../lib/i18n";
import type { LangPref } from "../../lib/i18n";
import { ConfirmModal } from "../../components/v3/ConfirmModal";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function SettingsView() {
  const [theme, setTheme] = useState<V3Theme>(() => readSavedV3Theme());
  const updates = useUpdates();
  const stack = useStackUpdates();
  const [confirmingApplyAll, setConfirmingApplyAll] = useState(false);
  const { t, pref, setPref } = useT();

  // Autostart state: read once from the OS on mount, then mirror locally
  // so the toggle reflects user input immediately while the IPC round-trip
  // is in flight. `null` means "not yet known" — used to render a disabled
  // checkbox until we have ground truth.
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartBusy, setAutostartBusy] = useState(false);
  const [autostartError, setAutostartError] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_TAURI) {
      setAutostart(false);
      return;
    }
    isAutostartEnabled()
      .then((enabled) => setAutostart(enabled))
      .catch((e) => setAutostartError(String(e)));
  }, []);

  const toggleAutostart = async () => {
    if (!IS_TAURI || autostart === null) return;
    setAutostartBusy(true);
    setAutostartError(null);
    const next = !autostart;
    try {
      if (next) await enableAutostart();
      else await disableAutostart();
      setAutostart(next);
    } catch (e) {
      setAutostartError(String(e));
    } finally {
      setAutostartBusy(false);
    }
  };

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
            onApply={() => {
              void updates.applyApp();
            }}
            applying={updates.applyingApp}
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
          <h2 className="v3-card-title">{t("settings.stack_title")}</h2>
          <div className="v3-card-actions">
            <button
              type="button"
              className="v3-link"
              onClick={stack.checkNow}
              disabled={stack.loading || stack.applying}
            >
              {stack.loading ? t("settings.checking") : t("settings.check_now")}
            </button>
            <button
              type="button"
              className="v3-btn-primary v3-btn-sm"
              onClick={() => setConfirmingApplyAll(true)}
              disabled={
                stack.applying ||
                stack.loading ||
                !stack.tools.some((t) => t.state === "update_available")
              }
              title={t("settings.stack_apply_all_title")}
            >
              {stack.applying
                ? t("settings.stack_applying")
                : t("settings.stack_apply_all")}
            </button>
          </div>
        </header>
        <div className="v3-form">
          {stack.tools.length === 0 ? (
            <div className="v3-row-meta">
              {stack.loading
                ? t("common.loading")
                : t("settings.stack_empty")}
            </div>
          ) : (
            stack.tools.map((tool) => (
              <StackToolRow key={tool.name} tool={tool} />
            ))
          )}
          {stack.error && (
            <div className="v3-error" role="alert" aria-live="assertive">
              {stack.error}
            </div>
          )}
          <p className="v3-row-meta">{t("settings.stack_hint")}</p>
        </div>
      </article>

      <ConfirmModal
        open={confirmingApplyAll}
        title={t("settings.stack_confirm_title")}
        message={t("settings.stack_confirm_message")}
        confirmLabel={t("settings.stack_apply_all")}
        cancelLabel={t("common.cancel")}
        onCancel={() => setConfirmingApplyAll(false)}
        onConfirm={() => {
          setConfirmingApplyAll(false);
          void stack.applyAll();
        }}
      />

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("settings.autostart_title")}</h2>
        </header>
        <div className="v3-form">
          <label className="v3-toggle-row">
            <input
              type="checkbox"
              checked={autostart === true}
              disabled={autostart === null || autostartBusy || !IS_TAURI}
              onChange={() => {
                void toggleAutostart();
              }}
            />
            <div className="v3-toggle-body">
              <div className="v3-toggle-label">
                {t("settings.autostart_label")}
              </div>
              <div className="v3-row-meta">{t("settings.autostart_hint")}</div>
            </div>
          </label>
          {autostartError && (
            <div className="v3-error" role="alert" aria-live="assertive">
              {autostartError}
            </div>
          )}
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
// When an update is available AND `onApply` is provided, also renders an
// "Update now" button right next to the status so the user can trigger the
// upgrade from Settings without waiting for the top-of-page banner.
function UpdateRow({
  label,
  status,
  notConfiguredHint,
  onApply,
  applying,
}: {
  label: string;
  status: import("../../lib/useUpdates").UpdateStatus | null;
  notConfiguredHint: string;
  onApply?: () => void;
  applying?: boolean;
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
        {onApply && (
          <button
            type="button"
            className="v3-update-row-action"
            onClick={onApply}
            disabled={applying === true}
          >
            {applying ? t("common.updating") : t("common.update_now")}
          </button>
        )}
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

// Renders one row of the Stack tools card. Visual contract mirrors
// `<UpdateRow>` so the two cards (CSK self-update vs gentle-ai-managed
// stack) feel like one continuous list. We deliberately don't surface a
// per-row "Update" button here — `gentle-ai upgrade` is all-or-nothing
// upstream; the global "Actualizar todo" button does the work.
function StackToolRow({ tool }: { tool: StackToolStatus }) {
  const { t } = useT();
  if (tool.state === "not_installed") {
    return (
      <div className="v3-update-row">
        <div className="v3-update-row-label">{tool.name}</div>
        <div className="v3-update-row-status v3-update-row-status-dim">
          {t("settings.stack_state_not_installed", { latest: tool.latest })}
        </div>
      </div>
    );
  }
  if (tool.state === "update_available") {
    return (
      <div className="v3-update-row">
        <div className="v3-update-row-label">{tool.name}</div>
        <div className="v3-update-row-status v3-update-row-status-warn">
          v{tool.installed} → v{tool.latest}
        </div>
      </div>
    );
  }
  // up_to_date or unknown future state — render as if up to date.
  return (
    <div className="v3-update-row">
      <div className="v3-update-row-label">{tool.name}</div>
      <div className="v3-update-row-status v3-update-row-status-ok">
        v{tool.installed ?? tool.latest} · {t("settings.update_up_to_date")}
      </div>
    </div>
  );
}
