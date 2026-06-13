import type { DragEvent } from "react";
import { Calendar, Check, MessageSquare, Users } from "lucide-react";
import { useT } from "../../../lib/i18n";
import type { Task } from "../../../lib/trello/types";

interface Props {
  task: Task;
  dragging: boolean;
  busy: boolean; // a mutation (complete) is in flight for this task
  onOpen: (task: Task) => void;
  onComplete: (task: Task) => void;
  onDragStart: (task: Task, e: DragEvent) => void;
  onDragEnd: () => void;
}

export function TaskCard({
  task,
  dragging,
  busy,
  onOpen,
  onComplete,
  onDragStart,
  onDragEnd,
}: Props) {
  const { t } = useT();
  const done = task.completed_at !== null;
  const progress = Math.max(0, Math.min(100, task.progress));
  const isTemp = task.id.startsWith("temp-");

  return (
    <article
      className={
        "v3-task-card" +
        (dragging ? " is-dragging" : "") +
        (done ? " is-done" : "") +
        (isTemp ? " is-pending" : "")
      }
      draggable={!isTemp}
      onDragStart={(e) => onDragStart(task, e)}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(task)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onOpen(task);
        }
      }}
      aria-label={task.title}
    >
      <div className="v3-task-card-top">
        <p className="v3-task-title">{task.title}</p>
        {!done && (
          <button
            type="button"
            className="v3-task-complete"
            title={t("trello.complete")}
            aria-label={t("trello.complete")}
            disabled={busy}
            onClick={(e) => {
              e.stopPropagation();
              onComplete(task);
            }}
          >
            <Check size={13} strokeWidth={2.5} aria-hidden="true" />
          </button>
        )}
      </div>

      {(progress > 0 || !done) && (
        <div className="v3-task-progress" aria-hidden="true">
          <div
            className="v3-task-progress-fill"
            style={{ width: `${progress}%` }}
          />
        </div>
      )}

      <div className="v3-task-meta">
        {task.task_date && (
          <span className="v3-task-chip" title={task.task_date}>
            <Calendar size={11} strokeWidth={2} aria-hidden="true" />
            {task.task_date}
          </span>
        )}
        {task.assignee_ids.length > 0 && (
          <span className="v3-task-chip" title={t("trello.assignees")}>
            <Users size={11} strokeWidth={2} aria-hidden="true" />
            {task.assignee_ids.length}
          </span>
        )}
        {task.comment_count > 0 && (
          <span className="v3-task-chip" title={t("trello.comments")}>
            <MessageSquare size={11} strokeWidth={2} aria-hidden="true" />
            {task.comment_count}
          </span>
        )}
        <span className="v3-task-progress-label">{progress}%</span>
      </div>
    </article>
  );
}
