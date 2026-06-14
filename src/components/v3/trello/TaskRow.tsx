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
} from "lucide-react";
import { useT } from "../../../lib/i18n";
import type { Member, Task } from "../../../lib/trello/types";
import { MemberAvatar } from "./MemberAvatar";

type MoveDir = "left" | "right" | "up" | "down";
const MAX_FACES = 3;

interface Props {
  task: Task;
  memberById: Map<string, Member>;
  busy: boolean;
  canLeft: boolean;
  canRight: boolean;
  canUp: boolean;
  canDown: boolean;
  showReorder: boolean;
  prevColName: string | null;
  nextColName: string | null;
  onOpen: (task: Task) => void;
  onComplete: (task: Task) => void;
  onMove: (dir: MoveDir) => void;
}

export function TaskRow({
  task,
  memberById,
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
  const rowRef = useRef<HTMLElement>(null);
  const done = task.completed_at !== null;
  const progress = Math.max(0, Math.min(100, task.progress));
  const isTemp = task.id.startsWith("temp-");
  const locked = busy || isTemp;

  // Resolve assignee ids to people; unknown ids (not in the roster) still show
  // as a "?" face so the count stays honest.
  const assignees: Member[] = task.assignee_ids.map(
    (id) => memberById.get(id) ?? { id, name: null, avatar_url: null, role: "" },
  );
  const faces = assignees.slice(0, MAX_FACES);
  const overflow = assignees.length - faces.length;

  const onRowKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return; // child buttons handle their own keys
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(task);
      return;
    }
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
      className={"v3-wl-move-btn" + (reorder ? " is-reorder" : "")}
      disabled={locked || !can}
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onMove(dir);
        rowRef.current?.focus(); // keep the keyboard anchor on the row
      }}
    >
      <Icon size={reorder ? 13 : 15} strokeWidth={2} aria-hidden="true" />
    </button>
  );

  const leftLabel =
    canLeft && prevColName
      ? t("trello.move_prev", { col: prevColName })
      : t("trello.at_first");
  const rightLabel =
    canRight && nextColName
      ? t("trello.move_next", { col: nextColName })
      : t("trello.at_last");

  return (
    <article
      ref={rowRef}
      className={"v3-wl-row" + (done ? " is-done" : "") + (isTemp ? " is-pending" : "")}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(task)}
      onKeyDown={onRowKeyDown}
      aria-label={task.title}
      aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown"
      title={t("trello.move_hint")}
    >
      <button
        type="button"
        className="v3-wl-check"
        disabled={busy || done}
        title={done ? t("trello.done") : t("trello.complete")}
        aria-label={done ? t("trello.done") : t("trello.complete")}
        onClick={(e) => {
          e.stopPropagation();
          if (!done) onComplete(task);
        }}
      >
        <Check size={12} strokeWidth={3} aria-hidden="true" />
      </button>

      <div className="v3-wl-row-main">
        <p className="v3-wl-row-title">{task.title}</p>
        <div className="v3-wl-row-meta">
          {task.task_date && (
            <span className="v3-wl-chip" title={task.task_date}>
              <Calendar size={11} strokeWidth={2} aria-hidden="true" />
              {task.task_date}
            </span>
          )}
          {task.comment_count > 0 && (
            <span className="v3-wl-chip" title={t("trello.comments")}>
              <MessageSquare size={11} strokeWidth={2} aria-hidden="true" />
              {task.comment_count}
            </span>
          )}
          {task.flow && task.flow.trim().length > 0 && (
            <span
              className="v3-wl-chip"
              title={t("trello.flow_indicator")}
              aria-label={t("trello.flow_indicator")}
            >
              <GitBranch size={11} strokeWidth={2} aria-hidden="true" />
            </span>
          )}
        </div>
      </div>

      <div className="v3-wl-row-aside">
        {assignees.length > 0 && (
          <span className="v3-wl-avatars" title={t("trello.assignees")}>
            {faces.map((m, i) => (
              <MemberAvatar key={m.id + i} member={m} size={22} />
            ))}
            {overflow > 0 && <span className="v3-avatar v3-avatar-more">+{overflow}</span>}
          </span>
        )}

        <span className="v3-wl-prog" aria-hidden="true">
          <span className="v3-wl-prog-bar">
            <span className="v3-wl-prog-fill" style={{ width: `${done ? 100 : progress}%` }} />
          </span>
          <span className="v3-wl-prog-pct">
            {done ? t("trello.done") : `${progress}%`}
          </span>
        </span>

        <span className="v3-wl-move">
          {moveBtn("left", canLeft, ChevronLeft, leftLabel, false)}
          {showReorder && (
            <span className="v3-wl-move-group">
              {moveBtn("up", canUp, ChevronUp, t("trello.move_up"), true)}
              {moveBtn("down", canDown, ChevronDown, t("trello.move_down"), true)}
            </span>
          )}
          {moveBtn("right", canRight, ChevronRight, rightLabel, false)}
        </span>
      </div>
    </article>
  );
}
