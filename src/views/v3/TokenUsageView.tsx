import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import { friendlyErrorEn } from "../../lib/format";
import { useT, type StringKey } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";
import { Sparkline } from "../../components/v3/Sparkline";

// Mirrors the Rust `TokenStats` / `DayUsage` structs in src-tauri/src/lib.rs.
// Keep these in sync — a backend field rename should land as one TS error
// here rather than silently drift.
interface DayUsage {
  date: string; // YYYY-MM-DD
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  total: number;
  sessions: number;
}

interface TokenStats {
  by_day: DayUsage[];
  range_start: string;
  range_end: string;
  window_days: number;
  total_input: number;
  total_output: number;
  total_cache_read: number;
  total_cache_creation: number;
  total_all: number;
  sessions: number;
  files_scanned: number;
  lines_with_usage: number;
}

const LS_WINDOW = "csk-tokens-window";
const WINDOW_OPTIONS = [7, 30, 90, 180, 365] as const;
const DEFAULT_WINDOW = 30;

// Thin-space group separator: splits the number into 3-digit chunks from
// the right and joins them with U+2009. Tabular-nums + this separator gives
// us "12 345 678" instead of the locale-sensitive comma/period dance.
function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "0";
  const s = Math.trunc(n).toString();
  const out: string[] = [];
  let i = s.length;
  while (i > 0) {
    const start = Math.max(0, i - 3);
    out.unshift(s.slice(start, i));
    i = start;
  }
  return out.join(" ");
}

// Format a percent for the breakdown rows. Drops trailing ".0" so 50% reads
// as "50" not "50.0". One decimal for sub-10% slices so cache-creation never
// rounds to a flat 0% when it's actually present.
function formatPct(part: number, total: number): string {
  if (total <= 0) return "0%";
  const pct = (part / total) * 100;
  if (pct >= 10) return `${Math.round(pct)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  if (pct > 0) return "<1%";
  return "0%";
}

function readWindow(): number {
  try {
    const raw = localStorage.getItem(LS_WINDOW);
    const n = parseInt(raw ?? "", 10);
    if (Number.isFinite(n) && (WINDOW_OPTIONS as readonly number[]).includes(n)) {
      return n;
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_WINDOW;
}

// `t` is typed strictly so sub-components can share it without losing the
// StringKey constraint. Exported as the matching type used by the parent.
type T = (k: StringKey, vars?: Record<string, string | number>) => string;

interface BreakdownRowProps {
  label: string;
  value: number;
  total: number;
}
function BreakdownRow({ label, value, total }: BreakdownRowProps) {
  return (
    <div className="v3-tokens-breakdown-row">
      <span className="v3-tokens-breakdown-label">{label}</span>
      <span className="v3-tokens-breakdown-value">
        <span className="num">{formatTokens(value)}</span>
        <span className="pct"> ({formatPct(value, total)})</span>
      </span>
    </div>
  );
}

interface RecentTableProps {
  rows: DayUsage[];
  t: T;
}
function RecentTable({ rows, t }: RecentTableProps) {
  if (rows.length === 0) return null;
  return (
    <table className="v3-tokens-recent-table">
      <thead>
        <tr>
          <th>{t("tokens.col_date")}</th>
          <th>{t("tokens.col_total")}</th>
          <th>{t("tokens.col_sessions")}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((d) => (
          <tr key={d.date}>
            <td className="v3-tokens-recent-date">{d.date}</td>
            <td className="v3-tokens-recent-num">{formatTokens(d.total)}</td>
            <td className="v3-tokens-recent-num">{d.sessions}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TokenUsageView() {
  const { t } = useT();
  const [windowDays, setWindowDays] = useState<number>(() => readWindow());
  const [stats, setStats] = useState<TokenStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Persist window choice.
  useEffect(() => {
    try {
      localStorage.setItem(LS_WINDOW, String(windowDays));
    } catch {
      /* storage full / locked — ignore */
    }
  }, [windowDays]);

  // Fetch stats whenever window or refresh changes.
  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<TokenStats>("token_usage", { windowDays })
      .then((res) => {
        if (!cancelled) setStats(res);
      })
      .catch((e) => {
        if (!cancelled) {
          setStats(null);
          setError(friendlyErrorEn(e));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [windowDays, refreshNonce]);

  const refetch = () => setRefreshNonce((n) => n + 1);

  const sparkData = useMemo(
    () => (stats ? stats.by_day.map((d) => d.total) : []),
    [stats]
  );
  // 7-day recent rows in reverse-chronological order so the most recent
  // day reads first — matches the "newest first" reading pattern in the
  // rest of the app.
  const recentRows = useMemo(() => {
    if (!stats) return [];
    return stats.by_day.slice(-7).slice().reverse();
  }, [stats]);

  const isEmpty = !!stats && stats.total_all === 0 && stats.lines_with_usage === 0;
  const hasStats = !!stats && !isEmpty;

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("tokens.title")}</h1>
          <p className="v3-subtitle">{t("tokens.subtitle")}</p>
        </div>
        <div className="v3-view-tools">
          <label className="v3-tokens-window">
            <span className="v3-tokens-window-label">
              {t("tokens.window_label")}
            </span>
            <select
              className="v3-select"
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.target.value))}
              aria-label={t("tokens.window_label")}
            >
              {WINDOW_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {d}d
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
            {loading ? ` ${t("tokens.refreshing")}` : ` ${t("tokens.refresh")}`}
          </button>
        </div>
      </header>

      {error && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      {loading && !stats ? (
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
        <div className="v3-empty">{t("tokens.empty")}</div>
      ) : hasStats ? (
        <>
          {/* Total KPI ----------------------------------------------- */}
          <article className="v3-card">
            <div className="v3-tokens-kpi">
              <div className="v3-tokens-kpi-num">
                {formatTokens(stats.total_all)}
              </div>
              <div className="v3-tokens-kpi-sub">
                {t("tokens.total_label", { n: stats.window_days })}
              </div>
              <div className="v3-tokens-kpi-meta">
                {t("tokens.sessions_count", { n: stats.sessions })}
                {" · "}
                {t("tokens.files_count", { n: stats.files_scanned })}
              </div>
            </div>
          </article>

          {/* Sparkline ----------------------------------------------- */}
          <article className="v3-card">
            <header className="v3-card-head">
              <h2 className="v3-card-title">{t("tokens.title")}</h2>
            </header>
            <div className="v3-tokens-sparkline-wrap">
              <Sparkline
                data={sparkData}
                width={640}
                height={64}
                label={t("tokens.sparkline_caption", {
                  from: stats.range_start,
                  to: stats.range_end,
                })}
              />
            </div>
            <div className="v3-tokens-sparkline-caption">
              {t("tokens.sparkline_caption", {
                from: stats.range_start,
                to: stats.range_end,
              })}
            </div>
          </article>

          {/* Breakdown ----------------------------------------------- */}
          <article className="v3-card">
            <header className="v3-card-head">
              <h2 className="v3-card-title">{t("tokens.breakdown_title")}</h2>
            </header>
            <div className="v3-tokens-breakdown">
              <BreakdownRow
                label={t("tokens.label_input")}
                value={stats.total_input}
                total={stats.total_all}
              />
              <BreakdownRow
                label={t("tokens.label_output")}
                value={stats.total_output}
                total={stats.total_all}
              />
              <BreakdownRow
                label={t("tokens.label_cache_read")}
                value={stats.total_cache_read}
                total={stats.total_all}
              />
              <BreakdownRow
                label={t("tokens.label_cache_new")}
                value={stats.total_cache_creation}
                total={stats.total_all}
              />
            </div>
          </article>

          {/* Last 7 days --------------------------------------------- */}
          <article className="v3-card">
            <header className="v3-card-head">
              <h2 className="v3-card-title">{t("tokens.recent_title")}</h2>
            </header>
            <RecentTable rows={recentRows} t={t} />
          </article>
        </>
      ) : null}
    </div>
  );
}
