//! Persists `TrelloConfig` to `~/.claude/trello.json`.
//!
//! We follow the existing CSK convention (see `lib.rs::dirs_home`, the
//! `.claude/` directory, and `load_settings`) rather than `tauri::api::path::app_data_dir`,
//! to keep config in one place.
//!
//! Security note: this is plaintext on disk, same as CSK's other config.
//! TODO: migrate secrets to tauri-plugin-stronghold or platform keyring
//! (DPAPI on Windows, Keychain on macOS) before shipping to multi-tenant.

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use super::error::TrelloError;

const CONFIG_FILENAME: &str = "trello.json";

/// Local on-disk configuration for the Trello client.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TrelloConfig {
    pub api_key: String,
    pub base_url: String,
    #[serde(default)]
    pub last_seen_cursor: Option<String>,
    #[serde(default)]
    pub watched_project_ids: Vec<String>,
    #[serde(default = "default_poll_interval")]
    pub poll_interval_secs: u64,
}

fn default_poll_interval() -> u64 {
    // Snappy near-real-time. The subscriber floors this at MIN_POLL_INTERVAL_SECS.
    1
}

/// Resolve `$HOME` (or `$USERPROFILE` on Windows).
fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

/// Resolve `~/.claude/trello.json`. Creates `~/.claude/` if it does not exist
/// yet (so first-run `trello_configure` works on a fresh box).
pub fn config_path() -> Result<PathBuf, TrelloError> {
    let home = dirs_home().ok_or_else(|| {
        TrelloError::InvalidConfig("cannot resolve $HOME or $USERPROFILE".to_string())
    })?;
    let claude_dir = home.join(".claude");
    if !claude_dir.exists() {
        fs::create_dir_all(&claude_dir).map_err(|e| {
            TrelloError::Io(format!("create_dir_all {}: {e}", claude_dir.display()))
        })?;
    }
    Ok(claude_dir.join(CONFIG_FILENAME))
}

/// Load the config from disk. Returns `Ok(None)` if the file does not exist,
/// `Err(...)` if the file exists but cannot be parsed.
///
/// On Unix, also validates that file mode is owner-only (0o600 / 0o400).
/// World/group-readable means the bearer token leaked to other users on the
/// machine — we refuse to load and force the user to re-create with safe
/// perms via `trello_configure`.
pub fn load() -> Result<Option<TrelloConfig>, TrelloError> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(None);
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let meta = fs::metadata(&path)
            .map_err(|e| TrelloError::Io(format!("stat {}: {e}", path.display())))?;
        let mode = meta.permissions().mode() & 0o777;
        // Bits group/other (mask 0o077) must be zero — owner-only access.
        if mode & 0o077 != 0 {
            return Err(TrelloError::Io(format!(
                "{} tiene permisos {:o} (debe ser 600 — re-creá la config con trello_configure)",
                path.display(),
                mode
            )));
        }
    }

    let text = fs::read_to_string(&path)
        .map_err(|e| TrelloError::Io(format!("read {}: {e}", path.display())))?;
    let cfg: TrelloConfig = serde_json::from_str(&text)?;
    Ok(Some(cfg))
}

/// Write `cfg` atomically. We write to `trello.json.tmp` then rename so a
/// crash mid-write does not corrupt the existing file.
pub fn save(cfg: &TrelloConfig) -> Result<(), TrelloError> {
    let path = config_path()?;
    let tmp = path.with_extension("json.tmp");
    let json = serde_json::to_string_pretty(cfg)?;
    fs::write(&tmp, json).map_err(|e| TrelloError::Io(format!("write {}: {e}", tmp.display())))?;

    // Best-effort: lock down permissions on Unix. Windows inherits the ACL of
    // the parent ~/.claude/ directory (same as the rest of CSK).
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(&tmp) {
            let mut perms = meta.permissions();
            perms.set_mode(0o600);
            let _ = fs::set_permissions(&tmp, perms);
        }
    }

    fs::rename(&tmp, &path).map_err(|e| {
        TrelloError::Io(format!(
            "rename {} → {}: {e}",
            tmp.display(),
            path.display()
        ))
    })?;
    Ok(())
}

/// Delete the on-disk config (used by `trello_clear_config` for logout).
/// Missing file is treated as success.
pub fn clear() -> Result<(), TrelloError> {
    let path = config_path()?;
    if path.exists() {
        fs::remove_file(&path)
            .map_err(|e| TrelloError::Io(format!("remove {}: {e}", path.display())))?;
    }
    Ok(())
}

/// Persist a new cursor without touching the rest of the config. Reads, merges,
/// writes. No debounce yet — the subscriber loop runs at >=1s, so disk pressure
/// is bounded; we can add a debouncer later if it shows up in profiles.
pub fn update_cursor(cursor: &str) -> Result<(), TrelloError> {
    let Some(mut cfg) = load()? else {
        return Err(TrelloError::InvalidConfig(
            "no config on disk — cannot persist cursor".to_string(),
        ));
    };
    cfg.last_seen_cursor = Some(cursor.to_string());
    save(&cfg)
}
