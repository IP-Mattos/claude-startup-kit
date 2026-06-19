import type { Column, Task } from "./types";

// Builds a clean, self-describing JSON export of the chosen tasks and triggers
// a download. Uses a Blob + temporary <a download> — handled by the Tauri
// WebView2 download manager (and by any browser in the dev preview), so no
// extra Rust/fs plumbing is needed.
//
// Each task keeps its full field set (the snake_case wire shape) plus a
// resolved `column_name` so the file is readable on its own.
export function downloadTasksJson(
  tasks: Task[],
  columns: Column[],
  projectName: string | null,
): void {
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
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const stamp = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const slug =
    (projectName ?? "tasks")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "tasks";

  const a = document.createElement("a");
  a.href = url;
  a.download = `${slug}-tasks-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke on the next tick so the download has time to start.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
