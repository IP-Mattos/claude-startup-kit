import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  RefreshCw,
  Wrench,
  XCircle,
} from "lucide-react";
import { friendlyErrorEn } from "../../lib/format";
import { plural, useT } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";
import { ConfirmModal } from "../../components/v3/ConfirmModal";
import { SkillDiscovery } from "../../components/v3/SkillDiscovery";

interface ClaudeSkill {
  name: string;
  description: string;
  path: string;
  usage_count: number;
}

interface McpServer {
  name: string;
  command: string;
  args: string[];
  source: "config" | "plugin" | string;
  enabled: boolean;
  path: string;
}

interface GentleAiComponent {
  name: string;
  installed: boolean;
  description: string;
  install_hint: string;
}

interface GentleAiStatus {
  cli_version: string | null;
  cli_path: string | null;
  components: GentleAiComponent[];
  skills_total: number;
  skills_external_total: number;
  hooks_total: number;
  mcp_servers_total: number;
  plugins_enabled: string[];
}

export function ClaudeView() {
  const { t } = useT();
  const [skills, setSkills] = useState<ClaudeSkill[]>([]);
  const [mcps, setMcps] = useState<McpServer[]>([]);
  const [status, setStatus] = useState<GentleAiStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Per-row pending state so toggling one MCP doesn't disable every switch.
  const [togglingName, setTogglingName] = useState<string | null>(null);

  // Sync state — separate from `loading` so the components grid stays
  // visible while the CLI runs. The result banner auto-dismisses after
  // 5s so it doesn't linger after the next refresh.
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState<string | null>(null);

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

  const runSync = async (includeTheme: boolean) => {
    if (!IS_TAURI || syncing) return;
    setSyncing(true);
    setSyncResult(null);
    setError(null);
    try {
      await invoke<string>("gentle_ai_sync", { includeTheme });
      setSyncResult(t("claude.sync_done"));
      // Bumping the nonce re-fetches status / skills / mcps so the
      // grid reflects whatever sync just installed.
      setRefreshNonce((n) => n + 1);
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setSyncing(false);
    }
  };

  // Per-component uninstall — gentle-ai takes a backup snapshot first so
  // this is reversible via `gentle-ai restore`. Single-flight by component.
  // Destructive, so the button opens a ConfirmModal instead of firing directly
  // (same pattern as the stack "Update all" flow in SettingsView).
  const [uninstallingComponent, setUninstallingComponent] = useState<string | null>(null);
  const [confirmingUninstall, setConfirmingUninstall] = useState<string | null>(null);
  const runUninstall = async (componentName: string) => {
    if (!IS_TAURI || uninstallingComponent) return;
    setUninstallingComponent(componentName);
    setSyncResult(null);
    setError(null);
    try {
      await invoke<string>("gentle_ai_uninstall_component", { component: componentName });
      setSyncResult(t("claude.uninstall_done", { name: componentName }));
      setRefreshNonce((n) => n + 1);
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setUninstallingComponent(null);
    }
  };

  // Auto-dismiss the sync result banner so it doesn't linger.
  useEffect(() => {
    if (!syncResult) return;
    const timer = setTimeout(() => setSyncResult(null), 5000);
    return () => clearTimeout(timer);
  }, [syncResult]);

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Three-stage fetch: gentle_ai_status + list_claude_skills + list_mcp_servers
    // all return instantly (no JSONL scan), then count_claude_skill_usage
    // enriches counts in the background. Same pattern used for project enrichment.
    Promise.all([
      invoke<GentleAiStatus>("gentle_ai_status").catch(() => null),
      invoke<ClaudeSkill[]>("list_claude_skills").catch(() => [] as ClaudeSkill[]),
      invoke<McpServer[]>("list_mcp_servers").catch(() => [] as McpServer[]),
    ])
      .then(([st, s, m]) => {
        if (cancelled) return;
        setStatus(st);
        setSkills(s);
        setMcps(m);
        setLoading(false);
        // Kick the usage scan AFTER the UI shows skills. Don't block render.
        if (s.length > 0) {
          invoke<Record<string, number>>("count_claude_skill_usage", {
            names: s.map((sk) => sk.name),
          })
            .then((counts) => {
              if (cancelled) return;
              setSkills((prev) =>
                prev
                  .map((sk) => ({ ...sk, usage_count: counts[sk.name] ?? 0 }))
                  // After counts arrive, sort by usage so the picker reflects
                  // 'most used' as soon as the data is available.
                  .sort(
                    (a, b) =>
                      b.usage_count - a.usage_count || a.name.localeCompare(b.name)
                  )
              );
            })
            .catch(() => {
              /* usage scan is best-effort — silent fail keeps the list visible */
            });
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setError(friendlyErrorEn(e));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  const openSkill = (path: string) =>
    invoke("open_in_vscode", { path }).catch((e) => setError(friendlyErrorEn(e)));

  const toggleMcp = async (mcp: McpServer) => {
    setTogglingName(mcp.name);
    try {
      await invoke("toggle_mcp_server", {
        name: mcp.name,
        source: mcp.source,
        enabled: !mcp.enabled,
      });
      setRefreshNonce((n) => n + 1);
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setTogglingName(null);
    }
  };

  // Highest-usage skill drives the badge color so the most-used row pops
  // visually without making everything orange.
  const maxUsage = useMemo(
    () => skills.reduce((m, s) => Math.max(m, s.usage_count), 0),
    [skills]
  );

  const installedCount = status?.components.filter((c) => c.installed).length ?? 0;
  const totalCount = status?.components.length ?? 0;

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("claude.title")}</h1>
          <p className="v3-subtitle">{t("claude.subtitle")}</p>
        </div>
        <div className="v3-view-tools">
          <button
            type="button"
            className="v3-link"
            onClick={() => setRefreshNonce((n) => n + 1)}
            disabled={loading}
          >
            <RefreshCw size={12} strokeWidth={2.4} />
            {loading ? ` ${t("claude.refreshing")}` : ` ${t("claude.refresh")}`}
          </button>
        </div>
      </header>

      {error && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      {/* Gentle-AI header card — CLI version pill + sync actions. */}
      <article className="v3-card v3-gai-header-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("claude.gentle_ai_title")}</h2>
          {status?.cli_version ? (
            <span className="v3-row-dim v3-gai-version-row">
              {t("claude.cli_version")} {status.cli_version}
              <button
                type="button"
                className="v3-link v3-gai-release-notes"
                onClick={() =>
                  invoke("open_url", {
                    url: `https://github.com/Gentleman-Programming/gentle-ai/releases/tag/v${status.cli_version}`,
                  }).catch(() => {
                    /* best-effort — silently ignore if the opener fails */
                  })
                }
                title={t("claude.release_notes_hint")}
              >
                <ExternalLink size={11} strokeWidth={2} />
                {t("claude.release_notes")}
              </button>
            </span>
          ) : (
            <span className="v3-row-dim">{t("claude.cli_missing")}</span>
          )}
        </header>
        <p className="v3-subtitle">{t("claude.gentle_ai_subtitle")}</p>
        <div className="v3-gai-sync-actions">
          <button
            type="button"
            className="v3-btn-primary"
            onClick={() => runSync(false)}
            disabled={syncing || !status?.cli_version}
          >
            <Download size={13} strokeWidth={2} />
            {syncing ? t("claude.syncing") : t("claude.sync_all")}
          </button>
          <button
            type="button"
            className="v3-link"
            onClick={() => runSync(true)}
            disabled={syncing || !status?.cli_version}
          >
            {t("claude.sync_all_with_theme")}
          </button>
        </div>
        {syncResult && (
          <div className="v3-success v3-gai-sync-result" role="status" aria-live="polite">
            <CheckCircle2 size={14} strokeWidth={2} />
            {syncResult}
          </div>
        )}
      </article>

      {/* Suggested skills from skills.sh, ranked by the user's stack. */}
      <SkillDiscovery />

      {/* Components grid — 8 cards, one per known gentle-ai component. */}
      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("claude.components_title")}</h2>
          <span className="v3-row-dim">
            {installedCount}/{totalCount}
          </span>
        </header>
        {loading ? (
          <div className="v3-empty">{t("common.loading")}</div>
        ) : !status || status.components.length === 0 ? (
          <div className="v3-empty">{t("claude.cli_missing")}</div>
        ) : (
          <div className="v3-gai-components-grid">
            {status.components.map((c) => (
              <div
                key={c.name}
                className={
                  "v3-gai-component-card" +
                  (c.installed ? " is-installed" : " is-missing")
                }
              >
                <div className="v3-gai-component-head">
                  <span className="v3-gai-component-name">{c.name}</span>
                  <span
                    className={
                      "v3-gai-status-pill " +
                      (c.installed
                        ? "v3-gai-status-pill-ok"
                        : "v3-gai-status-pill-missing")
                    }
                  >
                    {c.installed ? (
                      <CheckCircle2 size={11} strokeWidth={2.4} />
                    ) : (
                      <XCircle size={11} strokeWidth={2.4} />
                    )}
                    {c.installed ? t("claude.installed") : t("claude.missing")}
                  </span>
                </div>
                <p className="v3-gai-component-desc">{c.description}</p>
                {c.installed && (
                  <button
                    type="button"
                    className="v3-gai-component-uninstall"
                    onClick={() => setConfirmingUninstall(c.name)}
                    disabled={uninstallingComponent !== null}
                    title={t("claude.uninstall_hint", { name: c.name })}
                  >
                    {uninstallingComponent === c.name
                      ? t("claude.uninstalling")
                      : t("claude.uninstall")}
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </article>

      {/* Stats strip — clickable tiles deep-link into matching sections.
          Skills + MCPs scroll within this page; Hooks + Plugins are
          informational counts (no in-page anchor yet). */}
      <section className="v3-gai-stats-strip">
        <div className="v3-gai-stat-tile">
          <div className="v3-gai-stat-value">{status?.skills_total ?? 0}</div>
          <div className="v3-gai-stat-label">{t("claude.stat_skills")}</div>
        </div>
        <div className="v3-gai-stat-tile">
          <div className="v3-gai-stat-value">{status?.mcp_servers_total ?? 0}</div>
          <div className="v3-gai-stat-label">{t("claude.stat_mcps")}</div>
        </div>
        <div className="v3-gai-stat-tile">
          <div className="v3-gai-stat-value">{status?.hooks_total ?? 0}</div>
          <div className="v3-gai-stat-label">{t("claude.stat_hooks")}</div>
        </div>
        <div className="v3-gai-stat-tile">
          <div className="v3-gai-stat-value">{status?.plugins_enabled.length ?? 0}</div>
          <div className="v3-gai-stat-label">{t("claude.stat_plugins")}</div>
        </div>
      </section>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("claude.mcp_title")}</h2>
          <span className="v3-row-dim">
            {t("claude.mcp_active", {
              active: mcps.filter((m) => m.enabled).length,
              total: mcps.length,
            })}
          </span>
        </header>
        {loading ? (
          <div className="v3-empty">{t("claude.mcp_loading")}</div>
        ) : mcps.length === 0 ? (
          <div className="v3-empty">{t("claude.mcp_empty")}</div>
        ) : (
          <ul className="v3-list">
            {mcps.map((m) => (
              <li key={`${m.source}:${m.name}`} className="v3-claude-row">
                <div className="v3-claude-row-body">
                  <div className="v3-claude-row-title">
                    <span className="v3-claude-row-name">{m.name}</span>
                    <span
                      className={
                        "v3-pill v3-pill-soft v3-pill-source-" + m.source
                      }
                    >
                      {m.source}
                    </span>
                  </div>
                  <div className="v3-claude-row-meta">
                    {m.command
                      ? `${m.command} ${m.args.join(" ")}`.trim()
                      : t("claude.mcp_bundled")}
                  </div>
                </div>
                <label
                  className="v3-switch"
                  aria-label={t("claude.mcp_toggle", { name: m.name })}
                >
                  <input
                    type="checkbox"
                    checked={m.enabled}
                    disabled={togglingName === m.name}
                    onChange={() => toggleMcp(m)}
                  />
                  <span className="v3-switch-slider" aria-hidden="true" />
                </label>
              </li>
            ))}
          </ul>
        )}
      </article>

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("claude.skills_title")}</h2>
          <span className="v3-row-dim">
            {plural(
              t,
              skills.length,
              "claude.skills_count_one",
              "claude.skills_count_other"
            )}
          </span>
        </header>
        {loading ? (
          <div className="v3-empty">{t("claude.skills_loading")}</div>
        ) : skills.length === 0 ? (
          <div className="v3-empty">{t("claude.skills_empty")}</div>
        ) : (
          <ul className="v3-list">
            {skills.map((s) => (
              <li key={s.name} className="v3-claude-row">
                <div className="v3-claude-row-body">
                  <div className="v3-claude-row-title">
                    <span className="v3-claude-row-name">{s.name}</span>
                    {s.usage_count > 0 && (
                      <span
                        className={
                          "v3-usage-badge " +
                          (s.usage_count === maxUsage
                            ? "v3-usage-badge-top"
                            : "v3-usage-badge-some")
                        }
                        title={t("claude.usage_title", { n: s.usage_count })}
                      >
                        {s.usage_count}
                      </span>
                    )}
                  </div>
                  <div className="v3-claude-row-meta">
                    {s.description || t("claude.no_description")}
                  </div>
                </div>
                <button
                  type="button"
                  className="v3-btn-ghost"
                  onClick={() => openSkill(s.path)}
                >
                  <ExternalLink size={13} strokeWidth={2} />
                  {t("claude.open")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </article>

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

      <ConfirmModal
        open={confirmingUninstall !== null}
        title={t("claude.uninstall_confirm_title")}
        message={t("claude.uninstall_confirm_message", {
          name: confirmingUninstall ?? "",
        })}
        confirmLabel={t("claude.uninstall")}
        cancelLabel={t("common.cancel")}
        danger
        onCancel={() => setConfirmingUninstall(null)}
        onConfirm={() => {
          const name = confirmingUninstall;
          setConfirmingUninstall(null);
          if (name) void runUninstall(name);
        }}
      />
    </div>
  );
}
