import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Plus } from "lucide-react";
import { useT } from "../../../lib/i18n";
import type { Column, Member, Task } from "../../../lib/trello/types";
import { MemberAvatar } from "./MemberAvatar";
import { TaskRow } from "./TaskRow";

type MoveDir = "left" | "right" | "up" | "down";

interface Props {
  columns: Column[];
  tasks: Task[];
  members: Member[];
  busyTaskIds: ReadonlySet<string>;
  onOpenTask: (task: Task) => void;
  onAddTask: (columnId: string) => void;
  onCompleteTask: (task: Task) => void;
  onMoveTask: (taskId: string, toColumnId: string, position: number) => void;
}

// Fractional position helpers (same proven midpoint math the board used).
function appendPosition(destList: Task[]): number {
  const last = destList[destList.length - 1];
  return (last ? last.position : 0) + 1;
}
function positionAbove(list: Task[], i: number): number {
  const before = list[i - 1];
  const prev = list[i - 2];
  if (prev) return (prev.position + before.position) / 2;
  return before.position > 0 ? before.position / 2 : before.position - 1;
}
function positionBelow(list: Task[], i: number): number {
  const next = list[i + 1];
  const after = list[i + 2];
  return after ? (next.position + after.position) / 2 : next.position + 1;
}

export function TrelloWorkList({
  columns,
  tasks,
  members,
  busyTaskIds,
  onOpenTask,
  onAddTask,
  onCompleteTask,
  onMoveTask,
}: Props) {
  const { t } = useT();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());

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

  const memberById = useMemo(
    () => new Map(members.map((m) => [m.id, m])),
    [members],
  );

  const toggle = (colId: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(colId)) next.delete(colId);
      else next.add(colId);
      return next;
    });

  return (
    <div className="v3-wl">
      {members.length > 0 && (
        <div className="v3-wl-roster">
          <span className="v3-wl-roster-label">{t("trello.team")}</span>
          <span className="v3-wl-roster-people">
            {members.map((m) => (
              <span key={m.id} className="v3-wl-roster-chip">
                <MemberAvatar member={m} size={20} />
                <span className="v3-wl-roster-name">{m.name ?? "—"}</span>
                {m.role === "supervisor" && (
                  <span className="v3-wl-roster-role">{t("trello.role_supervisor")}</span>
                )}
              </span>
            ))}
          </span>
        </div>
      )}

      {columns.map((col, colIndex) => {
        const list = byColumn.get(col.id) ?? [];
        const isCollapsed = collapsed.has(col.id);
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
          <section
            key={col.id}
            className={"v3-wl-section" + (isCollapsed ? " is-collapsed" : "")}
          >
            <div className="v3-wl-section-head">
              <button
                type="button"
                className="v3-wl-section-toggle"
                onClick={() => toggle(col.id)}
                aria-expanded={!isCollapsed}
              >
                {isCollapsed ? (
                  <ChevronRight size={14} strokeWidth={2.5} aria-hidden="true" />
                ) : (
                  <ChevronDown size={14} strokeWidth={2.5} aria-hidden="true" />
                )}
                <span className="v3-wl-section-name">{col.name}</span>
                <span className="v3-wl-section-count">{list.length}</span>
              </button>
              <button
                type="button"
                className="v3-wl-section-add"
                title={t("trello.add_task")}
                aria-label={t("trello.add_task")}
                onClick={() => onAddTask(col.id)}
              >
                <Plus size={14} strokeWidth={2} aria-hidden="true" />
              </button>
            </div>

            {!isCollapsed && (
              <div className="v3-wl-section-body">
                {list.length === 0 ? (
                  <p className="v3-wl-empty">{t("trello.no_tasks")}</p>
                ) : (
                  list.map((task, i) => (
                    <TaskRow
                      key={task.id}
                      task={task}
                      memberById={memberById}
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
                  ))
                )}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}
