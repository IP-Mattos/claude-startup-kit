//! Background poll loop over `GET /changes`.
//!
//! We poll instead of subscribing to SSE because the `/events` endpoint is
//! still marked `mock = true` upstream. Polling is also more robust for our
//! current fan-out pattern (CSK already uses semaphores for parallel work).
//!
//! Lifecycle:
//!   1. `start(app, project_ids, interval, initial_cursor)` spawns a tokio task.
//!   2. Each tick the task pulls `/changes?since={cursor}` and emits
//!      `trello://changes` (plus error events) via Tauri.
//!   3. `stop()` signals the task via an mpsc channel; the task drains, exits,
//!      and the handle is dropped.

use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;
use tokio::time::sleep;

use super::client::TrelloClient;
use super::error::TrelloError;
use super::storage;
use super::CLIENT;

/// Handle for the running subscriber task. Dropping it does NOT stop the task —
/// call `subscriber::stop()` first to signal a clean shutdown.
pub struct SubscriberHandle {
    pub join: JoinHandle<()>,
    pub stop_tx: mpsc::Sender<()>,
}

/// Floor for the poll interval, so a misconfigured config can't DoS the API.
/// The upstream API now tolerates 1s polling, so that's the snappy floor.
const MIN_POLL_INTERVAL_SECS: u64 = 1;
/// Cap for exponential backoff after errors.
const MAX_BACKOFF_SECS: u64 = 60;
/// Page size when draining `/changes`.
const PAGE_LIMIT: u32 = 200;

/// Spawn the polling task. Caller is responsible for storing the returned
/// handle in `SUBSCRIBER` (or whatever state slot).
pub fn start(
    app: AppHandle,
    project_ids: Vec<String>,
    interval_secs: u64,
    initial_cursor: String,
) -> SubscriberHandle {
    let (stop_tx, mut stop_rx) = mpsc::channel::<()>(1);
    let interval = Duration::from_secs(interval_secs.max(MIN_POLL_INTERVAL_SECS));

    let join = tokio::spawn(async move {
        let mut cursor = initial_cursor;
        let mut backoff = interval;

        loop {
            // Take a snapshot of the client. We pull on every iteration so
            // re-configuring the credentials between ticks is picked up.
            // Clone the inner `TrelloClient` (reqwest is Arc internally) and
            // drop the guard immediately to avoid holding the lock across await.
            let client_opt = CLIENT.lock().ok().and_then(|g| (*g).clone());
            let Some(client) = client_opt else {
                // Not configured yet — wait and retry.
                tokio::select! {
                    _ = stop_rx.recv() => return,
                    _ = sleep(interval) => continue,
                }
            };

            match poll_once(&client, &project_ids, &cursor, &app).await {
                Ok(Some(new_cursor)) => {
                    cursor = new_cursor;
                    backoff = interval; // reset on success
                    // Persist best-effort. Failure to persist isn't fatal —
                    // we'll just re-poll the same window after restart.
                    if let Err(e) = storage::update_cursor(&cursor) {
                        let _ = app.emit("trello://storage-error", e.to_frontend_string());
                    }
                }
                Ok(None) => {
                    backoff = interval; // no new events, but the tick succeeded
                }
                Err(e) => {
                    // Stop hard on auth errors — the api_key is wrong and
                    // retrying just spams the server.
                    if let TrelloError::Http { status: 401, .. } = &e {
                        let _ = app.emit("trello://auth-error", e.to_frontend_string());
                        return;
                    }

                    let _ = app.emit("trello://changes-error", e.to_frontend_string());

                    // Exponential backoff with cap.
                    backoff = std::cmp::min(
                        Duration::from_secs(MAX_BACKOFF_SECS),
                        backoff.saturating_mul(2),
                    );
                }
            }

            // Wait either for the next tick or a stop signal.
            tokio::select! {
                _ = stop_rx.recv() => return,
                _ = sleep(backoff) => {}
            }
        }
    });

    SubscriberHandle { join, stop_tx }
}

/// Signal the running subscriber to stop and `await` its join. Idempotent
/// (no-op if there isn't one).
pub async fn stop(handle: Option<SubscriberHandle>) {
    if let Some(h) = handle {
        // Channel may already be closed if the task died — ignore that.
        let _ = h.stop_tx.send(()).await;
        let _ = h.join.await;
    }
}

/// One polling iteration. Single request per project (NO within-tick
/// pagination — the server API's `since=ISO_8601` is exclusive and
/// `pagination.next_cursor` is opaque base64 not accepted as input).
///
/// Trade-off: bursts of >PAGE_LIMIT events within one polling window are
/// drained across subsequent ticks. Each tick uses `server_time` as the
/// new global cursor for the next call. If `has_more=true`, we emit a
/// `trello://changes-lag` event so the frontend can hint the user that
/// catchup will continue.
///
/// Returns:
///   - `Ok(Some(server_time))` if at least one project returned events.
///   - `Ok(None)` if the tick succeeded but no events arrived.
///   - `Err(_)` for any HTTP / transport / decode failure.
async fn poll_once(
    client: &TrelloClient,
    project_ids: &[String],
    cursor: &str,
    app: &AppHandle,
) -> Result<Option<String>, TrelloError> {
    let mut new_cursor: Option<String> = None;
    let mut any_emitted = false;

    let projects: Vec<Option<&str>> = if project_ids.is_empty() {
        vec![None]
    } else {
        project_ids.iter().map(|s| Some(s.as_str())).collect()
    };

    for pid in projects {
        let page = client
            .changes(cursor, pid, Some(PAGE_LIMIT))
            .await?;
        if !page.data.is_empty() {
            any_emitted = true;
            let _ = app.emit("trello://changes", &page);
        }
        if page.pagination.has_more {
            // Hint the frontend so it can show "syncing…" UI; next tick
            // will fetch the next batch starting from server_time.
            let _ = app.emit("trello://changes-lag", &page.server_time);
        }
        new_cursor = Some(page.server_time.clone());
    }

    Ok(if any_emitted { new_cursor } else { None })
}
