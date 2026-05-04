import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Check, Trash2 } from "lucide-react";
import type { CleanupItem, CleanupResult } from "../../types";
import { formatBytes, formatDate, friendlyErrorEn } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { ConfirmModal } from "../../components/v3/ConfirmModal";

const IS_TAURI =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

export function CleanupView() {
  const { t } = useT();
  const [items, setItems] = useState<CleanupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [confirmingClean, setConfirmingClean] = useState(false);

  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<CleanupItem[]>("cleanup_plan", { olderThanDays: 30 })
      .then((res) => !cancelled && setItems(res))
      .catch((e) => !cancelled && setError(friendlyErrorEn(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [refreshNonce]);

  const grouped = useMemo(() => {
    const map = new Map<string, CleanupItem[]>();
    for (const it of items) {
      const arr = map.get(it.category) ?? [];
      arr.push(it);
      map.set(it.category, arr);
    }
    return Array.from(map.entries());
  }, [items]);

  const totalBytes = useMemo(
    () => items.reduce((s, it) => s + it.bytes, 0),
    [items]
  );

  const runCleanupNow = async () => {
    if (!IS_TAURI || items.length === 0 || running) return;
    setRunning(true);
    setResult(null);
    try {
      const paths = items.map((it) => it.path);
      const res = await invoke<CleanupResult>("cleanup_apply", { paths });
      setResult(res);
      setRefreshNonce((n) => n + 1);
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setRunning(false);
    }
  };
  // Wrapper for the button — opens the confirm modal first instead of
  // wiping files on a single click.
  const runCleanup = () => setConfirmingClean(true);

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("cleanup.title")}</h1>
          <p className="v3-subtitle">
            {loading
              ? t("cleanup.scanning")
              : items.length === 0
              ? t("cleanup.tidy")
              : t(
                  items.length === 1
                    ? "cleanup.summary_one"
                    : "cleanup.summary_other",
                  { n: items.length, bytes: formatBytes(totalBytes) }
                )}
          </p>
        </div>
        <div className="v3-view-tools">
          {items.length > 0 && (
            <button
              className="v3-btn-primary v3-btn-sm"
              onClick={runCleanup}
              disabled={running}
            >
              <Trash2 size={13} strokeWidth={2} />
              {running ? t("cleanup.cleaning") : t("cleanup.clean_all")}
            </button>
          )}
        </div>
      </header>

      {result && (
        <div className="v3-success" role="status" aria-live="polite">
          <Check size={14} strokeWidth={2.4} />
          <span>
            {t(
              result.deleted === 1
                ? "cleanup.deleted_one"
                : "cleanup.deleted_other",
              { n: result.deleted, bytes: formatBytes(result.freed_bytes) }
            )}
            {result.failed > 0 && t("cleanup.failed_suffix", { n: result.failed })}
          </span>
        </div>
      )}

      {error && <div className="v3-error" role="alert" aria-live="assertive">{error}</div>}

      {loading ? (
        <div className="v3-empty">{t("cleanup.scanning_workspace")}</div>
      ) : grouped.length === 0 ? (
        <div className="v3-empty">{t("cleanup.nothing")}</div>
      ) : (
        <div className="v3-list">
          {grouped.map(([category, list]) => {
            const catBytes = list.reduce((s, i) => s + i.bytes, 0);
            return (
              <article key={category} className="v3-card">
                <header className="v3-card-head">
                  <h2 className="v3-card-title">{category}</h2>
                  <span className="v3-row-dim">
                    {t(
                      list.length === 1 ? "cleanup.items_one" : "cleanup.items_other",
                      { n: list.length, bytes: formatBytes(catBytes) }
                    )}
                  </span>
                </header>
                <ul className="v3-cleanup-files">
                  {list.slice(0, 10).map((it) => (
                    <li key={it.path}>
                      <span className="v3-cleanup-path" title={it.path}>
                        {it.path}
                      </span>
                      <span className="v3-cleanup-meta">
                        <span>{formatBytes(it.bytes)}</span>
                        <span className="v3-row-dim">{formatDate(it.mtime)}</span>
                      </span>
                    </li>
                  ))}
                  {list.length > 10 && (
                    <li className="v3-row-dim">
                      {t("cleanup.and_more", { n: list.length - 10 })}
                    </li>
                  )}
                </ul>
              </article>
            );
          })}
        </div>
      )}

      <ConfirmModal
        open={confirmingClean}
        title={t("cleanup.confirm_title")}
        message={t("cleanup.confirm_message", {
          n: items.length,
          bytes: formatBytes(totalBytes),
        })}
        confirmLabel={t("cleanup.clean_all")}
        cancelLabel={t("common.cancel")}
        danger
        onConfirm={() => {
          setConfirmingClean(false);
          void runCleanupNow();
        }}
        onCancel={() => setConfirmingClean(false)}
      />
    </div>
  );
}
