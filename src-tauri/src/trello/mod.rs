//! Trello equipo API client module.
//!
//! Implements PR#7 (TrelloClient + types + error mapping) and PR#8 (subscriber
//! polling loop + Tauri commands + on-disk config) for the Trello equipo API
//! (`https://trello-equipo.vercel.app/api/v1`).
//!
//! ## Architecture
//!
//! - `types` — DTOs serializable with serde. Match API snake_case verbatim.
//! - `error` — `TrelloError` enum with structured `Serialize` so the frontend
//!   receives JSON-shaped errors inside the `Result<T, String>` that Tauri
//!   commands return.
//! - `client` — `TrelloClient` struct wrapping `reqwest::Client`. One instance
//!   is shared via `CLIENT` (Lazy<Mutex<Option<...>>>) following the existing
//!   CSK convention.
//! - `storage` — Persists `TrelloConfig` to `~/.claude/trello.json`. Follows
//!   the CSK convention (same place as settings.json).
//! - `subscriber` — Background polling task over `/changes`, emits Tauri events.
//! - `commands` — `#[tauri::command]` glue layer.
//!
//! ## State management
//!
//! Two global statics following the existing CSK pattern:
//!  - `CLIENT`     — the configured `TrelloClient` (or None if not configured).
//!  - `SUBSCRIBER` — handle to the running poll loop (or None if stopped).
//!
//! We intentionally do NOT use `tauri::State<T>` because the rest of `lib.rs`
//! does not — keeping the convention uniform.

use once_cell::sync::Lazy;
use std::sync::Mutex;

pub mod client;
pub mod commands;
pub mod error;
pub mod storage;
pub mod subscriber;
pub mod types;

pub use client::TrelloClient;
pub use subscriber::SubscriberHandle;

/// Shared `TrelloClient` instance. `None` until `trello_configure` runs.
pub static CLIENT: Lazy<Mutex<Option<TrelloClient>>> = Lazy::new(|| Mutex::new(None));

/// Shared subscriber handle. `None` while the poll loop is stopped.
pub static SUBSCRIBER: Lazy<Mutex<Option<SubscriberHandle>>> = Lazy::new(|| Mutex::new(None));

/// Default base URL when the frontend does not override it.
pub const DEFAULT_BASE_URL: &str = "https://trello-equipo.vercel.app/api/v1";
