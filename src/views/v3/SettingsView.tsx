import { useEffect, useState } from "react";
import { Check, Wrench } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
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
import type { LangPref, StringKey } from "../../lib/i18n";
import { friendlyErrorEn } from "../../lib/format";
import { IS_TAURI } from "../../lib/env";
import { ConfirmModal } from "../../components/v3/ConfirmModal";
import { CompanionsView } from "./CompanionsView";

// Grouped settings — a segmented sub-nav instead of one long scroll. The id
// stays English; the label resolves via useT() at render.
type SettingsSection = "general" | "claude_code" | "gentle_ai" | "csk";

const SETTINGS_SECTIONS: { id: SettingsSection; key: StringKey }[] = [
  { id: "general", key: "settings.section_general" },
  { id: "claude_code", key: "settings.section_claude_code" },
  { id: "gentle_ai", key: "settings.section_gentle_ai" },
  { id: "csk", key: "settings.section_csk" },
];

// Mirror of the Rust `ClaudeCodeStatus` struct returned by `claude_code_status`.
type ClaudeCodeStatus = {
  native_installed: boolean;
  native_version: string;
  native_path: string;
  path_version: string;
};

interface SettingsViewProps {
  companionName: string;
  companionImage: string | null;
  onCompanionNameChange: (v: string) => void;
  onCompanionImageChange: (v: string | null) => void;
}

export function SettingsView({
  companionName,
  companionImage,
  onCompanionNameChange,
  onCompanionImageChange,
}: SettingsViewProps) {
  const [section, setSection] = useState<SettingsSection>("general");
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

  // Persona / output style — read-only mirror of `outputStyle` in
  // `~/.claude/settings.json`. gentle-ai writes it; CSK only surfaces it so
  // the user knows which persona is active without opening the file. `null`
  // means "not loaded yet", `undefined` means "loaded, key absent → default".
  const [outputStyle, setOutputStyle] = useState<string | null | undefined>(null);

  // VS Code extension fix — runs the bundled PowerShell patch and shows
  // the captured output below the button. Idempotent: safe to re-run.
  const [fixRunning, setFixRunning] = useState(false);
  const [fixOutput, setFixOutput] = useState<string | null>(null);
  const [fixError, setFixError] = useState<string | null>(null);
  const runFixVscode = async () => {
    if (!IS_TAURI) return;
    setFixRunning(true);
    setFixError(null);
    setFixOutput(null);
    try {
      const result = await invoke<string>("fix_claude_vscode_extension");
      setFixOutput(result);
    } catch (e) {
      setFixError(friendlyErrorEn(e));
    } finally {
      setFixRunning(false);
    }
  };

  // Claude Code version + update. Detects the native (~/.local/bin/claude.exe)
  // and PATH installs, surfaces a stale/mismatch case, and runs `claude update`
  // (preferring the native install). `ccDone` carries the success message.
  const [ccStatus, setCcStatus] = useState<ClaudeCodeStatus | null>(null);
  const [ccUpdating, setCcUpdating] = useState(false);
  const [ccError, setCcError] = useState<string | null>(null);
  const [ccDone, setCcDone] = useState<string | null>(null);

  const refreshClaudeCode = async () => {
    if (!IS_TAURI) return;
    try {
      const s = await invoke<ClaudeCodeStatus>("claude_code_status");
      setCcStatus(s);
    } catch (e) {
      setCcError(friendlyErrorEn(e));
    }
  };

  useEffect(() => {
    void refreshClaudeCode();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runUpdateClaudeCode = async () => {
    if (!IS_TAURI) return;
    setCcUpdating(true);
    setCcError(null);
    setCcDone(null);
    try {
      const version = await invoke<string>("update_claude_code");
      await refreshClaudeCode();
      setCcDone(t("claude.update_done", { version }));
    } catch (e) {
      setCcError(friendlyErrorEn(e));
    } finally {
      setCcUpdating(false);
    }
  };

  useEffect(() => {
    if (!IS_TAURI) {
      setAutostart(false);
      return;
    }
    isAutostartEnabled()
      .then((enabled) => setAutostart(enabled))
      .catch((e) => setAutostartError(String(e)));
  }, []);

  useEffect(() => {
    if (!IS_TAURI) {
      setOutputStyle(undefined);
      return;
    }
    invoke<string | null>("read_output_style")
      .then((v) => setOutputStyle(v ?? undefined))
      .catch(() => setOutputStyle(undefined));
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

  // Engram sync — directory the user picks once and we run `engram sync` from
  // it on push/pull. Persisted in localStorage so the choice survives reloads.
  // Could move to startup-kit-config.json later for cross-tool visibility, but
  // it's UI-only state today so localStorage is enough.
  const SYNC_DIR_KEY = "csk-sync-dir";
  const [syncDir, setSyncDir] = useState<string>(() => {
    try {
      return localStorage.getItem(SYNC_DIR_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [syncBusy, setSyncBusy] = useState<"push" | "pull" | "status" | null>(null);
  const [syncOutput, setSyncOutput] = useState<
    { kind: "push" | "pull" | "status"; text: string; error: boolean } | null
  >(null);

  // claudewatch TUI — detect whether it's installed at ~/claudewatch and, if
  // not, copy the bundled exe + launcher scripts there. Mirrors the fix-vscode
  // busy/error pattern: status fetched on mount, then re-fetched after install
  // so the button flips between Install / Reinstall.
  const [cwStatus, setCwStatus] = useState<
    { installed: boolean; path: string } | null
  >(null);
  const [cwBusy, setCwBusy] = useState(false);
  const [cwMessage, setCwMessage] = useState<{ text: string; error: boolean } | null>(
    null,
  );

  const fetchClaudewatchStatus = async () => {
    if (!IS_TAURI) {
      setCwStatus({ installed: false, path: "" });
      return;
    }
    try {
      const s = await invoke<{ installed: boolean; path: string }>(
        "claudewatch_status",
      );
      setCwStatus(s);
    } catch {
      setCwStatus({ installed: false, path: "" });
    }
  };

  useEffect(() => {
    void fetchClaudewatchStatus();
  }, []);

  const installClaudewatch = async () => {
    if (!IS_TAURI) return;
    setCwBusy(true);
    setCwMessage(null);
    try {
      const path = await invoke<string>("install_claudewatch_tui");
      setCwMessage({ text: t("claudewatch.install_ok", { path }), error: false });
      await fetchClaudewatchStatus();
    } catch (e) {
      setCwMessage({ text: friendlyErrorEn(e), error: true });
    } finally {
      setCwBusy(false);
    }
  };

  const pickSyncDir = async () => {
    if (!IS_TAURI) return;
    try {
      const picked = await openDialog({
        directory: true,
        multiple: false,
        title: t("settings.sync_picker_title"),
      });
      if (typeof picked === "string" && picked.length > 0) {
        setSyncDir(picked);
        try {
          localStorage.setItem(SYNC_DIR_KEY, picked);
        } catch {
          /* localStorage unavailable */
        }
        setSyncOutput(null);
      }
    } catch {
      /* user closed the dialog — no-op */
    }
  };

  const runSync = async (kind: "push" | "pull" | "status") => {
    if (!syncDir || !IS_TAURI) return;
    const cmd =
      kind === "push"
        ? "engram_sync_push"
        : kind === "pull"
          ? "engram_sync_pull"
          : "engram_sync_status";
    setSyncBusy(kind);
    setSyncOutput(null);
    try {
      const out = await invoke<string>(cmd, { syncDir });
      setSyncOutput({ kind, text: out.trim(), error: false });
    } catch (e) {
      setSyncOutput({ kind, text: String(e), error: true });
    } finally {
      setSyncBusy(null);
    }
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

      <nav className="v3-settings-subnav" aria-label={t("settings.title")}>
        {SETTINGS_SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className={"v3-settings-subnav-btn" + (section === s.id ? " active" : "")}
            onClick={() => setSection(s.id)}
          >
            {t(s.key)}
          </button>
        ))}
      </nav>

      {/* ── General: language, theme, startup ── */}
      {section === "general" && (
        <>
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
        </>
      )}

      {/* ── Claude Code: VS Code extension fix ── */}
      {section === "claude_code" && (
        <>
        <article className="v3-card v3-fix-card">
          <header className="v3-card-head">
            <h2 className="v3-card-title">{t("claude.fix_title")}</h2>
          </header>
          <p className="v3-subtitle v3-fix-lead">{t("claude.fix_lead")}</p>
          <div className="v3-fix-actions">
            <button
              type="button"
              className="v3-btn-primary v3-fix-button"
              onClick={runFixVscode}
              disabled={fixRunning}
            >
              <Wrench size={13} strokeWidth={2} />
              {fixRunning ? t("claude.fix_running") : t("claude.fix_button")}
            </button>
          </div>
          {fixError && (
            <div className="v3-error" role="alert" aria-live="assertive">
              {fixError}
            </div>
          )}
          {fixOutput !== null && (
            <pre
              className="v3-fix-output"
              role="status"
              aria-live="polite"
              aria-label={t("claude.fix_output_aria")}
            >
              {fixOutput || t("claude.fix_output_empty")}
            </pre>
          )}
        </article>

        <article className="v3-card">
          <header className="v3-card-head">
            <h2 className="v3-card-title">{t("claude.cc_title")}</h2>
          </header>
          <p className="v3-subtitle v3-fix-lead">{t("claude.cc_desc")}</p>
          <div className="v3-form">
            <div className="v3-update-row">
              <div className="v3-update-row-label">
                <code className="v3-git-hash">
                  Claude Code:{" "}
                  {ccStatus ? ccStatus.path_version || "—" : t("common.loading")}
                </code>
                {ccStatus?.native_installed && (
                  <div className="v3-row-meta">
                    {ccStatus.native_path}: {ccStatus.native_version || "—"}
                  </div>
                )}
              </div>
            </div>
            {ccStatus &&
              ccStatus.native_installed &&
              !!ccStatus.native_version &&
              !!ccStatus.path_version &&
              ccStatus.native_version !== ccStatus.path_version && (
                <div className="v3-update-row-status-warn">
                  {t("claude.cc_mismatch")}
                </div>
              )}
          </div>
          <div className="v3-fix-actions">
            <button
              type="button"
              className="v3-btn-primary v3-fix-button"
              onClick={runUpdateClaudeCode}
              disabled={ccUpdating}
            >
              <Wrench size={13} strokeWidth={2} />
              {ccUpdating ? t("claude.updating") : t("claude.update_button")}
            </button>
          </div>
          {ccError && (
            <div className="v3-error" role="alert" aria-live="assertive">
              {ccError}
            </div>
          )}
          {ccDone && (
            <div
              className="v3-update-banner-result"
              role="status"
              aria-live="polite"
            >
              {ccDone}
            </div>
          )}
        </article>
        </>
      )}

      {/* ── Gentle AI: stack updates, persona, engram sync ── */}
      {section === "gentle_ai" && (
        <>
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
                  {stack.loading ? t("common.loading") : t("settings.stack_empty")}
                </div>
              ) : (
                stack.tools.map((tool) => (
                  <StackToolRow
                    key={tool.name}
                    tool={tool}
                    onInstall={stack.openInstallWizard}
                  />
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

          <article className="v3-card">
            <header className="v3-card-head">
              <h2 className="v3-card-title">{t("settings.persona_title")}</h2>
            </header>
            <div className="v3-form">
              <div className="v3-update-row">
                <div className="v3-update-row-label">
                  {outputStyle === null ? (
                    <span className="v3-row-dim">{t("common.loading")}</span>
                  ) : outputStyle === undefined ? (
                    <span className="v3-row-dim">{t("settings.persona_default")}</span>
                  ) : (
                    <code className="v3-git-hash">{outputStyle}</code>
                  )}
                  <div className="v3-row-meta">{t("settings.persona_set_by")}</div>
                </div>
              </div>
            </div>
          </article>

          {/* Engram sync — manual, file-based memory sync. */}
          <article className="v3-card">
            <header className="v3-card-head">
              <h2 className="v3-card-title">{t("settings.sync_title")}</h2>
            </header>
            <div className="v3-form">
              <p className="v3-row-meta">{t("settings.sync_hint")}</p>
              {!syncDir ? (
                <div className="v3-engsync-empty">
                  <p className="v3-engsync-empty-cta">{t("settings.sync_no_dir_yet")}</p>
                  <button
                    type="button"
                    className="v3-btn-primary v3-btn-sm"
                    onClick={() => void pickSyncDir()}
                    disabled={!IS_TAURI}
                  >
                    {t("settings.sync_pick_dir")}
                  </button>
                </div>
              ) : (
                <>
                  <div className="v3-engsync-dir-row">
                    <code className="v3-engsync-dir-path">{syncDir}</code>
                    <button
                      type="button"
                      className="v3-link"
                      onClick={() => void pickSyncDir()}
                      disabled={!IS_TAURI || syncBusy !== null}
                    >
                      {t("settings.sync_change_dir")}
                    </button>
                  </div>
                  <div className="v3-engsync-actions">
                    <button
                      type="button"
                      className="v3-btn-primary v3-btn-sm"
                      onClick={() => void runSync("push")}
                      disabled={syncBusy !== null}
                      title={t("settings.sync_push_title")}
                    >
                      {syncBusy === "push"
                        ? t("settings.sync_pushing")
                        : t("settings.sync_push")}
                    </button>
                    <button
                      type="button"
                      className="v3-btn-ghost v3-btn-sm"
                      onClick={() => void runSync("pull")}
                      disabled={syncBusy !== null}
                      title={t("settings.sync_pull_title")}
                    >
                      {syncBusy === "pull"
                        ? t("settings.sync_pulling")
                        : t("settings.sync_pull")}
                    </button>
                    <button
                      type="button"
                      className="v3-btn-ghost v3-btn-sm"
                      onClick={() => void runSync("status")}
                      disabled={syncBusy !== null}
                    >
                      {syncBusy === "status"
                        ? t("settings.sync_checking")
                        : t("settings.sync_status_btn")}
                    </button>
                  </div>
                  {syncOutput &&
                    (syncOutput.error ? (
                      <div className="v3-error" role="alert" aria-live="assertive">
                        {syncOutput.text}
                      </div>
                    ) : (
                      <pre className="v3-engsync-output">{syncOutput.text}</pre>
                    ))}
                </>
              )}
            </div>
          </article>
        </>
      )}

      {/* ── Claude Startup Kit: the app's own self-update ── */}
      {section === "csk" && (
        <>
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
              {updates.appError && (
                <div className="v3-error" role="alert" aria-live="assertive">
                  {updates.appError}
                </div>
              )}
              <p className="v3-row-meta">{t("settings.updates_auto_hint")}</p>
            </div>
          </article>
          <div className="v3-settings-group-sep" aria-hidden="true" />
          <article className="v3-card">
            <header className="v3-card-head">
              <h2 className="v3-card-title">{t("claudewatch.title")}</h2>
              {cwStatus &&
                (cwStatus.installed ? (
                  <span className="v3-update-row-status v3-update-row-status-ok">
                    <Check size={12} strokeWidth={3} /> {t("claudewatch.installed")}
                  </span>
                ) : (
                  <span className="v3-update-row-status v3-update-row-status-dim">
                    {t("claudewatch.not_installed")}
                  </span>
                ))}
            </header>
            <div className="v3-form">
              <p className="v3-row-meta">{t("claudewatch.desc")}</p>
              {cwStatus?.installed && cwStatus.path && (
                <p className="v3-row-dim">{cwStatus.path}</p>
              )}
              <button
                type="button"
                className="v3-btn-primary"
                onClick={() => {
                  void installClaudewatch();
                }}
                disabled={cwBusy || !IS_TAURI}
              >
                {cwBusy
                  ? t("claudewatch.installing")
                  : cwStatus?.installed
                    ? t("claudewatch.reinstall")
                    : t("claudewatch.install")}
              </button>
              {cwMessage && (
                <div
                  className={cwMessage.error ? "v3-error" : "v3-row-meta"}
                  role={cwMessage.error ? "alert" : undefined}
                  aria-live={cwMessage.error ? "assertive" : "polite"}
                >
                  {cwMessage.text}
                </div>
              )}
            </div>
          </article>
          <div className="v3-settings-group-sep" aria-hidden="true" />
          <CompanionsView
            name={companionName}
            image={companionImage}
            onNameChange={onCompanionNameChange}
            onImageChange={onCompanionImageChange}
          />
        </>
      )}

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
//
// `onInstall` is wired only on `not_installed` rows. It opens gentle-ai's
// interactive install wizard in a new terminal — same wizard regardless
// of which row was clicked, since upstream doesn't expose per-tool install.
function StackToolRow({
  tool,
  onInstall,
}: {
  tool: StackToolStatus;
  onInstall: () => Promise<void>;
}) {
  const { t } = useT();
  if (tool.state === "not_installed") {
    return (
      <div className="v3-update-row">
        <div className="v3-update-row-label">{tool.name}</div>
        <div className="v3-update-row-status v3-update-row-status-dim">
          {t("settings.stack_state_not_installed", { latest: tool.latest })}
        </div>
        <button
          type="button"
          className="v3-update-row-action"
          onClick={() => {
            void onInstall();
          }}
          title={t("settings.stack_install_title")}
        >
          {t("settings.stack_install")}
        </button>
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
