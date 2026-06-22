//! `#[tauri::command]` glue layer for the Trello module.
//!
//! Every command:
//!  1. Acquires the shared `CLIENT` (or returns `NotConfigured`).
//!  2. Generates an `Idempotency-Key` UUIDv4 for write commands if the
//!     caller did not provide one.
//!  3. Maps `TrelloError` → structured-JSON string so the frontend can
//!     `JSON.parse(err)` to discriminate variants.

use chrono::Utc;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use super::client::TrelloClient;
use super::error::TrelloError;
use super::storage::{self, TrelloConfig};
use super::subscriber;
use super::types::{
    ChangesPage, Column, CompleteOutcome, CompleteTaskBody, CreateTaskPayload, ImportResult, Member,
    MoveTaskBody, Page, PatchTaskPayload, Profile, Project, ProjectsFilter, Task, TasksFilter,
};
use super::{CLIENT, DEFAULT_BASE_URL, SUBSCRIBER};

/// Helper — pull a clone of the configured client or surface NotConfigured.
fn get_client() -> Result<TrelloClient, String> {
    let guard = CLIENT
        .lock()
        .map_err(|e| TrelloError::Io(format!("client mutex poisoned: {e}")).to_frontend_string())?;
    (*guard)
        .clone()
        .ok_or_else(|| TrelloError::NotConfigured.to_frontend_string())
}

/// Helper — generate or pass through an idempotency key.
fn idem_or_new(idem: Option<String>) -> String {
    idem.unwrap_or_else(|| Uuid::new_v4().to_string())
}

/// Helper — collapse `TrelloError` into the structured-JSON string.
fn map_err(e: TrelloError) -> String {
    e.to_frontend_string()
}

// ----------------------- Configuration & lifecycle -----------------------

/// Configure the client, persist to disk, and verify with `/me`.
///
/// If `base_url` is `None`, falls back to the default production URL.
/// Returns the profile so the UI can show "logged in as …".
#[tauri::command]
pub async fn trello_configure(
    api_key: String,
    base_url: Option<String>,
) -> Result<Profile, String> {
    let url = base_url.unwrap_or_else(|| DEFAULT_BASE_URL.to_string());
    let client = TrelloClient::new(&url, api_key.clone()).map_err(map_err)?;

    // Smoke test before persisting — refuse to write a bad key to disk.
    let profile = client.me().await.map_err(map_err)?;

    // Preserve cursor/watched_projects if config already existed.
    let prev = storage::load().map_err(map_err)?;
    let cfg = TrelloConfig {
        api_key,
        base_url: url,
        last_seen_cursor: prev.as_ref().and_then(|c| c.last_seen_cursor.clone()),
        watched_project_ids: prev
            .as_ref()
            .map(|c| c.watched_project_ids.clone())
            .unwrap_or_default(),
        poll_interval_secs: prev.map(|c| c.poll_interval_secs).unwrap_or(1),
    };
    storage::save(&cfg).map_err(map_err)?;

    // Swap into the global slot.
    if let Ok(mut guard) = CLIENT.lock() {
        *guard = Some(client);
    }

    Ok(profile)
}

/// Re-hydrate the client from `~/.claude/trello.json` on app boot. Returns
/// `true` if a client was loaded, `false` if no config existed. Errors only
/// for I/O problems — a missing file is not an error.
#[tauri::command]
pub async fn trello_load_persisted() -> Result<bool, String> {
    let Some(cfg) = storage::load().map_err(map_err)? else {
        return Ok(false);
    };
    let client = TrelloClient::new(&cfg.base_url, cfg.api_key).map_err(map_err)?;
    if let Ok(mut guard) = CLIENT.lock() {
        *guard = Some(client);
    }
    Ok(true)
}

/// Stop the subscriber, drop the client, and delete the on-disk config.
#[tauri::command]
pub async fn trello_clear_config() -> Result<(), String> {
    // Snatch the handle without holding the lock across await.
    let handle = SUBSCRIBER.lock().ok().and_then(|mut g| g.take());
    subscriber::stop(handle).await;

    if let Ok(mut guard) = CLIENT.lock() {
        *guard = None;
    }
    storage::clear().map_err(map_err)?;
    Ok(())
}

// ----------------------- Read endpoints -----------------------

#[tauri::command]
pub async fn trello_me() -> Result<Profile, String> {
    let c = get_client()?;
    c.me().await.map_err(map_err)
}

#[tauri::command]
pub async fn trello_list_projects(
    filter: Option<ProjectsFilter>,
) -> Result<Page<Project>, String> {
    let c = get_client()?;
    c.projects(&filter.unwrap_or_default()).await.map_err(map_err)
}

#[tauri::command]
pub async fn trello_get_project(id: String) -> Result<Project, String> {
    let c = get_client()?;
    c.project(&id).await.map_err(map_err)
}

#[tauri::command]
pub async fn trello_list_columns(project_id: String) -> Result<Vec<Column>, String> {
    let c = get_client()?;
    c.columns(&project_id).await.map_err(map_err)
}

#[tauri::command]
pub async fn trello_list_members(project_id: String) -> Result<Vec<Member>, String> {
    let c = get_client()?;
    c.members(&project_id).await.map_err(map_err)
}

#[tauri::command]
pub async fn trello_list_tasks(filter: Option<TasksFilter>) -> Result<Page<Task>, String> {
    let c = get_client()?;
    c.tasks(&filter.unwrap_or_default()).await.map_err(map_err)
}

#[tauri::command]
pub async fn trello_get_task(id: String) -> Result<Task, String> {
    let c = get_client()?;
    c.task(&id).await.map_err(map_err)
}

// ----------------------- Write endpoints -----------------------

#[tauri::command]
pub async fn trello_create_task(
    payload: CreateTaskPayload,
    idempotency_key: Option<String>,
) -> Result<Task, String> {
    let c = get_client()?;
    let key = idem_or_new(idempotency_key);
    c.create_task(&payload, Some(&key)).await.map_err(map_err)
}

#[tauri::command]
pub async fn trello_patch_task(
    id: String,
    payload: PatchTaskPayload,
    idempotency_key: Option<String>,
) -> Result<Task, String> {
    let c = get_client()?;
    let key = idem_or_new(idempotency_key);
    c.patch_task(&id, &payload, Some(&key)).await.map_err(map_err)
}

#[tauri::command]
pub async fn trello_move_task(
    id: String,
    body: MoveTaskBody,
    idempotency_key: Option<String>,
) -> Result<Task, String> {
    let c = get_client()?;
    let key = idem_or_new(idempotency_key);
    c.move_task(&id, &body, Some(&key)).await.map_err(map_err)
}

#[tauri::command]
pub async fn trello_complete_task(
    id: String,
    body: Option<CompleteTaskBody>,
    idempotency_key: Option<String>,
) -> Result<CompleteOutcome, String> {
    let c = get_client()?;
    let key = idem_or_new(idempotency_key);
    c.complete_task(&id, &body.unwrap_or_default(), Some(&key))
        .await
        .map_err(map_err)
}

/// Delete a task. If the caller passes an `idempotency_key`, we swallow 404
/// (the documented replay-safe behavior). Without a key, a 404 is propagated.
#[tauri::command]
pub async fn trello_delete_task(
    id: String,
    idempotency_key: Option<String>,
) -> Result<(), String> {
    let c = get_client()?;
    let had_key = idempotency_key.is_some();
    let key = idem_or_new(idempotency_key);
    match c.delete_task(&id, Some(&key)).await {
        Ok(()) => Ok(()),
        Err(TrelloError::Http { status: 404, .. }) if had_key => Ok(()),
        Err(e) => Err(map_err(e)),
    }
}

#[tauri::command]
pub async fn trello_changes(
    since: String,
    project_id: Option<String>,
    limit: Option<u32>,
) -> Result<ChangesPage, String> {
    let c = get_client()?;
    c.changes(&since, project_id.as_deref(), limit)
        .await
        .map_err(map_err)
}

/// Bulk-import a `{ columns: [...] }` body into a project. The frontend builds
/// and validates the body (regrouping the flat CSK export); we pass it through
/// opaque. No idempotency key — the endpoint is NOT idempotent, so re-running
/// duplicates tasks (the UI warns the user).
#[tauri::command]
pub async fn trello_import_tasks(
    project_id: String,
    body: serde_json::Value,
) -> Result<ImportResult, String> {
    let c = get_client()?;
    c.import_tasks(&project_id, body).await.map_err(map_err)
}

// ----------------------- Subscriber lifecycle -----------------------

/// Start the poll loop for `project_ids`. If already running, the previous
/// handle is stopped first (so swapping the watched set is one call).
#[tauri::command]
pub async fn trello_start_subscriber(
    app: AppHandle,
    project_ids: Vec<String>,
) -> Result<(), String> {
    // Stop any prior subscriber first.
    let prior = SUBSCRIBER.lock().ok().and_then(|mut g| g.take());
    subscriber::stop(prior).await;

    let cfg = storage::load().map_err(map_err)?.ok_or_else(|| {
        TrelloError::InvalidConfig("no trello.json on disk — configure first".to_string())
            .to_frontend_string()
    })?;

    // Seed cursor: previously-seen cursor, or "an hour ago" so the first run
    // doesn't replay weeks of events.
    let initial_cursor = cfg.last_seen_cursor.clone().unwrap_or_else(|| {
        let since = Utc::now() - chrono::Duration::hours(1);
        since.to_rfc3339()
    });

    // Persist the watched set so the UI survives restarts.
    let mut updated = cfg.clone();
    updated.watched_project_ids = project_ids.clone();
    storage::save(&updated).map_err(map_err)?;

    let handle = subscriber::start(
        app.clone(),
        project_ids,
        // Clamp older saved configs (which defaulted to 5s/2s) down to the snappy
        // 1s so near-real-time applies without needing a reconnect.
        cfg.poll_interval_secs.min(1),
        initial_cursor,
    );

    if let Ok(mut guard) = SUBSCRIBER.lock() {
        *guard = Some(handle);
    }

    // Best-effort notify the UI it's live.
    let _ = app.emit("trello://subscriber-started", ());
    Ok(())
}

#[tauri::command]
pub async fn trello_stop_subscriber() -> Result<(), String> {
    let handle = SUBSCRIBER.lock().ok().and_then(|mut g| g.take());
    subscriber::stop(handle).await;
    Ok(())
}
