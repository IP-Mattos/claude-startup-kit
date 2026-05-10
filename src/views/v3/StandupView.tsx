import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { ClipboardCopy, RefreshCw } from "lucide-react";
import { friendlyErrorEn } from "../../lib/format";
import { useT, type StringKey, type Lang } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";

// Mirrors `StandupReport` / `StandupCommit` / `StandupTodo` in
// src-tauri/src/lib.rs. Keep these in sync — a backend rename should
// surface as a TS error here, not silent drift.
interface StandupCommit {
  project_path: string;
  project_name: string;
  sha: string;
  subject: string;
  branch: string | null;
  timestamp: string;
}

interface StandupTodo {
  project_path: string;
  project_name: string;
  text: string;
  completed_at: string;
}

interface StandupReport {
  generated_at: string;
  window_hours: number;
  commits: StandupCommit[];
  completed_todos: StandupTodo[];
  open_todos: StandupTodo[];
  engram_summary_lines: string[];
  projects_touched: string[];
}

const LS_WINDOW = "csk-standup-window";
const WINDOW_OPTIONS = [24, 48, 168] as const;
type WindowOption = (typeof WINDOW_OPTIONS)[number];
const DEFAULT_WINDOW: WindowOption = 24;

// `t` typed strictly so child helpers share the same StringKey constraint.
type T = (k: StringKey, vars?: Record<string, string | number>) => string;

function readWindow(): WindowOption {
  try {
    const raw = localStorage.getItem(LS_WINDOW);
    const n = parseInt(raw ?? "", 10);
    if ((WINDOW_OPTIONS as readonly number[]).includes(n)) {
      return n as WindowOption;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_WINDOW;
}

function windowLabel(t: T, w: WindowOption): string {
  if (w === 24) return t("standup.window_24h");
  if (w === 48) return t("standup.window_48h");
  return t("standup.window_1w");
}

// Truncate a single line to ~80 chars with an ellipsis. Standup output is
// meant to be glanceable; long todo titles otherwise blow up the column.
function truncate(s: string, max = 80): string {
  const trimmed = s.trim().replace(/\s+/g, " ");
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max - 1) + "…";
}

// Format the time portion of an ISO timestamp as `HH:MM` in local time.
function formatLocalTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

function formatLocalDate(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Pad project-name brackets so commit / todo columns line up. We measure
// the widest project_name in the report and pad each `[name]` to that
// length. Looks tidy in a monospace font without doing column math.
function nameColWidth(report: StandupReport): number {
  const names = new Set<string>();
  for (const c of report.commits) names.add(c.project_name);
  for (const t of report.completed_todos) names.add(t.project_name);
  for (const t of report.open_todos) names.add(t.project_name);
  let max = 0;
  for (const n of names) if (n.length > max) max = n.length;
  // bracket overhead `[]` = 2 chars; cap total at a sane width.
  return Math.min(20, Math.max(4, max));
}

function padName(name: string, width: number): string {
  const inner = name.length > width ? name.slice(0, width - 1) + "…" : name;
  const bracket = `[${inner}]`;
  return bracket.padEnd(width + 2, " ");
}

/**
 * Produce the copy-pasteable standup text. Pure function of (report, t, lang)
 * — memoized in the view via useMemo.
 */
function formatStandupText(report: StandupReport, t: T, lang: Lang): string {
  const lines: string[] = [];
  const dateStr = formatLocalDate(report.generated_at);
  const timeStr = formatLocalTime(report.generated_at);
  const header =
    lang === "es"
      ? `STANDUP DIARIO · ${dateStr}`
      : `DAILY STANDUP · ${dateStr}`;
  const generatedLabel = lang === "es" ? "generado" : "generated";
  const lastLabel =
    lang === "es"
      ? `últimas ${report.window_hours}h`
      : `last ${report.window_hours}h`;
  lines.push(header);
  lines.push(`${generatedLabel} ${timeStr} · ${lastLabel}`);
  lines.push("");

  const nameW = nameColWidth(report);

  // DONE YESTERDAY ----------------------------------------------------
  lines.push(`▌ ${t("standup.section_done")}`);
  if (report.commits.length === 0 && report.completed_todos.length === 0) {
    lines.push(`  · ${t("standup.no_commits")} · ${t("standup.no_todos")}`);
  } else {
    for (const c of report.commits) {
      lines.push(
        `  · ${padName(c.project_name, nameW)}${c.sha} · ${truncate(c.subject)}`,
      );
    }
    for (const td of report.completed_todos) {
      const tag = lang === "es" ? "[hecho]  " : "[done]   ";
      lines.push(
        `  · ${tag}${padName(td.project_name, nameW)}${truncate(td.text)}`,
      );
    }
  }
  lines.push("");

  // TODAY ------------------------------------------------------------
  lines.push(
    `▌ ${t("standup.section_today", { n: report.open_todos.length })}`,
  );
  if (report.open_todos.length === 0) {
    lines.push(`  · ${t("standup.no_todos")}`);
  } else {
    for (const td of report.open_todos) {
      lines.push(`  · ${padName(td.project_name, nameW)}${truncate(td.text)}`);
    }
  }
  lines.push("");

  // BLOCKERS ---------------------------------------------------------
  // We don't have a structured blockers source yet — surface "none" so
  // the user can hand-edit before pasting. Honest > pretending.
  lines.push(`▌ ${t("standup.section_blockers")}`);
  lines.push(`  ${t("standup.blockers_none")}`);
  lines.push("");

  // MEMORY -----------------------------------------------------------
  lines.push(
    `▌ ${t("standup.section_memory", { n: report.window_hours })}`,
  );
  if (report.engram_summary_lines.length === 0) {
    lines.push(`  ${t("standup.engram_unavailable")}`);
  } else {
    for (const ln of report.engram_summary_lines) {
      lines.push(`  ${truncate(ln, 110)}`);
    }
  }

  return lines.join("\n");
}

interface BreakdownProps {
  report: StandupReport;
  t: T;
}
function PerProjectBreakdown({ report, t }: BreakdownProps) {
  // Group commits + completed todos by project_path.
  const groups = useMemo(() => {
    const map = new Map<
      string,
      { name: string; commits: StandupCommit[]; todos: StandupTodo[] }
    >();
    for (const p of report.projects_touched) {
      const name =
        report.commits.find((c) => c.project_path === p)?.project_name ??
        report.completed_todos.find((t) => t.project_path === p)?.project_name ??
        report.open_todos.find((t) => t.project_path === p)?.project_name ??
        p;
      map.set(p, { name, commits: [], todos: [] });
    }
    for (const c of report.commits) {
      const g = map.get(c.project_path);
      if (g) g.commits.push(c);
    }
    for (const td of report.completed_todos) {
      const g = map.get(td.project_path);
      if (g) g.todos.push(td);
    }
    return Array.from(map.entries()).map(([path, g]) => ({ path, ...g }));
  }, [report]);

  if (groups.length === 0) return null;
  return (
    <article className="v3-card">
      <header className="v3-card-head">
        <h2 className="v3-card-title">{t("standup.breakdown_title")}</h2>
      </header>
      <div className="v3-standup-breakdown">
        {groups.map((g) => (
          <div key={g.path} className="v3-standup-breakdown-group">
            <div className="v3-standup-breakdown-name">[{g.name}]</div>
            {g.commits.length === 0 && g.todos.length === 0 ? (
              <div className="v3-standup-breakdown-row v3-standup-breakdown-empty">
                {t("standup.no_commits")}
              </div>
            ) : (
              <>
                {g.commits.map((c) => (
                  <div
                    key={`c-${c.sha}-${c.timestamp}`}
                    className="v3-standup-breakdown-row"
                  >
                    <span className="v3-standup-breakdown-sha">{c.sha}</span>
                    <span className="v3-standup-breakdown-subject">
                      {truncate(c.subject, 110)}
                    </span>
                  </div>
                ))}
                {g.todos.map((td) => (
                  <div
                    key={`t-${td.project_path}-${td.completed_at}-${td.text}`}
                    className="v3-standup-breakdown-row"
                  >
                    <span className="v3-standup-breakdown-sha">todo</span>
                    <span className="v3-standup-breakdown-subject">
                      {truncate(td.text, 110)}
                    </span>
                  </div>
                ))}
              </>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}

export function StandupView() {
  const { t, lang } = useT();
  const [windowHours, setWindowHours] = useState<WindowOption>(() =>
    readWindow(),
  );
  const [report, setReport] = useState<StandupReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [copied, setCopied] = useState(false);

  // Persist window choice.
  useEffect(() => {
    try {
      localStorage.setItem(LS_WINDOW, String(windowHours));
    } catch {
      /* storage full / locked — ignore */
    }
  }, [windowHours]);

  // Reset the "Copied!" flash after 1.5s. Auto-clears even if the user
  // mashes copy repeatedly because the timer is re-created each click.
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);

  // Fetch the standup whenever window or refresh nonce changes.
  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<StandupReport>("daily_standup", { windowHours })
      .then((res) => {
        if (!cancelled) setReport(res);
      })
      .catch((e) => {
        if (!cancelled) {
          setReport(null);
          setError(friendlyErrorEn(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [windowHours, refreshNonce]);

  const text = useMemo(
    () => (report ? formatStandupText(report, t, lang) : ""),
    [report, t, lang],
  );

  const isEmpty =
    !!report &&
    report.commits.length === 0 &&
    report.completed_todos.length === 0 &&
    report.open_todos.length === 0 &&
    report.engram_summary_lines.length === 0;

  const refetch = () => setRefreshNonce((n) => n + 1);

  const handleCopy = async () => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard API can refuse in some sandbox contexts. Silent failure
      // beats a confusing error dialog — the user can still select the
      // <pre> manually.
    }
  };

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("standup.title")}</h1>
          <p className="v3-subtitle">{t("standup.subtitle")}</p>
        </div>
        <div className="v3-view-tools v3-standup-actions">
          <label className="v3-tokens-window">
            <span className="v3-tokens-window-label">
              {t("standup.window_label")}
            </span>
            <select
              className="v3-select"
              value={windowHours}
              onChange={(e) =>
                setWindowHours(Number(e.target.value) as WindowOption)
              }
              aria-label={t("standup.window_label")}
            >
              {WINDOW_OPTIONS.map((w) => (
                <option key={w} value={w}>
                  {windowLabel(t, w)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="v3-link"
            onClick={refetch}
            disabled={loading}
          >
            <RefreshCw size={12} strokeWidth={2.4} />
            {loading
              ? ` ${t("standup.regenerating")}`
              : ` ${t("standup.regenerate")}`}
          </button>
          <button
            type="button"
            className="v3-link"
            onClick={handleCopy}
            disabled={!report || loading}
          >
            <ClipboardCopy size={12} strokeWidth={2.4} />
            {` ${t("standup.copy")}`}
          </button>
          <span
            className={
              "v3-standup-copied-flash" + (copied ? " is-visible" : "")
            }
            aria-live="polite"
          >
            {t("standup.copied")}
          </span>
        </div>
      </header>

      {error && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      {loading && !report ? (
        <div className="v3-empty">
          <RefreshCw
            size={14}
            strokeWidth={2}
            className="v3-spin"
            aria-hidden="true"
          />{" "}
          {t("common.loading")}
        </div>
      ) : isEmpty ? (
        <div className="v3-empty">
          {t("standup.empty_no_activity", { n: windowHours })}
        </div>
      ) : report ? (
        <>
          <article className="v3-card">
            <pre className="v3-standup-text">{text}</pre>
          </article>
          <PerProjectBreakdown report={report} t={t} />
        </>
      ) : null}
    </div>
  );
}
