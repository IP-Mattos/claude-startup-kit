import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ExternalLink, RefreshCw } from "lucide-react";
import { friendlyErrorEn } from "../../lib/format";
import { plural, useT } from "../../lib/i18n";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

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

export function ClaudeView() {
  const { t } = useT();
  const [skills, setSkills] = useState<ClaudeSkill[]>([]);
  const [mcps, setMcps] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Per-row pending state so toggling one MCP doesn't disable every switch.
  const [togglingName, setTogglingName] = useState<string | null>(null);

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    // Two-stage fetch: list_claude_skills returns the catalog instantly
    // (no JSONL scan), then count_claude_skill_usage enriches counts in
    // the background. Same pattern used elsewhere for project enrichment.
    Promise.all([
      invoke<ClaudeSkill[]>("list_claude_skills").catch(() => [] as ClaudeSkill[]),
      invoke<McpServer[]>("list_mcp_servers").catch(() => [] as McpServer[]),
    ])
      .then(([s, m]) => {
        if (cancelled) return;
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
    </div>
  );
}
