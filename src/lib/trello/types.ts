// TypeScript mirror of the Rust DTOs in src-tauri/src/trello/types.rs.
//
// The Trello-equipo API (and the Rust serde structs that wrap it) use
// snake_case on the wire with NO `rename_all`, so these interfaces are
// snake_case verbatim — we never rename at the boundary. The only camelCase
// in this module lives in the *top-level* invoke() argument keys (see
// client.ts), which Tauri maps back to snake_case Rust params.

export interface Profile {
  id: string;
  email: string;
  name: string;
  avatar_url: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  // Kept as a plain string (not a union) because the API may add values
  // (`archived`, …) without us redeploying — the UI decides the treatment.
  status: string;
  created_by: string;
  supervisor_id: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface Column {
  id: string;
  project_id: string;
  name: string;
  // f64 on the Rust side — fractional so drag re-ordering can insert between.
  position: number;
  created_at: string;
}

// A person on a project (GET /projects/{id}/members). name/avatar_url are
// nullable on the wire; role is "member" | "supervisor".
export interface Member {
  id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
  role: string;
}

// Expanded profile embedded inside a task's assignees / supervisors arrays.
// Mirrors the TaskProfile Rust struct. email may be absent on older responses.
export interface TaskProfile {
  id: string;
  name: string | null;
  email: string | null;
  avatar_url: string | null;
}

export interface Task {
  id: string;
  column_id: string;
  project_id: string;
  title: string;
  details: string | null;
  flow: string | null;
  task_date: string | null;
  progress: number; // 0..100
  position: number;
  created_by: string;
  assignee_ids: string[];
  supervisor_ids: string[];
  // Expanded profiles. Absent on older API responses — default to empty array.
  assignees: TaskProfile[];
  supervisors: TaskProfile[];
  comment_count: number;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Pagination {
  next_cursor: string | null;
  has_more: boolean;
  limit: number;
}

export interface Page<T> {
  data: T[];
  pagination: Pagination;
}

// A change event from GET /changes. `type` is the discriminant (the Rust
// struct renames its `event_type` field back to `type` on serialize). The
// payload shape is NOT the Task DTO — it carries legacy fields — so callers
// must treat it as opaque and refetch rather than apply it directly.
export interface ChangeEvent {
  id: string;
  type: string; // e.g. "task.updated", "task.created", "task.moved"
  project_id: string;
  occurred_at: string;
  payload: unknown;
}

export interface ChangesPage {
  data: ChangeEvent[];
  pagination: Pagination;
  server_time: string;
}

// ----------------------- Request payloads / filters -----------------------

export interface ProjectsFilter {
  status?: string;
  limit?: number;
  cursor?: string;
}

export interface TasksFilter {
  project_id?: string;
  column_id?: string;
  assignee_id?: string;
  supervisor_id?: string;
  // The API wants the querystring value as a string ("true"/"false").
  completed?: string;
  progress_min?: number;
  progress_max?: number;
  task_date_from?: string;
  task_date_to?: string;
  limit?: number;
  cursor?: string;
}

export interface CreateTaskPayload {
  column_id: string;
  title: string;
  details?: string;
  flow?: string;
  task_date?: string;
  progress?: number;
  position?: number;
  assignee_ids?: string[];
  supervisor_ids?: string[];
}

// PATCH semantics mirror the Rust struct: a field left `undefined` is NOT
// sent; an explicit `null` clears the value server-side. We only model the
// fields the UI actually edits.
export interface PatchTaskPayload {
  title?: string;
  details?: string | null;
  flow?: string | null;
  task_date?: string | null;
  progress?: number;
  position?: number;
  column_id?: string;
  assignee_ids?: string[];
  supervisor_ids?: string[];
  completed_at?: string | null;
}

export interface MoveTaskBody {
  column_id: string;
  position?: number;
}

export interface CompleteTaskBody {
  // Only honored if the actor is an admin; otherwise the API may return a
  // partial complete that needs supervisor approval.
  force?: boolean;
}

export interface CompleteOutcome {
  task: Task;
  requires_supervisor_approval: boolean;
}

// Per-column tally inside an ImportResult (mirror of the Rust ImportByColumn).
export interface ImportByColumn {
  name: string;
  imported: number;
  skipped: number;
}

// Result of POST /projects/{id}/import (mirror of the Rust ImportResult). All
// counts are server-authoritative. `unmatched_columns` lists file column names
// the server could not match to a target column.
export interface ImportResult {
  imported: number;
  skipped_no_column: number;
  skipped_invalid: number;
  total_in_file: number;
  by_column: ImportByColumn[];
  unmatched_columns: string[];
}

// ----------------------- Errors -----------------------

// `kind` values exactly as the Rust custom Serialize impl emits them: lowercase
// flat/snake case, NOT the PascalCase Rust variant names. Typing this as a
// union (instead of bare string) stops a future `kind === "NotConfigured"`
// check from silently always being false. "Unknown" is added by the TS layer
// (toTrelloError) when the rejection isn't the structured envelope.
export type TrelloErrorKind =
  | "http"
  | "transport"
  | "decode"
  | "invalid_config"
  | "not_configured"
  | "io"
  | "Unknown";

// The Rust side emits a structured-JSON string for every error. We JSON.parse
// it (see client.ts `toTrelloError`) into this shape so the UI can branch on
// `kind` / `code` instead of matching on a freeform message.
export interface TrelloError {
  kind: TrelloErrorKind;
  status?: number;
  code?: string; // API error code, e.g. "invalid_key", "not_found"
  message: string;
  details?: unknown;
}

// Known API error codes (mirror of api_error_code in types.rs).
export const API_ERROR_CODE = {
  INVALID_KEY: "invalid_key",
  INVALID_QUERY: "invalid_query",
  INVALID_UUID: "invalid_uuid",
  CONFLICTING_FILTERS: "conflicting_filters",
  NOT_FOUND: "not_found",
  INTERNAL_ERROR: "internal_error",
} as const;
