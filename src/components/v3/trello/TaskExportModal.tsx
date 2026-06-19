import { useEffect, useMemo, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import { useT } from "../../../lib/i18n";
import type { Column, Task } from "../../../lib/trello/types";
import { downloadTasksJson } from "../../../lib/trello/exportTasks";

interface Props {
  tasks: Task[];
  columns: Column[];
  projectName: string | null;
  onClose: () => void;
}

// Pick one or many tasks and download them as JSON. Opens with everything
// selected (the common "export the board" case); deselect to narrow, or
// Clear + pick the specific ones you want.
export function TaskExportModal({ tasks, columns, projectName, onClose }: Props) {
  const { t } = useT();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(tasks.map((task) => task.id)),
  );

  // Same backdrop-close guard as the task editor: only close when a click both
  // starts and ends on the overlay, so a stray drag-release doesn't close it.
  const overlayMouseDown = useRef(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const allSelected = tasks.length > 0 && selected.size === tasks.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(tasks.map((task) => task.id)));

  const download = () => {
    const chosen = tasks.filter((task) => selected.has(task.id));
    if (chosen.length === 0) return;
    downloadTasksJson(chosen, columns, projectName);
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
        aria-label={t("trello.export_title")}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="v3-modal-head">
          <h2>{t("trello.export_title")}</h2>
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
          <div className="v3-export-head">
            <span className="v3-export-count">
              {selected.size} / {tasks.length}
            </span>
            <button type="button" className="v3-link" onClick={toggleAll}>
              {allSelected ? t("trello.export_clear") : t("trello.export_all")}
            </button>
          </div>

          {tasks.length === 0 ? (
            <p className="v3-wl-empty">{t("trello.no_tasks")}</p>
          ) : (
            columns.map((col) => {
              const list = byColumn.get(col.id) ?? [];
              if (list.length === 0) return null;
              return (
                <div key={col.id} className="v3-export-group">
                  <div className="v3-export-group-name">
                    {col.name}
                    <span className="v3-export-group-count">{list.length}</span>
                  </div>
                  {list.map((task) => (
                    <label key={task.id} className="v3-export-row">
                      <input
                        type="checkbox"
                        checked={selected.has(task.id)}
                        onChange={() => toggle(task.id)}
                      />
                      <span className="v3-export-row-title">{task.title}</span>
                      <span className="v3-export-row-meta">{task.progress}%</span>
                    </label>
                  ))}
                </div>
              );
            })
          )}
        </div>

        <footer className="v3-modal-foot">
          <div className="v3-modal-foot-right">
            <button type="button" className="v3-btn-ghost" onClick={onClose}>
              {t("common.cancel")}
            </button>
            <button
              type="button"
              className="v3-btn-primary"
              onClick={download}
              disabled={selected.size === 0}
            >
              <Download size={13} strokeWidth={2} aria-hidden="true" />
              {t("trello.export_download")} ({selected.size})
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
