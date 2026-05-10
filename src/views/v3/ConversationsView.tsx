import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, Search } from "lucide-react";
import type { Project } from "../../types";
import { agoLabel, friendlyErrorEn, projectName } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useDebouncedValue } from "../../hooks/useDebouncedValue";
import { IS_TAURI } from "../../lib/env";

// Backend payload shape returned by the Rust `search_conversations`
// command. Keep this in sync with the Rust `ConversationMatch` struct.
interface ConversationMatch {
  project_path: string;
  project_name: string;
  session_id: string;
  file_path: string;
  timestamp: string; // ISO8601
  role: string; // "user" | "assistant" (occasionally other roles)
  snippet: string;
  git_branch: string | null;
}

const LS_PROJECT = "csk-conv-project";
const DEBOUNCE_MS = 300;
const RESULT_LIMIT = 100;

// Convert the ISO8601 timestamp to a relative "X ago" label. Falls back to
// the raw string if parsing fails.
function isoToMs(iso: string): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

// Render the snippet with the matched query wrapped in <mark>. Matching is
// case-insensitive but preserves the original casing of `text`. We split
// on the first match only to keep this allocation-light.
function HighlightedSnippet({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: Array<{ kind: "text" | "mark"; value: string }> = [];
  let cursor = 0;
  while (cursor < text.length) {
    const idx = lower.indexOf(q, cursor);
    if (idx === -1) {
      parts.push({ kind: "text", value: text.slice(cursor) });
      break;
    }
    if (idx > cursor) {
      parts.push({ kind: "text", value: text.slice(cursor, idx) });
    }
    parts.push({ kind: "mark", value: text.slice(idx, idx + query.length) });
    cursor = idx + query.length;
  }
  return (
    <>
      {parts.map((p, i) =>
        p.kind === "mark" ? <mark key={i}>{p.value}</mark> : <span key={i}>{p.value}</span>
      )}
    </>
  );
}

export function ConversationsView() {
  const { t } = useT();

  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, DEBOUNCE_MS);

  const [selectedProject, setSelectedProject] = useState<string | null>(() => {
    try {
      const v = localStorage.getItem(LS_PROJECT);
      return v && v.length > 0 ? v : null;
    } catch {
      return null;
    }
  });

  const [projects, setProjects] = useState<Project[]>([]);
  const [matches, setMatches] = useState<ConversationMatch[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Persist project filter.
  useEffect(() => {
    try {
      if (selectedProject) localStorage.setItem(LS_PROJECT, selectedProject);
      else localStorage.removeItem(LS_PROJECT);
    } catch {
      /* storage full / locked — ignore */
    }
  }, [selectedProject]);

  // Project list. 180d window so older conversations have a matching
  // dropdown entry — the JSONLs themselves still get searched regardless
  // of the picker; this only seeds the filter UI.
  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    invoke<Project[]>("scan_projects", { windowDays: 180 })
      .then((res) => !cancelled && setProjects(res))
      .catch(() => {
        /* silent — picker just stays empty, error surfaces from search */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Run the search whenever debounced query or project filter change.
  useEffect(() => {
    if (!IS_TAURI) return;
    const trimmed = debouncedQuery.trim();
    if (trimmed.length === 0) {
      setMatches([]);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<ConversationMatch[]>("search_conversations", {
      query: trimmed,
      project: selectedProject ?? undefined,
      limit: RESULT_LIMIT,
    })
      .then((res) => {
        if (!cancelled) setMatches(res);
      })
      .catch((e) => {
        if (!cancelled) {
          setMatches([]);
          setError(friendlyErrorEn(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [debouncedQuery, selectedProject]);

  const openConversation = (filePath: string) => {
    if (!IS_TAURI) return;
    invoke("open_in_vscode", { path: filePath }).catch((e) =>
      setError(friendlyErrorEn(e))
    );
  };

  const trimmedQuery = debouncedQuery.trim();
  // Live query (not debounced) decides whether to show "type to search" so
  // the empty state disappears the moment the user starts typing — the
  // results pane shows the spinner during the debounce window instead of
  // bouncing back to the placeholder.
  const liveQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;
  const hasLiveQuery = liveQuery.length > 0;
  const showSpinner = loading || (hasLiveQuery && !hasQuery);
  const scannedProjectCount = useMemo(() => projects.length, [projects]);

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("conversations.title")}</h1>
          <p className="v3-subtitle">{t("conversations.subtitle")}</p>
        </div>
      </header>

      {error && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      <article className="v3-card">
        <div className="v3-conv-search">
          <label className="v3-search v3-conv-input">
            <Search size={14} strokeWidth={2} aria-hidden="true" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("conversations.search_placeholder")}
              aria-label={t("conversations.search_placeholder")}
              autoFocus
            />
          </label>
          <select
            className="v3-select"
            value={selectedProject ?? ""}
            onChange={(e) => setSelectedProject(e.target.value || null)}
            aria-label={t("todos.project_picker_label")}
          >
            <option value="">{t("conversations.all_projects")}</option>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>
                {projectName(p.path)}
              </option>
            ))}
          </select>
        </div>
      </article>

      {showSpinner ? (
        <div className="v3-empty">
          <RefreshCw
            size={14}
            strokeWidth={2}
            className="v3-spin"
            aria-hidden="true"
          />{" "}
          {t("conversations.searching")}
        </div>
      ) : !hasQuery ? (
        <div className="v3-empty">{t("conversations.no_query")}</div>
      ) : matches.length === 0 ? (
        <div className="v3-empty">
          {t("conversations.no_matches", { n: scannedProjectCount })}
        </div>
      ) : (
        <ul className="v3-list v3-conv-results">
          {matches.map((m) => {
            const ms = isoToMs(m.timestamp);
            const ago = ms !== null ? agoLabel(ms, t) : m.timestamp;
            const roleLabel =
              m.role === "user"
                ? t("conversations.role_user")
                : t("conversations.role_assistant");
            return (
              <li
                key={`${m.file_path}-${m.timestamp}-${m.snippet.slice(0, 8)}`}
                className="v3-row v3-conv-row"
                role="button"
                tabIndex={0}
                onClick={() => openConversation(m.file_path)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openConversation(m.file_path);
                  }
                }}
                title={t("conversations.open_in_vscode")}
                aria-label={t("conversations.open_in_vscode")}
              >
                <div className="v3-row-body">
                  <div className="v3-conv-meta">
                    <span
                      className="v3-conv-project"
                      title={m.project_path}
                    >
                      {m.project_name}
                    </span>
                    <span
                      className={
                        "v3-conv-role" +
                        (m.role === "user" ? " v3-conv-role-user" : " v3-conv-role-ai")
                      }
                    >
                      {roleLabel}
                    </span>
                    <span className="v3-conv-ago">{ago}</span>
                    {m.git_branch && (
                      <span className="v3-conv-branch" title={m.git_branch}>
                        {m.git_branch}
                      </span>
                    )}
                  </div>
                  <p className="v3-conv-snippet">
                    <HighlightedSnippet text={m.snippet} query={trimmedQuery} />
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
