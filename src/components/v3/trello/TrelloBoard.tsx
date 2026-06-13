import { useMemo } from "react";
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

type MoveDir = "left" | "right" | "up" | "down";

// Fractional position helpers — the same proven midpoint math the old drag
// path used, now driving the arrow controls. Cross-column moves append to the
// destination's end; within-column reorder inserts between neighbors.
function appendPosition(destList: Task[]): number {
  const last = destList[destList.length - 1];
  return (last ? last.position : 0) + 1;
}
function positionAbove(list: Task[], i: number): number {
  const before = list[i - 1];
  const prev = list[i - 2];
  if (prev) return (prev.position + before.position) / 2;
  // Inserting above the current top card: land strictly below it even if its
  // position is 0 or negative (possible with API-seeded data) so they never tie.
  return before.position > 0 ? before.position / 2 : before.position - 1;
}
function positionBelow(list: Task[], i: number): number {
  const next = list[i + 1];
  const after = list[i + 2];
  return after ? (next.position + after.position) / 2 : next.position + 1;
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

  return (
    <div className="v3-board">
      {columns.map((col, colIndex) => {
        const list = byColumn.get(col.id) ?? [];
        const prevCol = columns[colIndex - 1];
        const nextCol = columns[colIndex + 1];
        const canLeft = colIndex > 0;
        const canRight = colIndex < columns.length - 1;
        const showReorder = list.length > 1;

        const move = (task: Task, i: number, dir: MoveDir) => {
          if (dir === "left" && prevCol) {
            onMoveTask(task.id, prevCol.id, appendPosition(byColumn.get(prevCol.id) ?? []));
          } else if (dir === "right" && nextCol) {
            onMoveTask(task.id, nextCol.id, appendPosition(byColumn.get(nextCol.id) ?? []));
          } else if (dir === "up" && i > 0) {
            onMoveTask(task.id, col.id, positionAbove(list, i));
          } else if (dir === "down" && i < list.length - 1) {
            onMoveTask(task.id, col.id, positionBelow(list, i));
          }
        };

        return (
          <section key={col.id} className="v3-board-col">
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
              {list.map((task, i) => (
                <TaskCard
                  key={task.id}
                  task={task}
                  busy={busyTaskIds.has(task.id)}
                  canLeft={canLeft}
                  canRight={canRight}
                  canUp={i > 0}
                  canDown={i < list.length - 1}
                  showReorder={showReorder}
                  prevColName={prevCol ? prevCol.name : null}
                  nextColName={nextCol ? nextCol.name : null}
                  onOpen={onOpenTask}
                  onComplete={onCompleteTask}
                  onMove={(dir) => move(task, i, dir)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
