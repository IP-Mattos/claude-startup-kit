import {
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { Trash2, X } from "lucide-react";
import { useT } from "../../../lib/i18n";
import { MemberAvatar } from "./MemberAvatar";
import type {
  Column,
  CreateTaskPayload,
  Member,
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
  // Project members for the assignee / supervisor pickers.
  members: Member[];
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

// Two-letter initials from a name or email, used as chip fallback.
function chipInitials(name: string | null, email: string | null): string {
  if (name) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    const first = parts[0]?.[0] ?? "";
    const last = parts.length > 1 ? (parts[parts.length - 1]?.[0] ?? "") : "";
    return (first + last).toUpperCase();
  }
  return (email ?? "").slice(0, 2).toUpperCase();
}

// ─── Multi-select people picker ──────────────────────────────────────────────

interface PeoplePickerProps {
  label: string;
  members: Member[];
  selected: string[];
  onChange: (ids: string[]) => void;
  emptyLabel: string;
  allAddedLabel: string;
  addLabel: string;
}

function PeoplePicker({
  label,
  members,
  selected,
  onChange,
  emptyLabel,
  allAddedLabel,
  addLabel,
}: PeoplePickerProps) {
  const [open, setOpen] = useState(false);
  // Highlighted option id for keyboard navigation (roving via
  // aria-activedescendant — the trigger keeps DOM focus, options never do).
  const [activeId, setActiveId] = useState<string | null>(null);
  const dropRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();
  const optionDomId = (memberId: string) => `${listboxId}-opt-${memberId}`;

  // Close dropdown on outside click.
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const available = members.filter((m) => !selected.includes(m.id));

  // When the dropdown opens, highlight the first option so arrow keys and
  // Enter have an anchor. Reset when it closes.
  useEffect(() => {
    if (open) setActiveId(available[0]?.id ?? null);
    else setActiveId(null);
    // available is derived from members/selected; recompute on open toggle only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const remove = (id: string) => onChange(selected.filter((s) => s !== id));
  const add = (id: string) => {
    onChange([...selected, id]);
    setOpen(false);
    // Return focus to the trigger so the user keeps a keyboard anchor.
    triggerRef.current?.focus();
  };

  // Move the highlight by one step, wrapping at both ends.
  const moveActive = (delta: 1 | -1) => {
    if (available.length === 0) return;
    const idx = available.findIndex((m) => m.id === activeId);
    const base = idx === -1 ? (delta === 1 ? -1 : 0) : idx;
    const nextIdx = (base + delta + available.length) % available.length;
    setActiveId(available[nextIdx].id);
  };

  // Keyboard handling lives on the trigger (which holds focus). When the
  // dropdown is OPEN, Escape closes ONLY the dropdown and stops propagation so
  // it never reaches the editor's window-level Escape listener (which would
  // close the whole modal). When closed, keys fall through to default behavior.
  const onTriggerKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (!open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        setOpen(false);
        break;
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        if (activeId) add(activeId);
        break;
      default:
        break;
    }
  };

  const memberById = new Map(members.map((m) => [m.id, m]));

  return (
    <div className="v3-field">
      <span className="v3-field-label">{label}</span>
      <div className="v3-task-editor-people">
        {/* Selected chips */}
        {selected.map((id) => {
          const m = memberById.get(id);
          if (!m) return null;
          const showImg = !!m.avatar_url;
          return (
            <span key={id} className="v3-task-editor-chip">
              {showImg ? (
                <MemberAvatar member={m} size={18} />
              ) : (
                <span className="v3-task-editor-chip-initials" aria-hidden="true">
                  {chipInitials(m.name, m.email)}
                </span>
              )}
              <span className="v3-task-editor-chip-name">{m.name ?? m.email ?? m.id}</span>
              <button
                type="button"
                className="v3-task-editor-chip-remove"
                aria-label={`Remove ${m.name ?? m.email ?? m.id}`}
                onClick={() => remove(id)}
              >
                <X size={10} strokeWidth={2.5} aria-hidden="true" />
              </button>
            </span>
          );
        })}

        {/* Add-person button + dropdown */}
        {members.length === 0 ? (
          <span className="v3-field-hint">{emptyLabel}</span>
        ) : available.length === 0 && selected.length > 0 ? null : (
          <div className="v3-task-editor-picker-wrap" ref={dropRef}>
            <button
              ref={triggerRef}
              type="button"
              className="v3-task-editor-chip v3-task-editor-chip-add"
              onClick={() => setOpen((v) => !v)}
              onKeyDown={onTriggerKeyDown}
              aria-expanded={open}
              aria-haspopup="listbox"
              aria-controls={open ? listboxId : undefined}
              aria-activedescendant={
                open && activeId ? optionDomId(activeId) : undefined
              }
            >
              <span aria-hidden="true">+</span>
              <span>{addLabel}</span>
            </button>
            {open && (
              <ul
                id={listboxId}
                className="v3-task-editor-picker-drop"
                role="listbox"
                aria-label={label}
              >
                {available.length === 0 ? (
                  <li className="v3-task-editor-picker-empty">{allAddedLabel}</li>
                ) : (
                  available.map((m) => {
                    const isActive = m.id === activeId;
                    return (
                      <li
                        key={m.id}
                        id={optionDomId(m.id)}
                        role="option"
                        aria-selected={isActive}
                        className={
                          "v3-task-editor-picker-option" +
                          (isActive ? " is-active" : "")
                        }
                        onMouseDown={(e) => {
                          // Prevent blur on the trigger button before add() fires.
                          e.preventDefault();
                          add(m.id);
                        }}
                        onMouseEnter={() => setActiveId(m.id)}
                      >
                        <MemberAvatar member={m} size={20} />
                        <span className="v3-task-editor-picker-name">
                          {m.name ?? m.email ?? m.id}
                        </span>
                        {m.role === "supervisor" && (
                          <span className="v3-task-editor-picker-role">{m.role}</span>
                        )}
                      </li>
                    );
                  })
                )}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Main editor ─────────────────────────────────────────────────────────────

export function TaskEditor({
  task,
  liveTask,
  busy,
  columnId,
  columns,
  members,
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
  const [assigneeIds, setAssigneeIds] = useState<string[]>(task?.assignee_ids ?? []);
  const [supervisorIds, setSupervisorIds] = useState<string[]>(task?.supervisor_ids ?? []);
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
        assignee_ids: assigneeIds.length > 0 ? assigneeIds : undefined,
        supervisor_ids: supervisorIds.length > 0 ? supervisorIds : undefined,
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

    // People pickers: compare as sorted JSON to avoid order-sensitive diffs.
    const sortedOrig = [...(task.assignee_ids ?? [])].sort().join(",");
    const sortedNew = [...assigneeIds].sort().join(",");
    if (sortedNew !== sortedOrig) patch.assignee_ids = assigneeIds;

    const sortedOrigSup = [...(task.supervisor_ids ?? [])].sort().join(",");
    const sortedNewSup = [...supervisorIds].sort().join(",");
    if (sortedNewSup !== sortedOrigSup) patch.supervisor_ids = supervisorIds;

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

          <PeoplePicker
            label={t("trello.field_assigned")}
            members={members}
            selected={assigneeIds}
            onChange={setAssigneeIds}
            emptyLabel={t("trello.picker_no_members")}
            allAddedLabel={t("trello.picker_all_added")}
            addLabel={t("trello.picker_add_person")}
          />

          <PeoplePicker
            label={t("trello.field_supervisors")}
            members={members}
            selected={supervisorIds}
            onChange={setSupervisorIds}
            emptyLabel={t("trello.picker_no_members")}
            allAddedLabel={t("trello.picker_all_added")}
            addLabel={t("trello.picker_add_person")}
          />
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
