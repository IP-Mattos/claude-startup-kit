// Typed wrapper over the 17 Trello `#[tauri::command]`s exposed by PR #45.
//
// Boundary rule (Tauri v2): TOP-LEVEL invoke argument keys are camelCase and
// Tauri maps them to the snake_case Rust params (projectId → project_id). But
// NESTED objects (payload / filter / body) are deserialized by serde using the
// struct's own casing — and those DTOs have no `rename_all`, so their fields
// stay snake_case. Our payload types in ./types.ts are already snake_case, so
// they pass straight through; only the wrapper's own arg keys are camelCase.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ChangesPage,
  Column,
  CompleteOutcome,
  CompleteTaskBody,
  CreateTaskPayload,
  Member,
  Page,
  PatchTaskPayload,
  Profile,
  Project,
  ProjectsFilter,
  MoveTaskBody,
  Task,
  TasksFilter,
  TrelloError,
} from "./types";

// ----------------------- Error normalization -----------------------

// Every command rejects with a structured-JSON string. Parse it into the
// discriminated TrelloError; if parsing fails (unexpected throw), wrap it.
export function toTrelloError(e: unknown): TrelloError {
  if (typeof e === "string") {
    try {
      const parsed = JSON.parse(e);
      if (parsed && typeof parsed === "object" && "message" in parsed) {
        return parsed as TrelloError;
      }
    } catch {
      /* not JSON — fall through */
    }
    return { kind: "Unknown", message: e };
  }
  if (e instanceof Error) return { kind: "Unknown", message: e.message };
  return { kind: "Unknown", message: String(e) };
}

// Human-readable, language-agnostic one-liner for an error. The view layer can
// still branch on err.kind / err.code for special handling — mind the wire
// casing: kind === "not_configured" → show the config screen; code ===
// "invalid_key" → prompt re-auth.
export function trelloErrorMessage(e: unknown): string {
  const err = toTrelloError(e);
  return err.code ? `${err.message} (${err.code})` : err.message;
}

// ----------------------- Config & lifecycle -----------------------

export function trelloConfigure(
  apiKey: string,
  baseUrl?: string,
): Promise<Profile> {
  return invoke<Profile>("trello_configure", { apiKey, baseUrl });
}

export function trelloLoadPersisted(): Promise<boolean> {
  return invoke<boolean>("trello_load_persisted");
}

export function trelloClearConfig(): Promise<void> {
  return invoke<void>("trello_clear_config");
}

// ----------------------- Reads -----------------------

export function trelloMe(): Promise<Profile> {
  return invoke<Profile>("trello_me");
}

export function trelloListProjects(filter?: ProjectsFilter): Promise<Page<Project>> {
  return invoke<Page<Project>>("trello_list_projects", { filter });
}

export function trelloGetProject(id: string): Promise<Project> {
  return invoke<Project>("trello_get_project", { id });
}

export function trelloListColumns(projectId: string): Promise<Column[]> {
  return invoke<Column[]>("trello_list_columns", { projectId });
}

export function trelloListMembers(projectId: string): Promise<Member[]> {
  return invoke<Member[]>("trello_list_members", { projectId });
}

export function trelloListTasks(filter?: TasksFilter): Promise<Page<Task>> {
  return invoke<Page<Task>>("trello_list_tasks", { filter });
}

export function trelloGetTask(id: string): Promise<Task> {
  return invoke<Task>("trello_get_task", { id });
}

// ----------------------- Writes -----------------------
// `idempotencyKey` is optional — the Rust side mints a UUIDv4 when omitted.
// We pass one explicitly for mutations the UI may retry, so a replay is safe.

export function trelloCreateTask(
  payload: CreateTaskPayload,
  idempotencyKey?: string,
): Promise<Task> {
  return invoke<Task>("trello_create_task", { payload, idempotencyKey });
}

export function trelloPatchTask(
  id: string,
  payload: PatchTaskPayload,
  idempotencyKey?: string,
): Promise<Task> {
  return invoke<Task>("trello_patch_task", { id, payload, idempotencyKey });
}

export function trelloMoveTask(
  id: string,
  body: MoveTaskBody,
  idempotencyKey?: string,
): Promise<Task> {
  return invoke<Task>("trello_move_task", { id, body, idempotencyKey });
}

export function trelloCompleteTask(
  id: string,
  body?: CompleteTaskBody,
  idempotencyKey?: string,
): Promise<CompleteOutcome> {
  return invoke<CompleteOutcome>("trello_complete_task", {
    id,
    body,
    idempotencyKey,
  });
}

export function trelloDeleteTask(
  id: string,
  idempotencyKey?: string,
): Promise<void> {
  return invoke<void>("trello_delete_task", { id, idempotencyKey });
}

export function trelloChanges(
  since: string,
  projectId?: string,
  limit?: number,
): Promise<ChangesPage> {
  return invoke<ChangesPage>("trello_changes", { since, projectId, limit });
}

// ----------------------- Subscriber lifecycle -----------------------

export function trelloStartSubscriber(projectIds: string[]): Promise<void> {
  return invoke<void>("trello_start_subscriber", { projectIds });
}

export function trelloStopSubscriber(): Promise<void> {
  return invoke<void>("trello_stop_subscriber");
}

// ----------------------- Live events -----------------------

export const TRELLO_EVENT = {
  CHANGES: "trello://changes",
  CHANGES_LAG: "trello://changes-lag",
  CHANGES_ERROR: "trello://changes-error",
  AUTH_ERROR: "trello://auth-error",
  STORAGE_ERROR: "trello://storage-error",
  SUBSCRIBER_STARTED: "trello://subscriber-started",
} as const;

export interface TrelloEventHandlers {
  onChanges?: (page: ChangesPage) => void;
  onLag?: (serverTime: string) => void;
  onChangesError?: (message: string) => void;
  onAuthError?: (message: string) => void;
  onStorageError?: (message: string) => void;
  onStarted?: () => void;
}

// Wire every backend event in one call; returns a single unlisten that tears
// them all down. Used by the board hook on mount.
export async function subscribeTrelloEvents(
  handlers: TrelloEventHandlers,
): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];
  const add = async <T>(name: string, cb?: (payload: T) => void) => {
    if (!cb) return;
    unlisteners.push(await listen<T>(name, (e) => cb(e.payload)));
  };

  await Promise.all([
    add<ChangesPage>(TRELLO_EVENT.CHANGES, handlers.onChanges),
    add<string>(TRELLO_EVENT.CHANGES_LAG, handlers.onLag),
    add<string>(TRELLO_EVENT.CHANGES_ERROR, handlers.onChangesError),
    add<string>(TRELLO_EVENT.AUTH_ERROR, handlers.onAuthError),
    add<string>(TRELLO_EVENT.STORAGE_ERROR, handlers.onStorageError),
    add<void>(TRELLO_EVENT.SUBSCRIBER_STARTED, handlers.onStarted),
  ]);

  return () => {
    for (const u of unlisteners) {
      try {
        u();
      } catch {
        /* already torn down */
      }
    }
  };
}
