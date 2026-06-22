//! DTOs for the Trello equipo API. All shapes mirror the server payloads
//! verbatim (snake_case) so we never have to rename at the boundary.

use serde::{Deserialize, Serialize};

/// User profile returned by `GET /me`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub id: String,
    pub email: String,
    pub name: String,
    pub avatar_url: Option<String>,
}

/// A project visible to the API key holder.
///
/// `status` is kept as `String` (not enum) because the API may add new values
/// (`archived`, …) without us redeploying. The frontend decides the UX.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub status: String,
    pub created_by: String,
    pub supervisor_id: Option<String>,
    pub created_at: String,
    pub completed_at: Option<String>,
}

/// A column inside a project. Position is `f64` to preserve fractional drag
/// orderings.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Column {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub position: f64,
    pub created_at: String,
}

/// A person who is part of a project (`GET /projects/{id}/members`). `name`
/// and `avatar_url` are nullable on the wire (placeholder profiles). `role` is
/// kept as `String` (not enum) so a new role won't break deserialization.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Member {
    pub id: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub role: String,
}

/// Expanded profile embedded inside a task's `assignees` / `supervisors`
/// arrays (`GET /tasks`, `POST /tasks`, `PATCH /tasks/{id}`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskProfile {
    pub id: String,
    pub name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
}

/// A task in a column. Mirrors the API shape exactly.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Task {
    pub id: String,
    pub column_id: String,
    pub project_id: String,
    pub title: String,
    pub details: Option<String>,
    pub flow: Option<String>,
    pub task_date: Option<String>,
    pub progress: i32,
    pub position: f64,
    pub created_by: String,
    pub assignee_ids: Vec<String>,
    pub supervisor_ids: Vec<String>,
    /// Expanded assignee profiles. Older API responses may omit this field.
    #[serde(default)]
    pub assignees: Vec<TaskProfile>,
    /// Expanded supervisor profiles. Older API responses may omit this field.
    #[serde(default)]
    pub supervisors: Vec<TaskProfile>,
    pub comment_count: i64,
    pub completed_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

/// Pagination metadata. Cursors are opaque base64url strings; we never inspect.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pagination {
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub limit: u32,
}

/// Generic list envelope `{ data, pagination }`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page<T> {
    pub data: Vec<T>,
    pub pagination: Pagination,
}

/// Wrapper used by `/projects/{id}/columns` which returns `{ data }` without
/// pagination. The client surface aplana esto a `Vec<Column>`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ListEnvelope<T> {
    pub data: Vec<T>,
}

/// A change event from `GET /changes`. `payload` varies per `event_type`, the
/// frontend narrows it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangeEvent {
    pub id: String,
    /// `type` is a Rust keyword — rename for serde while keeping `event_type`
    /// in our public surface.
    #[serde(rename = "type")]
    pub event_type: String,
    pub project_id: String,
    pub occurred_at: String,
    pub payload: serde_json::Value,
}

/// `GET /changes` envelope: includes `server_time` so callers can advance the
/// cursor without parsing each event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChangesPage {
    pub data: Vec<ChangeEvent>,
    pub pagination: Pagination,
    pub server_time: String,
}

/// Filter for `GET /projects`. Empty options are skipped so reqwest does not
/// emit `?status=&limit=&cursor=` with empty values.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct ProjectsFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// Filter for `GET /tasks`. `completed` is `Option<String>` (`"true"`/`"false"`)
/// to match the API which expects a string in the querystring.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct TasksFilter {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supervisor_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_min: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress_max: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_date_from: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_date_to: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cursor: Option<String>,
}

/// Body for `POST /tasks`. Fields are omitted when `None`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTaskPayload {
    pub column_id: String,
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_date: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supervisor_ids: Option<Vec<String>>,
}

/// Body for `PATCH /tasks/{id}`.
///
/// `Option<serde_json::Value>` per nullable field lets the frontend distinguish
/// "don't send" (`None`) from "set to null" (`Some(Value::Null)`) without
/// pulling `serde_with` for double-option helpers. Skipped on serialize when
/// `None`.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct PatchTaskPayload {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flow: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_date: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub column_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub assignee_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub supervisor_ids: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<serde_json::Value>,
}

/// Body for `POST /tasks/{id}/move`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoveTaskBody {
    pub column_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub position: Option<f64>,
}

/// Body for `POST /tasks/{id}/complete`. `force` only valid if actor is admin.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
pub struct CompleteTaskBody {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
}

/// Result of `POST /tasks/{id}/complete`. `requires_supervisor_approval` is
/// derived from the `X-Partial-Complete` response header.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompleteOutcome {
    pub task: Task,
    pub requires_supervisor_approval: bool,
}

/// Response metadata collected from outgoing requests (idempotency replay flag,
/// partial-complete flag). Not currently surfaced to the frontend except via
/// `CompleteOutcome`.
#[derive(Debug, Default, Clone)]
pub struct ResponseMeta {
    pub idempotent_replay: bool,
    pub partial_complete: Option<String>,
}

/// The API's error envelope: `{ "error": { "code", "message", "details" } }`.
#[derive(Debug, Clone, Deserialize)]
pub struct ApiErrorEnvelope {
    pub error: ApiErrorBody,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ApiErrorBody {
    pub code: String,
    pub message: String,
    #[serde(default)]
    pub details: Option<serde_json::Value>,
}

/// Known error codes as `&'static str` constants. We keep `code` as `String`
/// in `TrelloError::Http` so unknown codes don't crash the deserializer.
pub mod api_error_code {
    pub const INVALID_KEY: &str = "invalid_key";
    pub const INVALID_QUERY: &str = "invalid_query";
    pub const INVALID_UUID: &str = "invalid_uuid";
    pub const CONFLICTING_FILTERS: &str = "conflicting_filters";
    pub const NOT_FOUND: &str = "not_found";
    pub const INTERNAL_ERROR: &str = "internal_error";
}
