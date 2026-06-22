import { useEffect, useRef, useState } from "react";
import { Upload, X } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { toTrelloError } from "../../../lib/trello/client";
import {
  IMPORT_EMPTY,
  importTasksFromFile,
  type ImportOutcome,
} from "../../../lib/trello/importTasks";

interface Props {
  projectId: string;
  projectName: string | null;
  // Fired once after a successful import so the board can refetch.
  onImported: () => void;
  onClose: () => void;
}

// Pick a JSON file and import its tasks into the active project. The import is
// lossy (title/details/flow/date only) and NOT idempotent (re-importing the
// same file duplicates tasks) — both warned up front. On success the body is
// replaced with a server-authoritative result summary.
export function TaskImportModal({
  projectId,
  projectName,
  onImported,
  onClose,
}: Props) {
  const { t } = useT();
  const [importing, setImporting] = useState(false);
  // Synchronous double-fire guard. `importing` is render-closure state, so two
  // clicks in the same frame both read its stale `false`; this ref flips
  // immediately at the top of the handler so a second click is a hard no-op.
  const busy = useRef(false);
  // The structured result once the import succeeds — swaps the body for a
  // summary. Null while we're still on the "choose a file" screen.
  const [result, setResult] = useState<ImportOutcome | null>(null);
  // Friendly, already-localized-or-readable message on failure. We keep the
  // modal open so the user can retry or pick a different file.
  const [error, setError] = useState<string | null>(null);

  // Same backdrop-close guard as the export modal / task editor: only close
  // when a click both starts and ends on the overlay.
  const overlayMouseDown = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const choose = async () => {
    // Ref guard first (synchronous) so two same-frame clicks can't both pass;
    // the `importing` state below only drives the disabled/label UI.
    if (busy.current) return;
    busy.current = true;
    setError(null);
    setImporting(true);
    try {
      const res = await importTasksFromFile(projectId, projectName);
      // Null → the user cancelled the native file dialog; stay on this screen.
      if (res) {
        setResult(res);
        onImported();
      }
    } catch (err) {
      console.error("task import failed", err);
      // Our own transform errors are thrown as Error with a friendly message;
      // the "nothing to import" case carries an i18n key as its message;
      // backend rejections arrive as the structured TrelloError JSON string.
      let message: string;
      if (err instanceof Error) {
        message =
          err.message === IMPORT_EMPTY ? t("trello.import_empty") : err.message;
      } else {
        message = toTrelloError(err).message || t("trello.import_failed");
      }
      setError(message);
    } finally {
      busy.current = false;
      setImporting(false);
    }
  };

  const projectLabel = projectName ?? t("trello.project");

  return (
    <div
      className="v3-modal-overlay"
      role="presentation"
      onMouseDown={(e) => {
        overlayMouseDown.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        if (overlayMouseDown.current && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="v3-modal v3-task-editor"
        role="dialog"
        aria-modal="true"
        aria-label={t("trello.import_title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="v3-modal-head">
          <h2>{t("trello.import_title")}</h2>
          <button
            type="button"
            className="v3-modal-close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            <X size={16} strokeWidth={2} aria-hidden="true" />
          </button>
        </header>

        <div className="v3-modal-body">
          {result ? (
            <div className="v3-import-result">
              <h3 className="v3-import-result-title">
                {t("trello.import_result_title")}
              </h3>
              <dl className="v3-import-stats">
                <div className="v3-import-stat">
                  <dt>{t("trello.import_imported")}</dt>
                  <dd>{result.imported}</dd>
                </div>
                <div className="v3-import-stat">
                  <dt>{t("trello.import_skipped_no_column")}</dt>
                  <dd>{result.skipped_no_column}</dd>
                </div>
                <div className="v3-import-stat">
                  <dt>{t("trello.import_skipped_invalid")}</dt>
                  <dd>{result.skipped_invalid}</dd>
                </div>
                <div className="v3-import-stat">
                  <dt>{t("trello.import_total")}</dt>
                  <dd>{result.total_in_file}</dd>
                </div>
              </dl>

              {/* Tasks dropped client-side before the request (no column or
                  title). 0 for clean CSK exports, so only shown when present. */}
              {result.skipped_local > 0 && (
                <p className="v3-import-warn">
                  {t("trello.import_skipped_local", {
                    count: result.skipped_local,
                  })}
                </p>
              )}

              {result.by_column.length > 0 && (
                <div className="v3-import-section">
                  <div className="v3-import-section-name">
                    {t("trello.import_by_column")}
                  </div>
                  {result.by_column.map((col) => (
                    <div key={col.name} className="v3-import-col-row">
                      <span className="v3-import-col-name">{col.name}</span>
                      <span className="v3-import-col-tally">
                        {t("trello.import_col_tally", {
                          imported: col.imported,
                          skipped: col.skipped,
                        })}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {result.unmatched_columns.length > 0 && (
                <div className="v3-import-section">
                  <div className="v3-import-section-name">
                    {t("trello.import_unmatched")}
                  </div>
                  <p className="v3-import-unmatched">
                    {result.unmatched_columns.join(", ")}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="v3-import-intro">
              <p>{t("trello.import_intro", { project: projectLabel })}</p>
              <p className="v3-import-warn">{t("trello.import_warn_lossy")}</p>
              <p className="v3-import-warn">{t("trello.import_warn_duplicate")}</p>
            </div>
          )}
        </div>

        <footer className="v3-modal-foot">
          {error && (
            <p className="v3-form-error" role="alert" aria-live="polite">
              {error}
            </p>
          )}
          <div className="v3-modal-foot-right">
            <button type="button" className="v3-btn-ghost" onClick={onClose}>
              {result ? t("common.close") : t("common.cancel")}
            </button>
            {!result && (
              <button
                type="button"
                className="v3-btn-primary"
                onClick={choose}
                disabled={importing}
              >
                <Upload size={13} strokeWidth={2} aria-hidden="true" />
                {importing ? t("trello.import_importing") : t("trello.import_choose")}
              </button>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
}
