import { useRef, type KeyboardEvent } from "react";
import {
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  GitBranch,
  MessageSquare,
  Users,
} from "lucide-react";
import { useT } from "../../../lib/i18n";
import type { Task } from "../../../lib/trello/types";

type MoveDir = "left" | "right" | "up" | "down";

interface Props {
  task: Task;
  busy: boolean; // a mutation is in flight for this task
  canLeft: boolean;
  canRight: boolean;
  canUp: boolean;
  canDown: boolean;
  showReorder: boolean; // column has >1 card → expose up/down
  prevColName: string | null;
  nextColName: string | null;
  onOpen: (task: Task) => void;
  onComplete: (task: Task) => void;
  onMove: (dir: MoveDir) => void;
}

export function TaskCard({
  task,
  busy,
  canLeft,
  canRight,
  canUp,
  canDown,
  showReorder,
  prevColName,
  nextColName,
  onOpen,
  onComplete,
  onMove,
}: Props) {
  const { t } = useT();
  const cardRef = useRef<HTMLElement>(null);
  const done = task.completed_at !== null;
  const progress = Math.max(0, Math.min(100, task.progress));
  const isTemp = task.id.startsWith("temp-");
  const locked = busy || isTemp; // can't fire a second concurrent move

  // Edge buttons (disabled) describe the boundary instead of promising a
  // destination that doesn't exist ("Move to " with an empty column name).
  const leftLabel =
    canLeft && prevColName
      ? t("trello.move_prev", { col: prevColName })
      : t("trello.at_first");
  const rightLabel =
    canRight && nextColName
      ? t("trello.move_next", { col: nextColName })
      : t("trello.at_last");

  const onCardKeyDown = (e: KeyboardEvent) => {
    // Only act when the CARD itself is focused — keydown bubbles up from the
    // nested move/complete buttons, and without this guard activating one of
    // them with Enter/Space would also open the editor.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(task);
      return;
    }
    // Alt+Arrow power-move. Alt-guarded so plain arrows still scroll/caret and
    // it never collides with the app's Ctrl/Cmd+1..7 tab shortcuts.
    if (!e.altKey || locked) return;
    const hit =
      e.key === "ArrowLeft"
        ? { dir: "left" as const, can: canLeft }
        : e.key === "ArrowRight"
          ? { dir: "right" as const, can: canRight }
          : e.key === "ArrowUp"
            ? { dir: "up" as const, can: canUp }
            : e.key === "ArrowDown"
              ? { dir: "down" as const, can: canDown }
              : null;
    if (hit && hit.can) {
      e.preventDefault();
      onMove(hit.dir);
    }
  };

  const moveBtn = (
    dir: MoveDir,
    can: boolean,
    Icon: typeof ChevronLeft,
    label: string,
    reorder: boolean,
  ) => (
    <button
      type="button"
      className={"v3-task-move-btn" + (reorder ? " is-reorder" : "")}
      disabled={locked || !can}
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onMove(dir);
        // Keep the keyboard anchor on the card: onMove flips this task to
        // busy, which disables this very button on the next render and would
        // otherwise blur focus to <body>. Refocusing now (before the re-render)
        // lands focus on the always-enabled card instead.
        cardRef.current?.focus();
      }}
    >
      <Icon size={reorder ? 14 : 15} strokeWidth={2} aria-hidden="true" />
    </button>
  );

  return (
    <article
      ref={cardRef}
      className={
        "v3-task-card" + (done ? " is-done" : "") + (isTemp ? " is-pending" : "")
      }
      onClick={() => onOpen(task)}
      role="button"
      tabIndex={0}
      onKeyDown={onCardKeyDown}
      aria-label={task.title}
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
      title={t("trello.move_hint")}
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
            style={{ width: `${done ? 100 : progress}%` }}
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
        {task.flow && task.flow.trim().length > 0 && (
          <span
            className="v3-task-chip v3-task-flow-chip"
            title={t("trello.flow_indicator")}
            aria-label={t("trello.flow_indicator")}
          >
            <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
          </span>
        )}
        {done ? (
          <span className="v3-task-done-label">{t("trello.done")}</span>
        ) : (
          <span className="v3-task-progress-label">{progress}%</span>
        )}
      </div>

      <div className="v3-task-move">
        {moveBtn("left", canLeft, ChevronLeft, leftLabel, false)}
        {showReorder && (
          <div className="v3-task-move-group">
            {moveBtn("up", canUp, ChevronUp, t("trello.move_up"), true)}
            {moveBtn("down", canDown, ChevronDown, t("trello.move_down"), true)}
          </div>
        )}
        {moveBtn("right", canRight, ChevronRight, rightLabel, false)}
      </div>
    </article>
  );
}
