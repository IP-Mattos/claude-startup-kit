import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { RefreshCw, X } from "lucide-react";
import type { Project } from "../../types";
import { friendlyErrorEn, projectName } from "../../lib/format";
import { plural, useT } from "../../lib/i18n";
import { IS_TAURI } from "../../lib/env";

interface Todo {
  id: string;
  project: string;
  text: string;
  done: boolean;
  created_at: number;
  updated_at: number;
}

const LS_LAST_PROJECT = "csk-todos-last-project";

export function TodosView() {
  const { t } = useT();

  const [projects, setProjects] = useState<Project[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);

  // null = "All projects". Restored from localStorage on mount.
  const [selectedProject, setSelectedProject] = useState<string | null>(() => {
    try {
      const v = localStorage.getItem(LS_LAST_PROJECT);
      return v && v.length > 0 ? v : null;
    } catch {
      return null;
    }
  });

  const [inputText, setInputText] = useState("");
  const [adding, setAdding] = useState(false);

  // Inline edit: clicking the text turns it into a controlled input.
  // Enter saves, Escape cancels.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const editInputRef = useRef<HTMLInputElement | null>(null);

  // Persist project choice across reloads.
  useEffect(() => {
    try {
      if (selectedProject) localStorage.setItem(LS_LAST_PROJECT, selectedProject);
      else localStorage.removeItem(LS_LAST_PROJECT);
    } catch {
      /* storage full / locked — ignore */
    }
  }, [selectedProject]);

  // Project list — own scan_projects call so the view stays self-contained.
  // Uses a wide window (90d) so the picker covers anything the user might
  // want to attach todos to. AppV3 also calls scan_projects, but with a
  // user-tunable window — duplicating the call here keeps the view drop-in.
  useEffect(() => {
    if (!IS_TAURI) return;
    let cancelled = false;
    invoke<Project[]>("scan_projects", { windowDays: 90 })
      .then((res) => !cancelled && setProjects(res))
      .catch(() => {
        /* silent — picker just stays empty, error surfaces from todo fetch */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Fetch todos on mount, project change, or refresh.
  useEffect(() => {
    if (!IS_TAURI) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    invoke<Todo[]>("list_todos", { project: selectedProject ?? undefined })
      .then((res) => !cancelled && setTodos(res))
      .catch((e) => !cancelled && setError(friendlyErrorEn(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedProject, refreshNonce]);

  // Focus the edit input when entering edit mode.
  useEffect(() => {
    if (editingId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingId]);

  const refetch = () => setRefreshNonce((n) => n + 1);

  const counts = useMemo(() => {
    const pending = todos.filter((td) => !td.done).length;
    const done = todos.length - pending;
    return { pending, done };
  }, [todos]);

  const submitAdd = async () => {
    if (!IS_TAURI) return;
    const text = inputText.trim();
    if (!text || !selectedProject || adding) return;
    setAdding(true);
    setError(null);
    try {
      await invoke<Todo>("add_todo", { project: selectedProject, text });
      setInputText("");
      refetch();
    } catch (e) {
      setError(friendlyErrorEn(e));
    } finally {
      setAdding(false);
    }
  };

  const onAddKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submitAdd();
    }
  };

  const toggle = async (id: string) => {
    if (!IS_TAURI) return;
    try {
      await invoke<Todo>("toggle_todo", { id });
      refetch();
    } catch (e) {
      setError(friendlyErrorEn(e));
    }
  };

  const remove = async (id: string) => {
    if (!IS_TAURI) return;
    try {
      await invoke("delete_todo", { id });
      refetch();
    } catch (e) {
      setError(friendlyErrorEn(e));
    }
  };

  const startEdit = (td: Todo) => {
    setEditingId(td.id);
    setEditText(td.text);
  };
  const cancelEdit = () => {
    setEditingId(null);
    setEditText("");
  };
  const saveEdit = async () => {
    if (!IS_TAURI || !editingId) return cancelEdit();
    const text = editText.trim();
    if (!text) return cancelEdit();
    try {
      await invoke<Todo>("update_todo", { id: editingId, text });
      cancelEdit();
      refetch();
    } catch (e) {
      setError(friendlyErrorEn(e));
      cancelEdit();
    }
  };
  const onEditKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void saveEdit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancelEdit();
    }
  };

  const noProjectSelected = selectedProject === null;
  const showAllProjectMeta = selectedProject === null; // when "all", row shows project name

  return (
    <div className="v3-view">
      <header className="v3-view-head">
        <div>
          <h1 className="v3-greeting">{t("todos.title")}</h1>
          <p className="v3-subtitle">{t("todos.subtitle")}</p>
        </div>
        <div className="v3-view-tools">
          <button
            type="button"
            className="v3-link"
            onClick={refetch}
            disabled={loading}
          >
            <RefreshCw size={12} strokeWidth={2.4} />
            {loading ? ` ${t("todos.refreshing")}` : ` ${t("todos.refresh")}`}
          </button>
        </div>
      </header>

      {error && (
        <div className="v3-error" role="alert" aria-live="assertive">
          {error}
        </div>
      )}

      <article className="v3-card">
        <header className="v3-card-head">
          <h2 className="v3-card-title">{t("todos.project_picker_label")}</h2>
          <span className="v3-row-dim">
            {plural(t, todos.length, "todos.count_one", "todos.count_other")}
            {todos.length > 0 && (
              <>
                {" · "}
                {t("todos.pending_count", { n: counts.pending })}
                {" · "}
                {t("todos.done_count", { n: counts.done })}
              </>
            )}
          </span>
        </header>

        <select
          className="v3-select v3-todos-picker"
          value={selectedProject ?? ""}
          onChange={(e) => setSelectedProject(e.target.value || null)}
          aria-label={t("todos.project_picker_label")}
        >
          <option value="">{t("todos.all_projects")}</option>
          {projects.map((p) => (
            <option key={p.path} value={p.path}>
              {projectName(p.path)}
            </option>
          ))}
        </select>

        <div className="v3-todos-form">
          <textarea
            className="v3-todos-input"
            placeholder={t("todos.placeholder")}
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={onAddKey}
            disabled={noProjectSelected || adding}
            rows={1}
          />
          <button
            type="button"
            className="v3-btn-primary v3-btn-sm"
            onClick={() => void submitAdd()}
            disabled={
              noProjectSelected || adding || inputText.trim().length === 0
            }
          >
            {adding ? t("todos.adding") : t("todos.add_button")}
          </button>
        </div>
      </article>

      {loading ? (
        <div className="v3-empty">{t("common.loading")}</div>
      ) : todos.length === 0 ? (
        <div className="v3-empty">
          {noProjectSelected
            ? t("todos.empty_no_project")
            : t("todos.empty_for_project")}
        </div>
      ) : (
        <ul className="v3-list v3-todos-list">
          {todos.map((td) => {
            const isEditing = editingId === td.id;
            return (
              <li
                key={td.id}
                className={
                  "v3-row v3-todos-row" + (td.done ? " done" : "")
                }
              >
                <input
                  type="checkbox"
                  className="v3-todos-checkbox"
                  checked={td.done}
                  onChange={() => void toggle(td.id)}
                  aria-label={t("todos.toggle_aria")}
                />
                <div className="v3-row-body">
                  {isEditing ? (
                    <input
                      ref={editInputRef}
                      type="text"
                      className="v3-input v3-todos-edit-input"
                      value={editText}
                      onChange={(e) => setEditText(e.target.value)}
                      onKeyDown={onEditKey}
                      onBlur={() => void saveEdit()}
                      aria-label={t("todos.edit_aria")}
                    />
                  ) : (
                    <button
                      type="button"
                      className="v3-todos-text"
                      onClick={() => startEdit(td)}
                      title={t("todos.edit_aria")}
                    >
                      {td.text}
                    </button>
                  )}
                  {showAllProjectMeta && (
                    <div className="v3-row-meta">
                      <span className="v3-row-path" title={td.project}>
                        {projectName(td.project)}
                      </span>
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  className="v3-todos-delete"
                  onClick={() => void remove(td.id)}
                  aria-label={t("todos.delete_aria")}
                  title={t("todos.delete_aria")}
                >
                  <X size={13} strokeWidth={2.4} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
