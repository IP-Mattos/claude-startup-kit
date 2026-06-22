import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { IS_TAURI } from "../env";
import { trelloImportTasks } from "./client";
import type { ImportResult } from "./types";

// Import is Tauri-only: the trello backend (and the read_text_file command)
// don't exist in the plain browser dev preview, so we hard-stop there.
const NOT_AVAILABLE = "Import is only available in the desktop app.";

// Shape of the import body the endpoint accepts. Columns are matched to the
// target project's columns BY NAME (case-insensitive, trimmed) server-side.
interface ImportColumn {
  name: string;
  tasks: ImportTask[];
}
interface ImportTask {
  title: string;
  details: string | null;
  flow: string | null;
  task_date: string | null;
}
interface ImportBody {
  columns: ImportColumn[];
}

// A single task as it appears in the flat CSK export (`tasks: [...]`). Only the
// four importable fields plus the resolved `column_name` matter here; the rest
// of the export's task shape is ignored.
interface FlatExportTask {
  title?: unknown;
  details?: unknown;
  flow?: unknown;
  task_date?: unknown;
  column_name?: unknown;
}

// Narrow an unknown to a non-empty trimmed string, else null. Used for the
// optional task fields so we never forward `undefined` or empty markers.
function nullableStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const trimmed = v.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Decide whether a parsed value already carries a server-ready `columns` array
// (either top-level or nested under `project`). If so, the file is passed
// through unchanged — this covers files authored against the import endpoint
// directly, not the flat CSK export.
function hasColumnsArray(parsed: unknown): parsed is { columns: unknown[] } {
  return (
    !!parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { columns?: unknown }).columns)
  );
}
function hasProjectColumnsArray(
  parsed: unknown,
): parsed is { project: { columns: unknown[] } } {
  if (!parsed || typeof parsed !== "object") return false;
  const project = (parsed as { project?: unknown }).project;
  return (
    !!project &&
    typeof project === "object" &&
    Array.isArray((project as { columns?: unknown }).columns)
  );
}

// Regroup a flat CSK export (`{ tasks: [{ ...fields, column_name }] }`) into the
// `{ columns: [...] }` body the endpoint wants. Tasks that are malformed (null /
// non-object), or whose `column_name`/`title` is null/empty, cannot be placed
// and are dropped locally; `skippedNoColumnName` tallies them. The caller threads
// this count out to the UI so the user knows. Returns the body plus that count.
function groupFlatTasks(tasks: unknown[]): {
  body: ImportBody;
  skippedNoColumnName: number;
} {
  const byColumn = new Map<string, ImportTask[]>();
  let skippedNoColumnName = 0;

  for (const raw of tasks) {
    // A malformed array element (null, undefined, primitive) can't be a task;
    // drop it locally instead of throwing a raw TypeError on field access.
    if (!raw || typeof raw !== "object") {
      skippedNoColumnName++;
      continue;
    }
    const task = raw as FlatExportTask;
    const columnName =
      typeof task.column_name === "string" ? task.column_name.trim() : "";
    if (!columnName) {
      skippedNoColumnName++;
      continue;
    }
    const title = nullableStr(task.title);
    // A task with no title can't be imported; count it as locally skipped too.
    if (!title) {
      skippedNoColumnName++;
      continue;
    }
    const entry: ImportTask = {
      title,
      details: nullableStr(task.details),
      flow: nullableStr(task.flow),
      task_date: nullableStr(task.task_date),
    };
    const list = byColumn.get(columnName);
    if (list) list.push(entry);
    else byColumn.set(columnName, [entry]);
  }

  return {
    body: {
      columns: [...byColumn.entries()].map(([name, tasks]) => ({ name, tasks })),
    },
    skippedNoColumnName,
  };
}

// Error thrown when a recognized file transforms to zero importable columns
// (empty `tasks`, or every task dropped locally). Thrown BEFORE the backend so
// the user gets a clear "nothing to import" message instead of a server 400.
export const IMPORT_EMPTY = "trello.import_empty";

// Parse + transform a raw JSON string into the import body. Throws a friendly
// Error for invalid JSON or an unrecognized shape. Pass-through paths return
// the parsed value verbatim (the endpoint also accepts the nested form).
// Returns the body plus `skippedLocal`: the number of tasks dropped client-side
// (malformed element, missing column_name, or empty title). Pass-through bodies
// are not regrouped here, so their local-drop count is 0.
export function buildImportBody(raw: string): {
  body: unknown;
  skippedLocal: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("That file isn't valid JSON.");
  }

  // 1 & 2: already a server-ready columns body — pass through unchanged.
  if (hasColumnsArray(parsed) || hasProjectColumnsArray(parsed)) {
    return { body: parsed, skippedLocal: 0 };
  }

  // 3: flat CSK export — regroup by column_name.
  if (
    parsed &&
    typeof parsed === "object" &&
    Array.isArray((parsed as { tasks?: unknown }).tasks)
  ) {
    const tasks = (parsed as { tasks: unknown[] }).tasks;
    const { body, skippedNoColumnName } = groupFlatTasks(tasks);
    // If nothing survived the transform there's nothing to send. Throw a
    // friendly i18n-keyed Error so the modal can render a clear message.
    if (body.columns.length === 0) {
      throw new Error(IMPORT_EMPTY);
    }
    return { body, skippedLocal: skippedNoColumnName };
  }

  // 4: nothing we recognize.
  throw new Error(
    "Unrecognized file format. Expected a CSK task export or a {columns:[…]} import file.",
  );
}

// The server's ImportResult plus `skipped_local`: tasks dropped client-side
// during the flat-export transform (malformed element / no column_name / empty
// title) and never sent to the backend. The server's own counts only cover
// tasks it received, so this is the only place that number is visible.
export interface ImportOutcome extends ImportResult {
  skipped_local: number;
}

// Pick a JSON file, transform it, and import its tasks into `projectId`. Returns
// the server's ImportResult (merged with `skipped_local`), or `null` if the user
// cancelled the file dialog. `projectName` is accepted for symmetry with the
// export flow and to keep the call site self-describing; the server matches
// columns by name, not project name. Throws friendly Errors for bad JSON /
// unrecognized shape / nothing to import, and rejects (structured TrelloError
// string) for backend failures — both surfaced by the import modal.
export async function importTasksFromFile(
  projectId: string,
  _projectName: string | null,
): Promise<ImportOutcome | null> {
  if (!IS_TAURI) throw new Error(NOT_AVAILABLE);

  const path = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "JSON", extensions: ["json"] }],
  });
  // `open` returns null on cancel (and never an array here — multiple is false).
  if (!path || typeof path !== "string") return null;

  const raw = await invoke<string>("read_text_file", { path });
  const { body, skippedLocal } = buildImportBody(raw);

  const result = await trelloImportTasks(projectId, body);
  return { ...result, skipped_local: skippedLocal };
}
