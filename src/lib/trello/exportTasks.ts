import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { IS_TAURI } from "../env";
import type { Column, Task } from "./types";

// Builds a clean, self-describing JSON export of the chosen tasks and saves it
// to disk. In the packaged Tauri app a Blob + <a download> does NOT work: the
// WebView2 webview has no download manager and the CSP (default-src 'self' …)
// blocks navigating to a blob: URL, so the click is a silent no-op. We open the
// native save dialog and write the file through Rust instead. In the plain
// browser dev preview (no Tauri) we keep the Blob fallback so export still works
// at http://localhost:1420.
//
// Each task keeps its full field set (the snake_case wire shape) plus a
// resolved `column_name` so the file is readable on its own.
//
// Returns `true` if a file was written, `false` if the user cancelled the
// native save dialog (so the caller can keep its modal open).
export async function downloadTasksJson(
  tasks: Task[],
  columns: Column[],
  projectName: string | null,
): Promise<boolean> {
  const columnName = new Map(columns.map((c) => [c.id, c.name]));

  const payload = {
    exported_at: new Date().toISOString(),
    project: projectName ?? null,
    count: tasks.length,
    tasks: tasks.map((task) => ({
      ...task,
      column_name: columnName.get(task.column_id) ?? null,
    })),
  };

  const json = JSON.stringify(payload, null, 2);

  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const slug =
    (projectName ?? "tasks")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tasks";
  const filename = `${slug}-tasks-${stamp}.json`;

  if (IS_TAURI) {
    // Native "Save As" — the only mechanism that actually writes a file from
    // inside the packaged WebView2 app.
    const path = await save({
      defaultPath: filename,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (!path) return false; // user cancelled the dialog
    await invoke("write_text_file", { path, contents: json });
    return true;
  }

  // Browser dev preview fallback: Blob + temporary <a download>.
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return true;
}
