import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Trash2, X } from "lucide-react";
import { useT } from "../../../lib/i18n";
import type {
  Column,
  CreateTaskPayload,
  PatchTaskPayload,
  Task,
} from "../../../lib/trello/types";

interface Props {
  // `task` present → edit mode; absent → create mode. This is the OPEN-TIME
  // snapshot — the form initializes from it and the PATCH diffs against it, so
  // fields the user never touches are never sent (and never clobber a
  // concurrent edit).
  task: Task | null;
  // The CURRENT server-truth copy of the same task (from the live board). Used
  // only to detect that the task changed under us while the editor was open.
  liveTask: Task | null;
  // True when a mutation (drag move, complete, …) is already in flight for this
  // task. Saving/deleting is blocked while busy, because patchTask/moveTask
  // silently no-op a second concurrent mutation — without this gate the edit
  // would be dropped AND the editor would close, losing the change.
  busy: boolean;
  columnId: string; // create: target column; edit: ignored (task.column_id wins)
  columns: Column[];
  onClose: () => void;
  onCreate: (columnId: string, title: string, extra: Partial<CreateTaskPayload>) => void;
  onSave: (taskId: string, patch: PatchTaskPayload) => void;
  onDelete: (taskId: string) => void;
}

// Empty string → null for nullable text fields (clears server-side); a real
// value passes through.
function orNull(s: string): string | null {
  const trimmed = s.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function TaskEditor({
  task,
  liveTask,
  busy,
  columnId,
  columns,
  onClose,
  onCreate,
  onSave,
  onDelete,
}: Props) {
  const { t } = useT();
  const editing = task !== null;

  const [title, setTitle] = useState(task?.title ?? "");
  const [details, setDetails] = useState(task?.details ?? "");
  const [flow, setFlow] = useState(task?.flow ?? "");
  const [taskDate, setTaskDate] = useState(task?.task_date ?? "");
  const [progress, setProgress] = useState(task?.progress ?? 0);
  const [targetColumn, setTargetColumn] = useState(task?.column_id ?? columnId);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Set when a save is attempted but the live task changed since open; the
  // user must confirm the overwrite (one click acknowledges).
  const [conflict, setConflict] = useState(false);
  // Backdrop-close guard: only close when a click BOTH started and ended on
  // the overlay itself. Without this, selecting text inside a field and
  // releasing the mouse outside the modal fires a click on the overlay and
  // closes the editor, silently losing the edit.
  const overlayMouseDown = useRef(false);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () => {
    const trimmed = title.trim();
    // `busy` blocks saving (and closing) while another mutation for this task is
    // in flight — otherwise patchTask would silently no-op and we'd lose the edit.
    if (!trimmed || submitting || busy) return;

    // Concurrency guard: if the task changed on the server since we opened the
    // editor, make the user acknowledge before the PATCH overwrites it. The
    // diff still runs against the open-time snapshot, so untouched fields are
    // never sent — this only warns about fields the user is actively changing.
    if (task && liveTask && liveTask.updated_at !== task.updated_at && !conflict) {
      setConflict(true);
      return;
    }

    setSubmitting(true);

    if (!editing) {
      onCreate(columnId, trimmed, {
        details: orNull(details) ?? undefined,
        flow: orNull(flow) ?? undefined,
        task_date: orNull(taskDate) ?? undefined,
        progress,
      });
      onClose();
      return;
    }

    // Edit: send only what changed (PATCH semantics — undefined = don't send).
    const patch: PatchTaskPayload = {};
    if (trimmed !== task.title) patch.title = trimmed;
    if (orNull(details) !== task.details) patch.details = orNull(details);
    if (orNull(flow) !== task.flow) patch.flow = orNull(flow);
    if (orNull(taskDate) !== task.task_date) patch.task_date = orNull(taskDate);
    if (progress !== task.progress) patch.progress = progress;
    if (targetColumn !== task.column_id) patch.column_id = targetColumn;

    if (Object.keys(patch).length > 0) onSave(task.id, patch);
    onClose();
  };

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
        aria-label={editing ? t("trello.edit_task") : t("trello.new_task")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="v3-modal-head">
          <h2>{editing ? t("trello.edit_task") : t("trello.new_task")}</h2>
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
          {conflict && (
            <div className="v3-trello-conflict" role="alert">
              {t("trello.conflict_warning")}
            </div>
          )}
          <label className="v3-field">
            <span className="v3-field-label">{t("trello.field_title")}</span>
            <input
              className="v3-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </label>

          <label className="v3-field">
            <span className="v3-field-label">{t("trello.field_details")}</span>
            <textarea
              className="v3-input v3-textarea"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              rows={3}
            />
          </label>

          <label className="v3-field">
            <span className="v3-field-label">{t("trello.field_flow")}</span>
            <textarea
              className="v3-input v3-textarea"
              value={flow}
              onChange={(e) => setFlow(e.target.value)}
              rows={2}
            />
          </label>

          <div className="v3-field-row">
            <label className="v3-field">
              <span className="v3-field-label">{t("trello.field_date")}</span>
              <input
                type="date"
                className="v3-input"
                value={taskDate}
                onChange={(e) => setTaskDate(e.target.value)}
              />
            </label>

            {editing && (
              <label className="v3-field">
                <span className="v3-field-label">{t("trello.field_column")}</span>
                <select
                  className="v3-select"
                  value={targetColumn}
                  onChange={(e) => setTargetColumn(e.target.value)}
                >
                  {columns.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <label className="v3-field">
            <span className="v3-field-label">
              {t("trello.field_progress")} — {progress}%
            </span>
            <input
              type="range"
              className="v3-range"
              min={0}
              max={100}
              step={5}
              value={progress}
              onChange={(e) => setProgress(Number(e.target.value))}
              style={{ "--v3-range-fill": `${progress}%` } as CSSProperties}
            />
          </label>
        </div>

        <footer className="v3-modal-foot">
          {editing &&
            (confirmDelete ? (
              <button
                type="button"
                className="v3-btn-danger"
                disabled={busy}
                onClick={() => {
                  if (busy) return;
                  onDelete(task.id);
                  onClose();
                }}
              >
                <Trash2 size={13} strokeWidth={2} aria-hidden="true" />{" "}
                {t("trello.confirm_delete")}
              </button>
            ) : (
              <button
                type="button"
                className="v3-btn-ghost-danger"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                <Trash2 size={13} strokeWidth={2} aria-hidden="true" />{" "}
                {t("trello.delete")}
              </button>
            ))}
          {busy && <span className="v3-field-hint">{t("trello.busy_hint")}</span>}
          <div className="v3-modal-foot-right">
            <button type="button" className="v3-btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="v3-btn-primary"
              onClick={save}
              disabled={!title.trim() || submitting || busy}
            >
              {editing
                ? conflict
                  ? t("trello.save_anyway")
                  : t("common.save")
                : t("trello.create")}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
