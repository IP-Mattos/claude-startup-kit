import { useMemo, useState, type DragEvent } from "react";
import { Plus } from "lucide-react";
import { useT } from "../../../lib/i18n";
import type { Column, Task } from "../../../lib/trello/types";
import { TaskCard } from "./TaskCard";

interface Props {
  columns: Column[];
  tasks: Task[];
  busyTaskIds: ReadonlySet<string>;
  onOpenTask: (task: Task) => void;
  onAddTask: (columnId: string) => void;
  onCompleteTask: (task: Task) => void;
  onMoveTask: (taskId: string, toColumnId: string, position: number) => void;
}

interface DropTarget {
  columnId: string;
  beforeTaskId: string | null; // null → append to the end of the column
}

export function TrelloBoard({
  columns,
  tasks,
  busyTaskIds,
  onOpenTask,
  onAddTask,
  onCompleteTask,
  onMoveTask,
}: Props) {
  const { t } = useT();
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);

  // Tasks grouped by column, each sorted by fractional position.
  const byColumn = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const c of columns) map.set(c.id, []);
    for (const task of tasks) {
      if (!map.has(task.column_id)) map.set(task.column_id, []);
      map.get(task.column_id)!.push(task);
    }
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [columns, tasks]);

  const beginDrag = (task: Task, e: DragEvent) => {
    setDraggingId(task.id);
    try {
      e.dataTransfer.setData("text/plain", task.id);
      e.dataTransfer.effectAllowed = "move";
    } catch {
      /* some webviews are picky about setData — draggingId state covers us */
    }
  };

  const endDrag = () => {
    setDraggingId(null);
    setDropTarget(null);
  };

  // Compute the fractional position for the current drop target and commit.
  const commitDrop = (columnId: string) => {
    if (!draggingId) return;
    const target = dropTarget;
    // Dropping a card onto its own slot is the natural "lift and put it back"
    // gesture — it must be a no-op, never a real move_task to the column end.
    if (target && target.beforeTaskId === draggingId) {
      endDrag();
      return;
    }
    // Sorted tasks already in the destination column, minus the dragged one.
    const dest = (byColumn.get(columnId) ?? []).filter((x) => x.id !== draggingId);

    let position: number;
    if (!target || target.beforeTaskId === null) {
      const last = dest[dest.length - 1];
      position = (last ? last.position : 0) + 1;
    } else {
      const idx = dest.findIndex((x) => x.id === target.beforeTaskId);
      if (idx === -1) {
        const last = dest[dest.length - 1];
        position = (last ? last.position : 0) + 1;
      } else {
        const before = dest[idx];
        const prev = dest[idx - 1];
        position = prev ? (prev.position + before.position) / 2 : before.position / 2;
      }
    }
    onMoveTask(draggingId, columnId, position);
    endDrag();
  };

  return (
    <div className="v3-board" onDragEnd={endDrag}>
      {columns.map((col) => {
        const list = byColumn.get(col.id) ?? [];
        const isActiveCol = dropTarget?.columnId === col.id;
        return (
          <section
            key={col.id}
            className={"v3-board-col" + (isActiveCol ? " is-drop-active" : "")}
            onDragOver={(e) => {
              if (!draggingId) return;
              e.preventDefault();
              // Default: append (set only if not already targeting a card).
              setDropTarget((prev) =>
                prev && prev.columnId === col.id ? prev : { columnId: col.id, beforeTaskId: null },
              );
            }}
            onDrop={(e) => {
              e.preventDefault();
              commitDrop(col.id);
            }}
          >
            <header className="v3-board-col-head">
              <span className="v3-board-col-name">{col.name}</span>
              <span className="v3-board-col-count">{list.length}</span>
              <button
                type="button"
                className="v3-board-col-add"
                title={t("trello.add_task")}
                aria-label={t("trello.add_task")}
                onClick={() => onAddTask(col.id)}
              >
                <Plus size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </header>

            <div className="v3-board-col-body">
              {list.length === 0 && (
                <p className="v3-board-col-empty">{t("trello.no_tasks")}</p>
              )}
              {list.map((task) => {
                const showBefore =
                  isActiveCol && dropTarget?.beforeTaskId === task.id && draggingId !== task.id;
                return (
                  <div
                    key={task.id}
                    className={"v3-board-slot" + (showBefore ? " show-indicator" : "")}
                    onDragOver={(e) => {
                      if (!draggingId) return;
                      e.preventDefault();
                      e.stopPropagation();
                      setDropTarget({ columnId: col.id, beforeTaskId: task.id });
                    }}
                  >
                    <TaskCard
                      task={task}
                      dragging={draggingId === task.id}
                      busy={busyTaskIds.has(task.id)}
                      onOpen={onOpenTask}
                      onComplete={onCompleteTask}
                      onDragStart={beginDrag}
                      onDragEnd={endDrag}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
