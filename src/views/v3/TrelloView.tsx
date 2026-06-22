import { useState } from "react";
import { Download, LogOut, RefreshCw } from "lucide-react";
import { useT } from "../../lib/i18n";
import { useTrelloBoard } from "../../lib/trello/useTrelloBoard";
import type { LiveStatus } from "../../lib/trello/useTrelloBoard";
import type { Task } from "../../lib/trello/types";
import { TrelloConfig } from "../../components/v3/trello/TrelloConfig";
import { TrelloWorkList } from "../../components/v3/trello/TrelloWorkList";
import { TaskEditor } from "../../components/v3/trello/TaskEditor";
import { TaskExportModal } from "../../components/v3/trello/TaskExportModal";

interface EditorState {
  task: Task | null; // null → create mode
  columnId: string;
}

function liveLabel(t: ReturnType<typeof useT>["t"], live: LiveStatus): string {
  switch (live) {
    case "live":
      return t("trello.live_on");
    case "connecting":
      return t("trello.live_connecting");
    case "error":
      return t("trello.live_error");
    default:
      return t("trello.live_off");
  }
}

export function TrelloView() {
  const { t } = useT();
  const board = useTrelloBoard();
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [exporting, setExporting] = useState(false);

  if (board.boot === "loading") {
    return (
      <div className="v3-view">
        <div className="v3-empty">
          <RefreshCw size={14} strokeWidth={2} className="v3-spin" aria-hidden="true" />{" "}
          {t("trello.loading")}
        </div>
      </div>
    );
  }

  if (board.boot === "unconfigured") {
    return (
      <TrelloConfig
        available={board.available}
        initialError={board.error}
        onConfigure={board.configure}
      />
    );
  }

  // boot === "ready"
  return (
    <div className="v3-view v3-trello-view">
      <header className="v3-view-head v3-trello-head">
        <div>
          <h1 className="v3-greeting">{t("trello.title")}</h1>
          <p className="v3-subtitle">
            {board.profile ? board.profile.name : t("trello.subtitle")}
          </p>
        </div>
        <div className="v3-trello-head-actions">
          <select
            className="v3-select"
            value={board.activeProjectId ?? ""}
            onChange={(e) => board.selectProject(e.target.value)}
            aria-label={t("trello.project")}
            disabled={board.projectsLoading || board.projects.length === 0}
          >
            {board.projects.length === 0 && (
              <option value="">{t("trello.no_projects")}</option>
            )}
            {board.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>

          <span
            className={"v3-trello-live v3-trello-live-" + board.live}
            title={liveLabel(t, board.live)}
          >
            <span className="v3-trello-live-dot" aria-hidden="true" />
            {liveLabel(t, board.live)}
          </span>

          <button
            type="button"
            className="v3-icon-btn"
            onClick={() => setExporting(true)}
            title={t("trello.export")}
            aria-label={t("trello.export")}
            disabled={board.tasks.length === 0}
          >
            <Download size={14} strokeWidth={2} aria-hidden="true" />
          </button>

          <button
            type="button"
            className="v3-icon-btn"
            onClick={board.refreshBoard}
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
            disabled={board.boardLoading}
          >
            <RefreshCw
              size={14}
              strokeWidth={2}
              className={board.boardLoading ? "v3-spin" : ""}
              aria-hidden="true"
            />
          </button>

          <button
            type="button"
            className="v3-icon-btn"
            onClick={() => void board.disconnect()}
            title={t("trello.disconnect")}
            aria-label={t("trello.disconnect")}
          >
            <LogOut size={14} strokeWidth={2} aria-hidden="true" />
          </button>
        </div>
      </header>

      {board.error && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {board.error}
        </div>
      )}
      {board.lagged && (
        <div className="v3-trello-lag" role="status">
          {t("trello.lag")}
        </div>
      )}
      {board.notice === "requires_supervisor_approval" && (
        <div className="v3-trello-notice" role="status">
          {t("trello.notice_supervisor")}
          <button
            type="button"
            className="v3-btn-ghost"
            onClick={board.dismissNotice}
          >
            {t("common.close")}
          </button>
        </div>
      )}

      {board.columns.length === 0 && board.boardLoading ? (
        <div className="v3-empty">
          <RefreshCw size={14} strokeWidth={2} className="v3-spin" aria-hidden="true" />{" "}
          {t("trello.loading_board")}
        </div>
      ) : board.columns.length === 0 ? (
        <div className="v3-empty">{t("trello.no_columns")}</div>
      ) : (
        <TrelloWorkList
          columns={board.columns}
          tasks={board.tasks}
          members={board.members}
          busyTaskIds={board.busyTaskIds}
          onOpenTask={(task) => setEditor({ task, columnId: task.column_id })}
          onAddTask={(columnId) => setEditor({ task: null, columnId })}
          onCompleteTask={(task) => void board.completeTask(task.id)}
          onMoveTask={(id, col, pos) => void board.moveTask(id, col, pos)}
        />
      )}

      {editor && (
        <TaskEditor
          task={editor.task}
          liveTask={
            editor.task
              ? board.tasks.find((t) => t.id === editor.task!.id) ?? null
              : null
          }
          busy={editor.task ? board.busyTaskIds.has(editor.task.id) : false}
          columnId={editor.columnId}
          columns={board.columns}
          members={board.members}
          onClose={() => setEditor(null)}
          onCreate={(columnId, title, extra) =>
            void board.createTask(columnId, title, extra)
          }
          onSave={(taskId, patch) => void board.patchTask(taskId, patch)}
          onDelete={(taskId) => void board.deleteTask(taskId)}
        />
      )}

      {exporting && (
        <TaskExportModal
          tasks={board.tasks}
          columns={board.columns}
          projectName={
            board.projects.find((p) => p.id === board.activeProjectId)?.name ?? null
          }
          onClose={() => setExporting(false)}
        />
      )}
    </div>
  );
}
