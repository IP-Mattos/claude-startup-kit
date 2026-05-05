use chrono::{DateTime, Local, Utc};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

/// Build a `Command` that does NOT flash a console window on Windows.
///
/// Tauri is a GUI app, but every CLI subprocess (`gh`, `git`, `engram`, ...) it spawns
/// gets a `conhost.exe` window by default — visible as a brief flicker every time the
/// user navigates a tab. `CREATE_NO_WINDOW` (0x0800_0000) suppresses that.
/// On non-Windows targets this is a transparent no-op.
fn silent_command(program: &str) -> Command {
    let cmd = std::process::Command::new(program);
    #[cfg(target_os = "windows")]
    let mut cmd = cmd;
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[derive(Serialize, Clone)]
pub struct Project {
    pub path: String,
    pub mtime: u64,
    pub days_ago: u64,
    pub last_date: String,
}

fn claude_projects_dir() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".claude").join("projects"))
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

fn newest_jsonl_mtime(dir: &Path) -> Option<(SystemTime, Vec<PathBuf>)> {
    let mut jsonls: Vec<(SystemTime, PathBuf)> = fs::read_dir(dir)
        .ok()?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().extension().and_then(|s| s.to_str()) == Some("jsonl")
                && e.file_type().map(|t| t.is_file()).unwrap_or(false)
        })
        .filter_map(|e| {
            let m = e.metadata().ok()?.modified().ok()?;
            Some((m, e.path()))
        })
        .collect();
    if jsonls.is_empty() {
        return None;
    }
    jsonls.sort_by(|a, b| b.0.cmp(&a.0));
    let newest = jsonls[0].0;
    let paths = jsonls.into_iter().map(|(_, p)| p).collect();
    Some((newest, paths))
}

fn first_cwd_in_jsonls(paths: &[PathBuf]) -> Option<String> {
    for p in paths {
        let Ok(file) = File::open(p) else {
            continue;
        };
        let reader = BufReader::new(file);
        for line in reader.lines().map_while(Result::ok) {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if let Some(cwd) = val.get("cwd").and_then(|v| v.as_str()) {
                if !cwd.is_empty() {
                    return Some(cwd.to_string());
                }
            }
        }
    }
    None
}

/// Strip the Windows `\\?\` extended-length prefix that fs::canonicalize
/// returns on Windows, so the path round-trips cleanly through the IPC layer
/// and back into git/explorer/etc.
fn strip_unc_prefix(p: PathBuf) -> PathBuf {
    let s = p.to_string_lossy().to_string();
    if let Some(stripped) = s.strip_prefix(r"\\?\") {
        // Don't strip if it's an actual UNC share (\\?\UNC\server\share).
        if stripped.starts_with("UNC\\") {
            return p;
        }
        return PathBuf::from(stripped);
    }
    p
}

/// Files that mark a directory as a real "project" — at least one of these
/// has to exist for us to list the directory in the Projects tab. The list
/// is intentionally broad (covers JS/TS, Rust, Python, Go, Java, Ruby,
/// PHP, .NET, Flutter, Elixir) so legit projects across stacks survive,
/// while umbrella dirs (`Desktop`, `~`, `Documents`, etc.) that Claude Code
/// happens to track because the user opened a session there get filtered
/// out — those produce JSONLs but aren't navigable workspaces in VS Code.
const PROJECT_MARKERS: &[&str] = &[
    ".git",
    "package.json",
    "Cargo.toml",
    "pyproject.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    "build.gradle.kts",
    "composer.json",
    "Gemfile",
    "requirements.txt",
    "pubspec.yaml",
    "mix.exs",
    "tsconfig.json",
    "deno.json",
    ".project",       // Eclipse / Generic IDE marker
    "*.sln",          // Pattern handled below — checked separately
];

/// True if `dir` contains at least one project-marker file. The `*.sln`
/// pattern is handled separately because it requires a glob-style match.
fn has_project_marker(dir: &Path) -> bool {
    for marker in PROJECT_MARKERS {
        if *marker == "*.sln" {
            continue; // handled below
        }
        if dir.join(marker).exists() {
            return true;
        }
    }
    // *.sln (Visual Studio solution) — any file ending in `.sln` counts.
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) == Some("sln") {
                return true;
            }
        }
    }
    false
}

fn scan_projects_blocking(window_days: u64) -> Vec<Project> {
    let Some(root) = claude_projects_dir() else {
        return vec![];
    };
    if !root.exists() {
        return vec![];
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cutoff = now.saturating_sub(window_days * 86_400);

    let mut out: Vec<Project> = Vec::new();
    let Ok(entries) = fs::read_dir(&root) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some((newest, jsonls)) = newest_jsonl_mtime(&path) else {
            continue;
        };
        let mtime = newest
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        if mtime < cutoff {
            continue;
        }
        let Some(cwd) = first_cwd_in_jsonls(&jsonls) else {
            continue;
        };
        // Canonicalize: handles relative paths and \\?\ UNC prefixes coming
        // from older JSONL entries. Fall back to the raw cwd if canonicalize
        // fails (e.g. directory was removed but the JSONL still references it).
        let canonical = match fs::canonicalize(&cwd) {
            Ok(c) => strip_unc_prefix(c),
            Err(_) => PathBuf::from(&cwd),
        };
        if !canonical.is_dir() {
            continue;
        }
        // Filter out umbrella directories that aren't real projects. A path
        // like `C:\Users\darkm\OneDrive\Desktop` (or `~`) shows up here
        // because Claude Code recorded a session at that cwd, but opening it
        // in VS Code attaches the editor to the entire folder tree, which
        // breaks the Claude Code extension's per-workspace view. Require at
        // least one well-known project marker to consider this a workspace.
        if !has_project_marker(&canonical) {
            continue;
        }
        let canonical_str = canonical.to_string_lossy().to_string();
        let days_ago = (now.saturating_sub(mtime)) / 86_400;
        let last_date = DateTime::<Utc>::from_timestamp(mtime as i64, 0)
            .map(|d| d.with_timezone(&Local).format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        out.push(Project {
            path: canonical_str,
            mtime,
            days_ago,
            last_date,
        });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

#[tauri::command]
async fn scan_projects(window_days: u64) -> Result<Vec<Project>, String> {
    // Surface the join error rather than swallowing it as an empty list —
    // a panic in the blocking scan used to look indistinguishable from
    // "no projects on disk" in the UI.
    tokio::task::spawn_blocking(move || scan_projects_blocking(window_days))
        .await
        .map_err(|e| format!("scan_projects task join: {e}"))
}

#[derive(Serialize, Clone)]
pub struct CleanupItem {
    pub category: String,
    pub path: String,
    pub bytes: u64,
    pub mtime: u64,
}

fn dir_size(dir: &Path) -> u64 {
    let mut total = 0u64;
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    for e in entries.flatten() {
        let meta = match e.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        if meta.is_dir() {
            total += dir_size(&e.path());
        } else {
            total += meta.len();
        }
    }
    total
}

fn mtime_unix(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn cleanup_plan_blocking(older_than_days: u64) -> Vec<CleanupItem> {
    let Some(home) = dirs_home() else {
        return vec![];
    };
    let claude_dir = home.join(".claude");
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let cutoff = now.saturating_sub(older_than_days * 86_400);
    let mut plan = Vec::new();

    // 1. Logs (skip the active startup-kit.log)
    let logs_dir = claude_dir.join("logs");
    if let Ok(entries) = fs::read_dir(&logs_dir) {
        for e in entries.flatten() {
            let path = e.path();
            if !path.is_file() {
                continue;
            }
            if path.file_name().and_then(|s| s.to_str()) == Some("startup-kit.log") {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            let mtime = mtime_unix(&meta);
            if mtime < cutoff {
                plan.push(CleanupItem {
                    category: "logs".to_string(),
                    path: path.to_string_lossy().to_string(),
                    bytes: meta.len(),
                    mtime,
                });
            }
        }
    }

    // 2. Backups (directories older than cutoff)
    let backups_dir = claude_dir.join("backups");
    if let Ok(entries) = fs::read_dir(&backups_dir) {
        for e in entries.flatten() {
            let path = e.path();
            if !path.is_dir() {
                continue;
            }
            let Ok(meta) = e.metadata() else { continue };
            let mtime = mtime_unix(&meta);
            if mtime < cutoff {
                plan.push(CleanupItem {
                    category: "backups".to_string(),
                    path: path.to_string_lossy().to_string(),
                    bytes: dir_size(&path),
                    mtime,
                });
            }
        }
    }

    // 3. Old project JSONLs
    let projects_dir = claude_dir.join("projects");
    if let Ok(entries) = fs::read_dir(&projects_dir) {
        for e in entries.flatten() {
            let pdir = e.path();
            if !pdir.is_dir() {
                continue;
            }
            let Ok(jsonls) = fs::read_dir(&pdir) else {
                continue;
            };
            for jentry in jsonls.flatten() {
                let p = jentry.path();
                if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                    continue;
                }
                let Ok(meta) = jentry.metadata() else { continue };
                let mtime = mtime_unix(&meta);
                if mtime < cutoff {
                    plan.push(CleanupItem {
                        category: "projects".to_string(),
                        path: p.to_string_lossy().to_string(),
                        bytes: meta.len(),
                        mtime,
                    });
                }
            }
        }
    }

    plan.sort_by(|a, b| a.mtime.cmp(&b.mtime));
    plan
}

#[tauri::command]
async fn cleanup_plan(older_than_days: u64) -> Vec<CleanupItem> {
    tokio::task::spawn_blocking(move || cleanup_plan_blocking(older_than_days))
        .await
        .unwrap_or_default()
}

#[derive(Serialize)]
pub struct CleanupResult {
    pub deleted: u32,
    pub failed: u32,
    pub freed_bytes: u64,
    pub errors: Vec<String>,
}

#[tauri::command]
async fn cleanup_apply(paths: Vec<String>) -> CleanupResult {
    tokio::task::spawn_blocking(move || cleanup_apply_blocking(paths))
        .await
        .unwrap_or_else(|_| CleanupResult {
            deleted: 0,
            failed: 1,
            freed_bytes: 0,
            errors: vec!["task panicked".to_string()],
        })
}

fn cleanup_apply_blocking(paths: Vec<String>) -> CleanupResult {
    let mut deleted = 0u32;
    let mut failed = 0u32;
    let mut freed = 0u64;
    let mut errors = Vec::new();
    // Confine deletions to ~/.claude/{logs,backups,projects} to prevent a
    // malicious renderer from passing arbitrary paths via IPC.
    let claude_root = match dirs_home() {
        Some(h) => h.join(".claude"),
        None => {
            errors.push("home directory not resolvable".to_string());
            return CleanupResult {
                deleted: 0,
                failed: 1,
                freed_bytes: 0,
                errors,
            };
        }
    };
    // Pre-canonicalize the allowed roots so symlink shenanigans inside the
    // candidate path can't escape (e.g. a symlink under ~/.claude/logs that
    // points to C:\Windows). Canonicalize resolves all symlinks on Windows.
    let allowed_subdirs = ["logs", "backups", "projects"];
    let allowed_roots: Vec<PathBuf> = allowed_subdirs
        .iter()
        .filter_map(|sub| fs::canonicalize(claude_root.join(sub)).ok())
        .collect();

    for s in paths {
        let p = Path::new(&s);
        if !p.exists() {
            continue;
        }
        // Path confinement: must canonicalize INTO one of the allowed roots.
        let canonical = match p.canonicalize() {
            Ok(c) => c,
            Err(e) => {
                failed += 1;
                errors.push(format!("canonicalize {s}: {e}"));
                continue;
            }
        };
        let within = allowed_roots
            .iter()
            .any(|root| canonical.starts_with(root));
        if !within {
            failed += 1;
            errors.push(format!("refused (outside ~/.claude/): {s}"));
            continue;
        }
        // Use symlink_metadata to avoid following a symlink to compute size or
        // delete the target instead of the link itself.
        let Ok(meta) = fs::symlink_metadata(&canonical) else {
            failed += 1;
            errors.push(format!("metadata: {s}"));
            continue;
        };
        // Refuse to follow symlinks at all — delete only real files/dirs.
        if meta.file_type().is_symlink() {
            failed += 1;
            errors.push(format!("refused (symlink): {s}"));
            continue;
        }
        let bytes = if meta.is_dir() {
            dir_size(&canonical)
        } else {
            meta.len()
        };
        let res = if meta.is_dir() {
            fs::remove_dir_all(&canonical)
        } else {
            fs::remove_file(&canonical)
        };
        match res {
            Ok(_) => {
                deleted += 1;
                freed += bytes;
            }
            Err(e) => {
                failed += 1;
                errors.push(format!("{s}: {e}"));
            }
        }
    }
    CleanupResult {
        deleted,
        failed,
        freed_bytes: freed,
        errors,
    }
}

#[derive(Serialize, Clone)]
pub struct GhPullRequest {
    pub title: String,
    pub url: String,
    pub repository: String,
    pub author: String,
    pub created_at: String,
}

fn github_review_queue_blocking(limit: u32) -> Result<Vec<GhPullRequest>, String> {
    let limit_str = limit.to_string();
    let output = silent_command("gh")
        .args([
            "search",
            "prs",
            "--review-requested=@me",
            "--state=open",
            "--limit",
            &limit_str,
            "--json",
            "title,url,repository,author,createdAt",
        ])
        .output()
        .map_err(|e| format!("gh not available: {e}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("authentication required") || stderr.contains("not logged into") {
            return Err("gh not authenticated — run 'gh auth login'".to_string());
        }
        return Err(format!("gh failed: {}", stderr.trim()));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let raw: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|e| format!("gh JSON parse: {e}"))?;
    let arr = raw.as_array().ok_or("gh output is not an array")?;
    let prs = arr
        .iter()
        .map(|item| GhPullRequest {
            title: item
                .get("title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            url: item
                .get("url")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            repository: item
                .get("repository")
                .and_then(|r| r.get("nameWithOwner").or_else(|| r.get("name")))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            author: item
                .get("author")
                .and_then(|a| a.get("login"))
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            created_at: item
                .get("createdAt")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect();
    Ok(prs)
}

#[tauri::command]
async fn github_review_queue(limit: u32) -> Result<Vec<GhPullRequest>, String> {
    // 15s timeout: gh is normally subsecond; if it's stalling on auth or
    // network, surface that to the UI instead of hanging the panel forever.
    let fut = tokio::task::spawn_blocking(move || github_review_queue_blocking(limit));
    match tokio::time::timeout(Duration::from_secs(15), fut).await {
        Ok(Ok(res)) => res,
        Ok(Err(join_err)) => Err(format!("gh task join error: {join_err}")),
        Err(_) => Err("gh timed out after 15s".to_string()),
    }
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    // Strict scheme allowlist — no file://, javascript:, ftp:, data:, etc.
    let lc = url.trim().to_lowercase();
    let ok = lc.starts_with("http://") || lc.starts_with("https://");
    if !ok {
        return Err("only http(s) URLs are allowed".to_string());
    }
    // rundll32 doesn't re-interpret the URL string the way cmd.exe does
    // (avoids `&` becoming a command separator on PR query-string URLs).
    silent_command("rundll32")
        .args(["url.dll,FileProtocolHandler", &url])
        .spawn()
        .map_err(|e| format!("failed to open url: {e}"))?;
    Ok(())
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AuditAction {
    NavigateTo { tab: String },
    OpenInExplorer { path: String },
    OpenInVscode { path: String },
    KillProcess { pid: u32 },
    DeleteFile { path: String },
    RestoreSettingsBackup,
}

#[derive(Serialize, Clone)]
pub struct AuditFinding {
    pub level: String,
    pub category: String,
    pub title: String,
    pub detail: String,
    pub action: Option<AuditAction>,
}

/// Resolve `~/.claude/<rel>` as a string path with the user's home directory
/// substituted. Returns empty string on failure (caller decides how to handle).
fn claude_path_string(rel: &str) -> String {
    dirs_home()
        .map(|h| h.join(".claude").join(rel).to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Best-effort scan for a Windows-style absolute path inside a free-form string.
/// Looks for `<drive-letter>:\` or `<drive-letter>:/` and grabs everything up to
/// the next quote, newline, or end of string. Returns None if no path is found.
fn extract_windows_path(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut i = 0;
    while i + 2 < bytes.len() {
        let c0 = bytes[i] as char;
        let c1 = bytes[i + 1];
        let c2 = bytes[i + 2];
        if c0.is_ascii_alphabetic() && c1 == b':' && (c2 == b'\\' || c2 == b'/') {
            // Make sure char before isn't another letter (avoid grabbing inside a longer token)
            if i > 0 {
                let prev = bytes[i - 1] as char;
                if prev.is_ascii_alphanumeric() {
                    i += 1;
                    continue;
                }
            }
            // Walk forward until we hit a terminator.
            let mut j = i;
            while j < bytes.len() {
                let ch = bytes[j];
                if ch == b'\n' || ch == b'\r' || ch == b'"' || ch == b'\'' {
                    break;
                }
                j += 1;
            }
            // Trim trailing punctuation like '.', ')', ',', whitespace.
            let mut end = j;
            while end > i {
                let c = bytes[end - 1];
                if c == b' ' || c == b'\t' || c == b'.' || c == b',' || c == b')' || c == b';' {
                    end -= 1;
                } else {
                    break;
                }
            }
            if end > i + 3 {
                return Some(s[i..end].to_string());
            }
        }
        i += 1;
    }
    None
}

/// Map a finding's `(category, title, detail)` triple to an optional follow-up
/// action the frontend can render as a "Fix" button. INFO-level findings are
/// filtered upstream — this function does not check level.
fn infer_action(category: &str, title: &str, detail: &str) -> Option<AuditAction> {
    match category {
        "DISK" => {
            if title.starts_with("~/.claude is over") {
                Some(AuditAction::NavigateTo {
                    tab: "cleanup".to_string(),
                })
            } else if title.starts_with("Large JSONL:") {
                // Try to extract a path from the title first, then the detail.
                let path = extract_windows_path(title).or_else(|| extract_windows_path(detail));
                match path {
                    Some(p) => Some(AuditAction::OpenInExplorer { path: p }),
                    None => Some(AuditAction::NavigateTo {
                        tab: "cleanup".to_string(),
                    }),
                }
            } else {
                None
            }
        }
        "PROCESSES" => {
            // Title shape: "<name> (PID <pid>) running for <h>h"
            if let Some(start) = title.find("(PID ") {
                let rest = &title[start + 5..];
                let end = rest.find(')').unwrap_or(rest.len());
                let pid_str = rest[..end].trim();
                if let Ok(pid) = pid_str.parse::<u32>() {
                    return Some(AuditAction::KillProcess { pid });
                }
            }
            None
        }
        "DRIFT" => {
            if title == "settings.local.json exists — overrides settings.json" {
                Some(AuditAction::OpenInVscode {
                    path: claude_path_string("settings.local.json"),
                })
            } else {
                None
            }
        }
        "HOOKS" => {
            if title.contains("settings.json invalid JSON") {
                Some(AuditAction::RestoreSettingsBackup)
            } else if title.starts_with("Hook timeout > 300s") {
                Some(AuditAction::OpenInVscode {
                    path: claude_path_string("settings.json"),
                })
            } else {
                None
            }
        }
        "PERMISSIONS" => {
            if title.starts_with("Allow rule matches risky pattern:") {
                Some(AuditAction::OpenInVscode {
                    path: claude_path_string("settings.json"),
                })
            } else {
                None
            }
        }
        "SCRIPTS" => {
            // Title shape: "Non-kit file in lib/: foo.ps1"
            let prefix_lib = "Non-kit file in lib/:";
            if let Some(rest) = title.strip_prefix(prefix_lib) {
                let filename = rest.trim();
                if !filename.is_empty() {
                    let full = claude_path_string(&format!("scripts/lib/{filename}"));
                    return Some(AuditAction::OpenInExplorer { path: full });
                }
            }
            // Title shape: "Non-kit file in ~/.claude/scripts/: foo.ps1"
            // Previously this finding was emitted at INFO level so push_finding
            // skipped action inference entirely — the "Resolver" button
            // never appeared. Now that audit_scripts emits it at WARN, route
            // it to OpenInExplorer like the lib/ sibling above.
            let prefix_scripts = "Non-kit file in ~/.claude/scripts/:";
            if let Some(rest) = title.strip_prefix(prefix_scripts) {
                let filename = rest.trim();
                if !filename.is_empty() {
                    let full = claude_path_string(&format!("scripts/{filename}"));
                    return Some(AuditAction::OpenInExplorer { path: full });
                }
            }
            None
        }
        "LOGS" => {
            if title.ends_with("ERROR entries in last 200 log lines") {
                Some(AuditAction::OpenInVscode {
                    path: claude_path_string("logs/startup-kit.log"),
                })
            } else {
                None
            }
        }
        _ => None,
    }
}

// =============================================================================
// AUDIT — native Rust port of legacy/scripts/claude-audit.ps1
// =============================================================================
// Each helper below corresponds to a numbered block in the legacy PS script.
// Helpers push findings into a shared Vec via &mut. Title strings MUST match
// the PS script verbatim where `infer_action()` keys off them — see comments
// at each call site.
// =============================================================================

/// Push a finding without an action (the action is inferred later, except for
/// INFO findings which never carry actions).
fn push_finding(out: &mut Vec<AuditFinding>, level: &str, category: &str, title: String, detail: String) {
    let action = if level == "INFO" {
        None
    } else {
        infer_action(category, &title, &detail)
    };
    out.push(AuditFinding {
        level: level.to_string(),
        category: category.to_string(),
        title,
        detail,
        action,
    });
}

/// 1. PROCESSES — long-running watched processes (engram/gentle-ai/claude/etc).
///
/// We shell out to PowerShell's `Get-Process` because pure-Rust process
/// enumeration with start times on Windows requires either a new dep
/// (e.g. `sysinfo`) or hand-rolled Win32 calls. The legacy script was
/// Windows-only too — same compromise.
fn audit_processes(out: &mut Vec<AuditFinding>) {
    // Names match the PS script's $watchedNames — keep in sync.
    let watched = ["Code", "gentle-ai", "engram", "powershell", "pwsh", "cmd", "claude"];
    let names_csv = watched
        .iter()
        .map(|n| format!("'{n}'"))
        .collect::<Vec<_>>()
        .join(",");
    // Emit one CSV-ish line per process: name|pid|ISO-start-time
    let script = format!(
        "$names = @({names}); foreach ($n in $names) {{ $ps = Get-Process -Name $n -ErrorAction SilentlyContinue; foreach ($p in $ps) {{ try {{ $st = $p.StartTime.ToString('o'); Write-Output ($n + '|' + $p.Id + '|' + $st) }} catch {{}} }} }}",
        names = names_csv
    );
    let output = match silent_command("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", &script])
        .output()
    {
        Ok(o) => o,
        Err(_) => return, // silent on transient PS failure — same as PS script's try/catch
    };
    if !output.status.success() {
        return;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let now = Utc::now();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let parts: Vec<&str> = line.splitn(3, '|').collect();
        if parts.len() != 3 {
            continue;
        }
        let name = parts[0];
        let pid_str = parts[1];
        let start_iso = parts[2];
        let Ok(start) = DateTime::parse_from_rfc3339(start_iso) else {
            continue;
        };
        let runtime = now.signed_duration_since(start.with_timezone(&Utc));
        let hours = runtime.num_hours();
        if hours > 48 {
            // VERBATIM TITLE — `infer_action` matches "(PID <pid>)" + "running for Xh".
            push_finding(
                out,
                "WARN",
                "PROCESSES",
                format!("{name} (PID {pid_str}) running for {hours}h"),
                "Long-running. If you don't recognize it, consider killing it.".to_string(),
            );
        } else if hours > 12 {
            push_finding(
                out,
                "INFO",
                "PROCESSES",
                format!("{name} (PID {pid_str}) running for {hours}h"),
                String::new(),
            );
        }
    }
}

/// Read settings.json into a serde_json::Value. Returns:
///   - Ok(Some(value))   — file exists and parsed
///   - Ok(None)          — file does not exist
///   - Err(message)      — file exists but is invalid JSON; message is the parse error
fn load_settings(claude_dir: &Path) -> Result<Option<serde_json::Value>, String> {
    let path = claude_dir.join("settings.json");
    if !path.exists() {
        return Ok(None);
    }
    let text = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| e.to_string())?;
    Ok(Some(v))
}

/// Iterate every hook entry in `settings.hooks.<event>[].hooks[]`. Calls `cb`
/// with `(event, type, command, timeout_or_None)`.
fn for_each_hook(
    settings: &serde_json::Value,
    mut cb: impl FnMut(&str, &str, &str, Option<i64>),
) {
    let Some(hooks_obj) = settings.get("hooks").and_then(|v| v.as_object()) else {
        return;
    };
    for (event, entries) in hooks_obj {
        let Some(entries_arr) = entries.as_array() else { continue };
        for entry in entries_arr {
            let Some(inner) = entry.get("hooks").and_then(|v| v.as_array()) else { continue };
            for h in inner {
                let typ = h.get("type").and_then(|v| v.as_str()).unwrap_or("");
                let cmd = h.get("command").and_then(|v| v.as_str()).unwrap_or("");
                let to = h.get("timeout").and_then(|v| v.as_i64());
                cb(event, typ, cmd, to);
            }
        }
    }
}

/// 2. HOOKS — count + flag non-kit hooks. Also 13. HOOK TIMEOUTS — flag >300s.
fn audit_hooks(
    out: &mut Vec<AuditFinding>,
    settings: Option<&serde_json::Value>,
    settings_invalid: Option<&str>,
) {
    if let Some(err) = settings_invalid {
        // VERBATIM TITLE — `infer_action` keys off "settings.json invalid JSON".
        push_finding(
            out,
            "CRIT",
            "HOOKS",
            "settings.json invalid JSON".to_string(),
            err.to_string(),
        );
        return;
    }
    let Some(settings) = settings else { return };

    // Build expected hook commands from $USERPROFILE -> bash-style path.
    // Mirrors PS: $bashHome = ($env:USERPROFILE -replace '\\', '/').Replace('C:', '/c')
    let bash_home = std::env::var("USERPROFILE")
        .ok()
        .map(|p| {
            let with_fwd = p.replace('\\', "/");
            // Replace leading "C:" (case-insensitive on first 2 chars) with "/c"
            if with_fwd.len() >= 2 && with_fwd.as_bytes()[1] == b':' {
                let drive = with_fwd.as_bytes()[0].to_ascii_lowercase() as char;
                format!("/{drive}{}", &with_fwd[2..])
            } else {
                with_fwd
            }
        })
        .unwrap_or_default();
    let expected = [
        format!("bash {bash_home}/.claude/scripts/check-gentle-ai.sh"),
        format!("bash {bash_home}/.claude/scripts/daily-brief.sh"),
    ];

    // First pass: count + flag non-kit. Second pass: timeouts. We do both in one
    // walk to keep ordering close to the PS script's emission order.
    let mut all: Vec<(String, String, Option<i64>)> = Vec::new();
    for_each_hook(settings, |event, _typ, cmd, to| {
        all.push((event.to_string(), cmd.to_string(), to));
    });

    push_finding(
        out,
        "INFO",
        "HOOKS",
        format!("{} hook(s) registered", all.len()),
        String::new(),
    );
    for (event, cmd, _to) in &all {
        if !expected.iter().any(|e| e == cmd) {
            push_finding(
                out,
                "WARN",
                "HOOKS",
                format!("Non-kit hook on {event}"),
                cmd.clone(),
            );
        }
    }
    // Block 13 — timeout > 300s.
    for (event, cmd, to) in &all {
        if let Some(t) = to {
            if *t > 300 {
                push_finding(
                    out,
                    "WARN",
                    "HOOKS",
                    format!("Hook timeout > 300s ({t}s) on {event}"),
                    cmd.clone(),
                );
            }
        }
    }
}

/// 3. PERMISSIONS — flag dangerous regex patterns inside `permissions.allow`.
fn audit_permissions(out: &mut Vec<AuditFinding>, settings: Option<&serde_json::Value>) {
    let Some(settings) = settings else { return };
    let Some(perms) = settings.get("permissions") else { return };

    // (substring-or-regex-style pattern, human note). The PS script uses regex
    // matching; we use simple substring checks because the patterns are simple
    // enough — except for `..\..` and `rm -rf` which we lower below.
    let danger: &[(&str, &str)] = &[
        ("rm -rf",          "destructive recursive delete"),
        ("rm  -rf",         "destructive recursive delete"),
        ("sudo",            "elevated privileges"),
        ("curl",            "remote script execution"),
        ("iex",             "PowerShell remote-exec idiom (Invoke-Expression)"),
        ("Invoke-Expression", "PowerShell exec from string"),
        ("..\\..",          "path traversal"),
        ("../..",           "path traversal"),
    ];

    if let Some(allow) = perms.get("allow").and_then(|v| v.as_array()) {
        for rule_v in allow {
            let Some(rule) = rule_v.as_str() else { continue };
            let lower = rule.to_lowercase();
            let mut emitted_notes: Vec<&str> = Vec::new();
            for (pat, note) in danger {
                let pat_lower = pat.to_lowercase();
                let mut hit = lower.contains(&pat_lower);
                // Special-case `curl ... | bash` — PS regex was `curl.*\|\s*bash`.
                if *pat == "curl" {
                    hit = lower.contains("curl") && lower.contains("| bash") || lower.contains("|bash");
                }
                // `sudo` — match whole word (`\bsudo\b`).
                if *pat == "sudo" {
                    hit = lower.split(|c: char| !c.is_alphanumeric()).any(|w| w == "sudo");
                }
                // `iex` — also whole word (`\biex\b`).
                if *pat == "iex" {
                    hit = lower.split(|c: char| !c.is_alphanumeric()).any(|w| w == "iex");
                }
                if hit && !emitted_notes.contains(note) {
                    // VERBATIM TITLE PREFIX — `infer_action` matches "Allow rule matches risky pattern:".
                    push_finding(
                        out,
                        "CRIT",
                        "PERMISSIONS",
                        format!("Allow rule matches risky pattern: {note}"),
                        rule.to_string(),
                    );
                    emitted_notes.push(note);
                }
            }
        }
    }
    let default_mode = perms
        .get("defaultMode")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    push_finding(
        out,
        "INFO",
        "PERMISSIONS",
        format!("defaultMode: {default_mode}"),
        String::new(),
    );
}

/// 4. SCRIPTS — flag files in ~/.claude/scripts/ and lib/ that aren't kit-installed.
fn audit_scripts(out: &mut Vec<AuditFinding>, claude_dir: &Path) {
    const KIT_WHITELIST: &[&str] = &[
        "check-gentle-ai.sh", "daily-brief.sh",
        "startup-brief.ps1", "startup-brief-launcher.bat",
        "health-check.ps1", "standup.ps1", "claude-audit.ps1", "cleanup.ps1",
        "brief.cmd",
        "startup-kit-config.json",
        ".gentle-ai-last-check", ".daily-brief-last-date",
        ".gentle-ai-last-seen-version", ".kit-version",
        "lib",
    ];
    const LIB_WHITELIST: &[&str] = &[
        "config.ps1", "logging.ps1", "scan-projects.ps1", "engram.ps1",
        "themes.ps1", "git-recent.ps1", "github-prs.ps1", "self-update.ps1",
        "screen-adapt.ps1", "render-layout.ps1",
    ];

    let scripts_dir = claude_dir.join("scripts");
    if !scripts_dir.exists() {
        return;
    }
    if let Ok(entries) = fs::read_dir(&scripts_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !KIT_WHITELIST.contains(&name.as_str()) {
                // VERBATIM TITLE PREFIX — `infer_action` keys off
                // "Non-kit file in ~/.claude/scripts/:". Bumped from INFO to
                // WARN so the renderer surfaces a "Resolver" button (Open in
                // Explorer); push_finding skips action inference for INFO.
                push_finding(
                    out,
                    "WARN",
                    "SCRIPTS",
                    format!("Non-kit file in ~/.claude/scripts/: {name}"),
                    "Created outside the kit. Review if you don't recognize it.".to_string(),
                );
            }
        }
    }
    let lib_dir = scripts_dir.join("lib");
    if lib_dir.exists() {
        if let Ok(entries) = fs::read_dir(&lib_dir) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
                if is_file && !LIB_WHITELIST.contains(&name.as_str()) {
                    // VERBATIM TITLE PREFIX — `infer_action` keys off "Non-kit file in lib/:".
                    push_finding(
                        out,
                        "WARN",
                        "SCRIPTS",
                        format!("Non-kit file in lib/: {name}"),
                        "lib/ should only contain kit modules. Review.".to_string(),
                    );
                }
            }
        }
    }
}

/// 5. PLUGINS — list enabledPlugins + extraKnownMarketplaces. Mostly INFO.
fn audit_plugins(out: &mut Vec<AuditFinding>, settings: Option<&serde_json::Value>) {
    let Some(settings) = settings else { return };
    if let Some(enabled) = settings.get("enabledPlugins").and_then(|v| v.as_object()) {
        push_finding(
            out,
            "INFO",
            "PLUGINS",
            format!("{} plugin(s) enabled", enabled.len()),
            String::new(),
        );
        for (name, val) in enabled {
            let val_str = match val {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Bool(b) => b.to_string(),
                _ => val.to_string(),
            };
            push_finding(
                out,
                "INFO",
                "PLUGINS",
                format!("  - {name}: {val_str}"),
                String::new(),
            );
        }
    }
    if let Some(markets) = settings
        .get("extraKnownMarketplaces")
        .and_then(|v| v.as_object())
    {
        for (name, mp) in markets {
            let src = mp.get("source");
            let src_type = src.and_then(|s| s.get("source")).and_then(|v| v.as_str()).unwrap_or("");
            let repo = src.and_then(|s| s.get("repo")).and_then(|v| v.as_str());
            let mut detail = format!("type={src_type}");
            if let Some(r) = repo {
                detail.push_str(&format!(" repo={r}"));
            }
            push_finding(out, "INFO", "PLUGINS", format!("Marketplace: {name}"), detail);
        }
    }
}

/// 6. LOGS — tail startup-kit.log for ERROR/WARN counts.
fn audit_logs(out: &mut Vec<AuditFinding>, claude_dir: &Path) {
    let log = claude_dir.join("logs").join("startup-kit.log");
    if !log.exists() {
        // Brief was removed — log no longer exists. Keep the legacy INFO line so
        // the UI doesn't suddenly drop a row.
        push_finding(
            out,
            "INFO",
            "LOGS",
            format!("No log file yet at {}", log.display()),
            String::new(),
        );
        return;
    }
    let tail = match read_last_n_lines(&log, 200) {
        Ok(t) => t,
        Err(_) => return,
    };
    let errors: Vec<&String> = tail.iter().filter(|l| l.contains("[ERROR]")).collect();
    let warns: Vec<&String> = tail.iter().filter(|l| l.contains("[WARN]")).collect();
    if !errors.is_empty() {
        // VERBATIM TITLE SUFFIX — `infer_action` matches "ERROR entries in last 200 log lines".
        push_finding(
            out,
            "WARN",
            "LOGS",
            format!("{} ERROR entries in last 200 log lines", errors.len()),
            String::new(),
        );
        // Last 3 ERROR lines as INFO context.
        let last3 = errors.iter().rev().take(3).rev();
        for e in last3 {
            push_finding(out, "INFO", "LOGS", format!("  {e}"), String::new());
        }
    }
    if warns.len() > 5 {
        push_finding(
            out,
            "INFO",
            "LOGS",
            format!("{} WARN entries in last 200 log lines (>5)", warns.len()),
            String::new(),
        );
    }
}

/// Read the last `n` lines of a file. Caps total read at the last 256 KiB so a
/// multi-GB log never gets fully loaded into memory — the audit only inspects
/// 200 lines, and 256 KiB comfortably covers that even with very long lines.
fn read_last_n_lines(path: &Path, n: usize) -> std::io::Result<Vec<String>> {
    const TAIL_CAP: u64 = 256 * 1024;
    let mut f = File::open(path)?;
    let len = f.metadata()?.len();
    let read_from = len.saturating_sub(TAIL_CAP);
    f.seek(SeekFrom::Start(read_from))?;
    let mut buf = Vec::with_capacity(TAIL_CAP as usize);
    f.take(TAIL_CAP).read_to_end(&mut buf)?;
    // Drop a possibly-truncated leading partial line when we didn't start at byte 0.
    let text = String::from_utf8_lossy(&buf);
    let mut lines: Vec<String> = text.lines().map(|s| s.to_string()).collect();
    if read_from > 0 && !lines.is_empty() {
        lines.remove(0);
    }
    let start = lines.len().saturating_sub(n);
    Ok(lines[start..].to_vec())
}

/// Recursively sum file sizes under `path`. Returns 0 on missing/error.
fn dir_size_bytes(path: &Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    let mut stack = vec![path.to_path_buf()];
    let mut total: u64 = 0;
    while let Some(p) = stack.pop() {
        let Ok(entries) = fs::read_dir(&p) else { continue };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            if ft.is_dir() {
                stack.push(entry.path());
            } else if ft.is_file() {
                if let Ok(meta) = entry.metadata() {
                    total = total.saturating_add(meta.len());
                }
            }
        }
    }
    total
}

/// Walk a directory tree yielding file paths matching a predicate.
fn walk_files(root: &Path, mut on_file: impl FnMut(&Path, u64)) {
    let mut stack = vec![root.to_path_buf()];
    while let Some(p) = stack.pop() {
        let Ok(entries) = fs::read_dir(&p) else { continue };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else { continue };
            let path = entry.path();
            if ft.is_dir() {
                stack.push(path);
            } else if ft.is_file() {
                let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
                on_file(&path, size);
            }
        }
    }
}

/// 7. DISK — total + breakdown of ~/.claude. Also 12. BIG JSONLs.
fn audit_disk(out: &mut Vec<AuditFinding>, claude_dir: &Path) {
    let mb = |b: u64| -> f64 { (b as f64) / (1024.0 * 1024.0) };

    // Single recursive walk of ~/.claude that accumulates the total, the
    // per-bucket breakdown (projects/, logs/, backups/), and the list of
    // big-JSONL findings in one pass. The previous version walked the tree
    // 5 times (once for total, once per bucket, once for big-JSONLs) — on a
    // multi-GB tree that's O(5N) syscalls per audit run.
    let projects_root = claude_dir.join("projects");
    let logs_root = claude_dir.join("logs");
    let backups_root = claude_dir.join("backups");

    let mut total: u64 = 0;
    let mut projects_bytes: u64 = 0;
    let mut logs_bytes: u64 = 0;
    let mut backups_bytes: u64 = 0;
    let mut big_jsonls: Vec<(PathBuf, u64)> = Vec::new();

    if claude_dir.exists() {
        walk_files(claude_dir, |path, size| {
            total = total.saturating_add(size);
            if path.starts_with(&projects_root) {
                projects_bytes = projects_bytes.saturating_add(size);
                if size > 100 * 1024 * 1024
                    && path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.eq_ignore_ascii_case("jsonl"))
                        .unwrap_or(false)
                {
                    big_jsonls.push((path.to_path_buf(), size));
                }
            } else if path.starts_with(&logs_root) {
                logs_bytes = logs_bytes.saturating_add(size);
            } else if path.starts_with(&backups_root) {
                backups_bytes = backups_bytes.saturating_add(size);
            }
        });
    }

    push_finding(
        out,
        "INFO",
        "DISK",
        format!("~/.claude total: {:.1} MB", mb(total)),
        String::new(),
    );
    push_finding(
        out,
        "INFO",
        "DISK",
        format!("  projects/ : {:.1} MB (Claude Code session logs)", mb(projects_bytes)),
        String::new(),
    );
    push_finding(
        out,
        "INFO",
        "DISK",
        format!("  logs/     : {:.1} MB", mb(logs_bytes)),
        String::new(),
    );
    if backups_bytes > 0 {
        push_finding(
            out,
            "INFO",
            "DISK",
            format!("  backups/  : {:.1} MB (kit pre-install backups)", mb(backups_bytes)),
            String::new(),
        );
    }
    if mb(total) > 5000.0 {
        // VERBATIM TITLE PREFIX — `infer_action` keys off "~/.claude is over".
        push_finding(
            out,
            "WARN",
            "DISK",
            "~/.claude is over 5 GB".to_string(),
            "Consider trimming projects/ or logs/".to_string(),
        );
    }

    // Block 12 — large JSONLs under projects/ (>100 MB).
    for (path, size) in big_jsonls {
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("(unknown)")
            .to_string();
        let size_mb = (size as f64) / (1024.0 * 1024.0);
        // VERBATIM TITLE PREFIX — `infer_action` keys off "Large JSONL:".
        // Include the full path in the detail so `extract_windows_path` can
        // route the action to OpenInExplorer instead of falling back to
        // NavigateTo cleanup.
        push_finding(
            out,
            "WARN",
            "DISK",
            format!("Large JSONL: {name} ({:.1} MB)", size_mb),
            format!("{} — consider running cleanup.ps1", path.display()),
        );
    }
}

/// 8. NETWORK — TCP connections of watched processes.
///
/// SKIPPED on first pass: pure-Rust TCP table enumeration on Windows requires
/// either `iphlpapi` Win32 calls (`GetExtendedTcpTable`) or a new dep. The PS
/// script used `Get-NetTCPConnection` which is Windows-only too. Emit a single
/// INFO so the category isn't silently missing from the UI.
// TODO: wire native Win32 IP helper (GetExtendedTcpTable) or shell to
// `Get-NetTCPConnection` for full parity.
fn audit_network(out: &mut Vec<AuditFinding>) {
    push_finding(
        out,
        "INFO",
        "NETWORK",
        "Network checks skipped — Win32 IP helper not yet wired in Rust".to_string(),
        String::new(),
    );
}

/// 9. DRIFT — settings.local.json, undeclared marketplaces.
fn audit_drift(out: &mut Vec<AuditFinding>, claude_dir: &Path, settings: Option<&serde_json::Value>) {
    let local = claude_dir.join("settings.local.json");
    if local.exists() {
        // VERBATIM TITLE — `infer_action` matches this exact string.
        push_finding(
            out,
            "WARN",
            "DRIFT",
            "settings.local.json exists — overrides settings.json".to_string(),
            format!("Inspect: {}", local.display()),
        );
    }
    // Block 11 — plugin marketplace declared?
    let Some(settings) = settings else { return };
    let Some(enabled) = settings.get("enabledPlugins").and_then(|v| v.as_object()) else { return };
    let declared: Vec<String> = settings
        .get("extraKnownMarketplaces")
        .and_then(|v| v.as_object())
        .map(|o| o.keys().cloned().collect())
        .unwrap_or_default();
    for name in enabled.keys() {
        if let Some(at_idx) = name.rfind('@') {
            let market = &name[at_idx + 1..];
            if !declared.iter().any(|d| d == market) {
                push_finding(
                    out,
                    "WARN",
                    "DRIFT",
                    format!("Plugin '{name}' uses marketplace '{market}' which isn't declared in extraKnownMarketplaces"),
                    String::new(),
                );
            }
        }
    }
}

/// 10. ENV VARS — relevant CLAUDE_/MCP_/ANTHROPIC_ env vars.
fn audit_env(out: &mut Vec<AuditFinding>) {
    let mut matched: Vec<String> = Vec::new();
    for (k, v) in std::env::vars() {
        let starts = k.starts_with("CLAUDE_") || k.starts_with("MCP_") || k.starts_with("ANTHROPIC_");
        if !starts {
            continue;
        }
        let display = if k.contains("KEY") || k.contains("TOKEN") || k.contains("SECRET") {
            "<redacted>".to_string()
        } else {
            v
        };
        matched.push(format!("{k} = {display}"));
    }
    if !matched.is_empty() {
        push_finding(
            out,
            "INFO",
            "ENV",
            format!("{} relevant env var(s)", matched.len()),
            String::new(),
        );
        for m in matched {
            push_finding(out, "INFO", "ENV", format!("  {m}"), String::new());
        }
    }
}

/// 14. STARTUP — items in the Windows per-user Startup folder.
fn audit_startup(out: &mut Vec<AuditFinding>) {
    let Some(appdata) = std::env::var_os("APPDATA") else { return };
    let startup = PathBuf::from(appdata)
        .join("Microsoft")
        .join("Windows")
        .join("Start Menu")
        .join("Programs")
        .join("Startup");
    if !startup.exists() {
        return;
    }
    let entries: Vec<_> = match fs::read_dir(&startup) {
        Ok(it) => it
            .flatten()
            .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
            .collect(),
        Err(_) => return,
    };
    push_finding(
        out,
        "INFO",
        "STARTUP",
        format!("{} item(s) in Windows Startup folder", entries.len()),
        String::new(),
    );
    for e in entries {
        let name = e.file_name().to_string_lossy().to_string();
        let title = if name == "claude-daily-brief.bat" {
            format!("  - {name} (kit launcher)")
        } else {
            format!("  - {name}")
        };
        push_finding(out, "INFO", "STARTUP", title, String::new());
    }
}

fn run_audit_blocking() -> Result<Vec<AuditFinding>, String> {
    let claude_dir = dirs_home()
        .map(|h| h.join(".claude"))
        .ok_or_else(|| "no home directory".to_string())?;

    // Load settings.json once and pass it through the helpers. Track invalid-JSON
    // separately so audit_hooks can emit the CRIT finding.
    let (settings, settings_invalid): (Option<serde_json::Value>, Option<String>) =
        match load_settings(&claude_dir) {
            Ok(opt) => (opt, None),
            Err(e) => (None, Some(e)),
        };

    let mut out: Vec<AuditFinding> = Vec::new();

    // Order matches the legacy PS script — the UI groups by category and renders
    // top-down, so don't shuffle these.
    audit_processes(&mut out);
    audit_hooks(&mut out, settings.as_ref(), settings_invalid.as_deref());
    audit_permissions(&mut out, settings.as_ref());
    audit_scripts(&mut out, &claude_dir);
    audit_plugins(&mut out, settings.as_ref());
    audit_logs(&mut out, &claude_dir);
    audit_disk(&mut out, &claude_dir);
    audit_network(&mut out);
    audit_drift(&mut out, &claude_dir, settings.as_ref());
    audit_env(&mut out);
    audit_startup(&mut out);

    Ok(out)
}

#[tauri::command]
async fn run_audit() -> Result<Vec<AuditFinding>, String> {
    tokio::task::spawn_blocking(run_audit_blocking)
        .await
        .map_err(|e| format!("audit task join error: {e}"))?
}

// ---------- audit follow-up actions ----------

#[tauri::command]
async fn kill_process(pid: u32) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let output = silent_command("taskkill")
            .args(["/PID", &pid.to_string(), "/F"])
            .output()
            .map_err(|e| format!("failed to spawn taskkill: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let msg = if !stderr.trim().is_empty() {
                stderr.into_owned()
            } else if !stdout.trim().is_empty() {
                stdout.into_owned()
            } else {
                format!(
                    "taskkill exited with status {}",
                    output.status.code().unwrap_or(-1)
                )
            };
            return Err(msg.trim().to_string());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("kill task join error: {e}"))?
}

#[tauri::command]
async fn restore_settings_backup() -> Result<String, String> {
    tokio::task::spawn_blocking(|| -> Result<String, String> {
        let home = dirs_home().ok_or_else(|| "home directory not resolvable".to_string())?;
        let backups_root = home.join(".claude").join("backups");
        if !backups_root.exists() {
            return Err(format!(
                "no backups directory at {}",
                backups_root.display()
            ));
        }
        // Collect candidate backup directories: name starts with "startup-kit-"
        // AND contains settings.json. Pick the one with the most recent mtime.
        let mut candidates: Vec<(SystemTime, PathBuf)> = fs::read_dir(&backups_root)
            .map_err(|e| format!("read backups dir: {e}"))?
            .filter_map(|e| e.ok())
            .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
            .filter(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with("startup-kit-")
            })
            .filter(|e| e.path().join("settings.json").exists())
            .filter_map(|e| {
                let m = e.metadata().ok()?.modified().ok()?;
                Some((m, e.path()))
            })
            .collect();
        if candidates.is_empty() {
            return Err("no startup-kit-* backup with settings.json found".to_string());
        }
        candidates.sort_by(|a, b| b.0.cmp(&a.0));
        let (_, chosen) = &candidates[0];
        let src = chosen.join("settings.json");
        let dest = home.join(".claude").join("settings.json");
        fs::copy(&src, &dest).map_err(|e| {
            format!(
                "copy {} -> {}: {e}",
                src.display(),
                dest.display()
            )
        })?;
        let name = chosen
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| chosen.to_string_lossy().to_string());
        Ok(name)
    })
    .await
    .map_err(|e| format!("restore task join error: {e}"))?
}

// ---------- engram known-projects cache (5-minute TTL) ----------

struct KnownProjectsCache {
    value: Vec<String>,
    fetched_at: Instant,
}

static KNOWN_PROJECTS_CACHE: Lazy<Mutex<Option<KnownProjectsCache>>> =
    Lazy::new(|| Mutex::new(None));

const KNOWN_PROJECTS_TTL: Duration = Duration::from_secs(5 * 60);

fn fetch_known_projects_uncached() -> Vec<String> {
    let Ok(output) = silent_command("engram").args(["projects", "list"]).output() else {
        return vec![];
    };
    if !output.status.success() {
        return vec![];
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut names = Vec::new();
    for line in text.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with(['-', '=', '#']) {
            continue;
        }
        // Capture the leading identifier-like token.
        let token: String = t
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-' || *c == '.')
            .collect();
        if token.is_empty() {
            continue;
        }
        // Skip purely-numeric tokens (line numbers, counts) and tokens whose
        // first char isn't alphanumeric.
        let Some(first) = token.chars().next() else {
            continue;
        };
        if !first.is_ascii_alphanumeric() {
            continue;
        }
        if token.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let lc = token.to_lowercase();
        if !names.contains(&lc) {
            names.push(lc);
        }
    }
    names
}

fn known_projects_cached() -> Vec<String> {
    {
        let guard = KNOWN_PROJECTS_CACHE.lock().unwrap();
        if let Some(entry) = guard.as_ref() {
            if entry.fetched_at.elapsed() < KNOWN_PROJECTS_TTL {
                return entry.value.clone();
            }
        }
    }
    let fresh = fetch_known_projects_uncached();
    let mut guard = KNOWN_PROJECTS_CACHE.lock().unwrap();
    *guard = Some(KnownProjectsCache {
        value: fresh.clone(),
        fetched_at: Instant::now(),
    });
    fresh
}

#[tauri::command]
fn engram_known_projects() -> Vec<String> {
    known_projects_cached()
}

fn resolve_engram_project(leaf: &str, known: &[String]) -> String {
    let needle = leaf.to_lowercase();
    if known.iter().any(|n| n == &needle) {
        return needle;
    }
    if let Some(p) = known
        .iter()
        .find(|n| n.starts_with(&needle) || needle.starts_with(n.as_str()))
    {
        return p.clone();
    }
    if let Some(c) = known
        .iter()
        .find(|n| n.contains(&needle) || needle.contains(n.as_str()))
    {
        return c.clone();
    }
    needle
}

fn engram_project_goal_blocking(path: &str, known: &[String]) -> Option<String> {
    let leaf = Path::new(path).file_name()?.to_str()?.to_string();
    if leaf.is_empty() {
        return None;
    }
    let project_name = resolve_engram_project(&leaf, known);
    let output = silent_command("engram")
        .args([
            "search",
            "session summary",
            "--project",
            &project_name,
            "--type",
            "session_summary",
            "--limit",
            "1",
        ])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout).to_string();
    extract_goal(&text)
}

#[tauri::command]
async fn engram_project_goal(path: String, known: Vec<String>) -> Option<String> {
    tokio::task::spawn_blocking(move || engram_project_goal_blocking(&path, &known))
        .await
        .ok()
        .flatten()
}

fn extract_goal(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    let needle = "## goal";
    let pos = lower.find(needle)?;
    let after = &text[pos + needle.len()..];
    for line in after.lines().skip(1) {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with('#') {
            return None;
        }
        let trimmed = if t.chars().count() > 110 {
            let mut s: String = t.chars().take(109).collect();
            s.push('…');
            s
        } else {
            t.to_string()
        };
        return Some(trimmed);
    }
    None
}

#[derive(Serialize, Clone)]
pub struct GitInfo {
    pub hash: String,
    pub ago: String,
    pub author: String,
    pub subject: String,
}

fn git_last_commit_blocking(path: &str) -> Option<GitInfo> {
    let project = Path::new(path);
    if !project.is_dir() {
        return None;
    }
    if !project.join(".git").exists() {
        return None;
    }
    let output = silent_command("git")
        .args(["-C", path, "log", "-1", "--pretty=format:%h|%cr|%an|%s"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if line.is_empty() {
        return None;
    }
    let parts: Vec<&str> = line.splitn(4, '|').collect();
    if parts.len() < 4 {
        return None;
    }
    Some(GitInfo {
        hash: parts[0].to_string(),
        ago: parts[1].to_string(),
        author: parts[2].to_string(),
        subject: parts[3].to_string(),
    })
}

#[tauri::command]
async fn git_last_commit(path: String) -> Option<GitInfo> {
    tokio::task::spawn_blocking(move || git_last_commit_blocking(&path))
        .await
        .ok()
        .flatten()
}

// ---------- batched enrichment ----------

#[derive(Serialize, Clone)]
pub struct EnrichedProject {
    pub path: String,
    pub git: Option<GitInfo>,
    pub goal: Option<String>,
}

#[tauri::command]
async fn enrich_projects(
    paths: Vec<String>,
) -> std::collections::HashMap<String, EnrichedProject> {
    // Resolve known engram projects ONCE for the whole batch (cached for 5min).
    let known = tokio::task::spawn_blocking(known_projects_cached)
        .await
        .unwrap_or_default();

    // Cap concurrency so a workspace with 50+ projects doesn't race the Tokio
    // blocking pool — each task fires git + engram subprocesses, so unbounded
    // fan-out starves every other spawn_blocking caller in the app.
    use std::sync::Arc;
    use tokio::sync::Semaphore;
    let sem = Arc::new(Semaphore::new(8));

    // Fan out: each path runs git+engram in parallel inside spawn_blocking,
    // gated by the semaphore.
    let mut handles = Vec::with_capacity(paths.len());
    for path in paths {
        let known_clone = known.clone();
        let sem_clone = sem.clone();
        handles.push(tokio::spawn(async move {
            // Permit lives until the spawn_blocking finishes — drop releases it.
            let _permit = sem_clone.acquire_owned().await.ok()?;
            tokio::task::spawn_blocking(move || {
                let git = git_last_commit_blocking(&path);
                let goal = engram_project_goal_blocking(&path, &known_clone);
                EnrichedProject { path, git, goal }
            })
            .await
            .ok()
        }));
    }

    // Return a `HashMap<path, EnrichedProject>` instead of `Vec<...>` so the
    // renderer can do `enrichment[p.path]` directly. Previously the renderer
    // typed the result as `Record<string, EnrichedProject>` but Rust shipped
    // a Vec — every `enrichment[p.path]` lookup silently returned undefined,
    // and project goals never appeared on Overview / Projects.
    let mut out: std::collections::HashMap<String, EnrichedProject> =
        std::collections::HashMap::with_capacity(handles.len());
    for h in handles {
        if let Ok(Some(item)) = h.await {
            out.insert(item.path.clone(), item);
        }
    }
    out
}

// Reject inputs that look like CLI flags or shell escape paths. Prevents an
// attacker who controls the renderer (e.g. via XSS in a dep) from passing
// `--install-extension evil.ext` to code.cmd or `shell:::{CLSID}` to explorer.
fn validate_open_path(path: &str) -> Result<PathBuf, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".to_string());
    }
    // Flag-injection guard.
    if trimmed.starts_with('-') || trimmed.starts_with('/') {
        return Err(format!("refused (looks like a flag/option): {trimmed}"));
    }
    // Shell-namespace / protocol guards (Windows-specific attack surface).
    let lower = trimmed.to_lowercase();
    for bad in ["shell:", "shell:::", "::{", "file://", "ms-windows-store:"] {
        if lower.starts_with(bad) {
            return Err(format!("refused (protocol/shell path): {trimmed}"));
        }
    }
    // Reject UNC \\server\share — NTLM hash capture vector.
    if trimmed.starts_with("\\\\") || trimmed.starts_with("//") {
        return Err(format!("refused (UNC path): {trimmed}"));
    }
    // Path must exist and resolve cleanly.
    let p = Path::new(trimmed);
    if !p.exists() {
        return Err(format!("path not found: {trimmed}"));
    }
    let canonical = p
        .canonicalize()
        .map_err(|e| format!("canonicalize {trimmed}: {e}"))?;
    Ok(canonical)
}

#[tauri::command]
async fn open_in_vscode(path: String) -> Result<(), String> {
    let canonical = validate_open_path(&path)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        // `--` ends VS Code's option parsing so the path that follows is treated
        // verbatim and never as a flag, even if a future bypass slips through.
        silent_command("code.cmd")
            .arg("--")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("failed to launch VS Code: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn open_path_in_explorer(path: String) -> Result<(), String> {
    let canonical = validate_open_path(&path)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        silent_command("explorer")
            .arg(&canonical)
            .spawn()
            .map_err(|e| format!("failed to open explorer: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ─── Claude skills + MCP servers ─────────────────────────────────────────
//
// Skills live as `~/.claude/skills/<name>/SKILL.md` with YAML frontmatter
// like `name:`, `description:`. Usage counts come from a best-effort scan
// of the user's JSONL conversation logs under `~/.claude/projects/`. We only
// look at files modified in the last 30 days to keep the cost bounded — a
// fresh scan typically runs in under 100ms on a normal-size workspace.
//
// MCP servers come from two sources:
//   • `~/.claude/mcp/<name>.json` — file-based servers. "Active" means the
//     file exists with the .json extension; toggling off renames it to
//     `<name>.json.disabled` so the data is preserved.
//   • `~/.claude/settings.json#/enabledPlugins` — bundled plugin MCPs
//     (engram@engram, etc.). Toggling flips the bool in place.

#[derive(Serialize, Clone)]
pub struct ClaudeSkill {
    pub name: String,
    pub description: String,
    pub path: String,
    pub usage_count: u32,
}

#[derive(Serialize, Clone)]
pub struct McpServer {
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    pub source: String, // "config" | "plugin"
    pub enabled: bool,
    pub path: String,   // file path for "config"; settings.json for "plugin"
}

fn claude_skills_dir() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".claude").join("skills"))
}

fn claude_mcp_dir() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".claude").join("mcp"))
}

fn claude_settings_path() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".claude").join("settings.json"))
}

// Pulls `name:` and `description:` out of a YAML frontmatter block at the
// top of SKILL.md. Description supports the `>` folded scalar across the
// next non-empty indented lines. Anything fancier we don't need.
fn parse_skill_frontmatter(text: &str) -> (String, String) {
    let mut name = String::new();
    let mut description = String::new();
    let mut in_fm = false;
    let mut reading_desc = false;
    for raw in text.lines() {
        let line = raw.trim_end();
        if line.trim() == "---" {
            if !in_fm {
                in_fm = true;
                continue;
            } else {
                break;
            }
        }
        if !in_fm {
            continue;
        }
        // Continuation of folded `description: >` block.
        if reading_desc {
            if line.starts_with(' ') || line.starts_with('\t') {
                let cont = line.trim();
                if !description.is_empty() {
                    description.push(' ');
                }
                description.push_str(cont);
                continue;
            }
            reading_desc = false;
        }
        if let Some(rest) = line.strip_prefix("name:") {
            name = rest.trim().trim_matches('"').to_string();
            continue;
        }
        if let Some(rest) = line.strip_prefix("description:") {
            let trimmed = rest.trim();
            if trimmed == ">" || trimmed == "|" {
                reading_desc = true;
            } else {
                description = trimmed.trim_matches('"').to_string();
            }
            continue;
        }
    }
    (name, description)
}

// 5-minute TTL cache mirroring KNOWN_PROJECTS_CACHE. WorkspaceCard mounts
// trigger this on every navigation and the underlying scan can chew through
// up to 400 MiB of substring matching — caching the keyed result avoids
// re-paying that cost while the user navigates within a session.
struct SkillUsageCache {
    key: Vec<String>,
    value: std::collections::HashMap<String, u32>,
    fetched_at: Instant,
}

static SKILL_USAGE_CACHE: Lazy<Mutex<Option<SkillUsageCache>>> = Lazy::new(|| Mutex::new(None));

const SKILL_USAGE_TTL: Duration = Duration::from_secs(5 * 60);

fn count_skill_usage_cached(skill_names: &[String]) -> std::collections::HashMap<String, u32> {
    // Cache key is the sorted skill name list — same set of skills should hit
    // even if call sites pass them in a different order.
    let mut key = skill_names.to_vec();
    key.sort();
    {
        let guard = SKILL_USAGE_CACHE.lock().unwrap();
        if let Some(entry) = guard.as_ref() {
            if entry.key == key && entry.fetched_at.elapsed() < SKILL_USAGE_TTL {
                return entry.value.clone();
            }
        }
    }
    let fresh = count_skill_usage(skill_names);
    let mut guard = SKILL_USAGE_CACHE.lock().unwrap();
    *guard = Some(SkillUsageCache {
        key,
        value: fresh.clone(),
        fetched_at: Instant::now(),
    });
    fresh
}

// Counts how many times each skill name appears across recent JSONL logs.
//
// Heavy users (hundreds of MB of conversation history) made the naive
// implementation hang for seconds. The current version:
//   • caps to 7 days mtime — recent activity is what 'most used' should
//     reflect, and the cost falls roughly linearly with the window.
//   • caps each file at 2 MiB — auto-compacted long conversations would
//     otherwise dominate the scan; truncating still gives a representative
//     sample.
//   • does ONE pass per file with all needles pre-built.
fn count_skill_usage(skill_names: &[String]) -> std::collections::HashMap<String, u32> {
    use std::collections::HashMap;
    use std::io::Read;
    let mut counts: HashMap<String, u32> = HashMap::new();
    for n in skill_names {
        counts.insert(n.clone(), 0);
    }
    let projects_dir = match claude_projects_dir() {
        Some(d) => d,
        None => return counts,
    };
    let cutoff = SystemTime::now() - Duration::from_secs(7 * 24 * 60 * 60);
    const PER_FILE_CAP: u64 = 2 * 1024 * 1024;

    // Pre-build the quoted needles once. Quoting biases toward JSON tool-call
    // payload mentions over free-text references that happen to share a word.
    let needles: Vec<(String, String)> = skill_names
        .iter()
        .map(|n| (n.clone(), format!("\"{n}\"")))
        .collect();

    let entries = match fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(_) => return counts,
    };
    for entry in entries.flatten() {
        let project_path = entry.path();
        let inner = match fs::read_dir(&project_path) {
            Ok(e) => e,
            Err(_) => continue,
        };
        for jsonl in inner.flatten() {
            let p = jsonl.path();
            if p.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            let meta = match fs::metadata(&p) {
                Ok(m) => m,
                Err(_) => continue,
            };
            let mtime = match meta.modified() {
                Ok(t) => t,
                Err(_) => continue,
            };
            if mtime < cutoff {
                continue;
            }
            // Read up to the cap. take(N) on Read doesn't allocate beyond N.
            let file = match File::open(&p) {
                Ok(f) => f,
                Err(_) => continue,
            };
            let mut buf = String::new();
            if file.take(PER_FILE_CAP).read_to_string(&mut buf).is_err() {
                continue;
            }
            for (name, needle) in &needles {
                let c = buf.matches(needle.as_str()).count() as u32;
                if c > 0 {
                    if let Some(slot) = counts.get_mut(name) {
                        *slot = slot.saturating_add(c);
                    }
                }
            }
        }
    }
    counts
}

#[tauri::command]
async fn list_claude_skills() -> Result<Vec<ClaudeSkill>, String> {
    // Fast path: enumerate skill directories + parse frontmatter, no usage
    // scan. Frontend follows up with `count_claude_skill_usage` so the list
    // appears instantly even when the JSONL backlog is heavy.
    tokio::task::spawn_blocking(|| -> Result<Vec<ClaudeSkill>, String> {
        let dir = claude_skills_dir().ok_or("home dir unavailable")?;
        let entries = match fs::read_dir(&dir) {
            Ok(e) => e,
            Err(_) => return Ok(vec![]),
        };
        let mut skills: Vec<ClaudeSkill> = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let folder_name = match path.file_name().and_then(|s| s.to_str()) {
                Some(s) => s.to_string(),
                None => continue,
            };
            // Skip _shared (resolver helpers, not user-invocable).
            if folder_name.starts_with('_') {
                continue;
            }
            let skill_md = path.join("SKILL.md");
            let body = fs::read_to_string(&skill_md).unwrap_or_default();
            let (fm_name, fm_desc) = parse_skill_frontmatter(&body);
            skills.push(ClaudeSkill {
                name: if fm_name.is_empty() { folder_name } else { fm_name },
                description: fm_desc,
                path: skill_md.to_string_lossy().to_string(),
                usage_count: 0,
            });
        }
        skills.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(skills)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn count_claude_skill_usage(
    names: Vec<String>,
) -> Result<std::collections::HashMap<String, u32>, String> {
    tokio::task::spawn_blocking(move || count_skill_usage_cached(&names))
        .await
        .map_err(|e| format!("task join: {e}"))
}

#[tauri::command]
async fn list_mcp_servers() -> Result<Vec<McpServer>, String> {
    tokio::task::spawn_blocking(|| -> Result<Vec<McpServer>, String> {
        let mut servers: Vec<McpServer> = Vec::new();

        // 1. File-based servers under ~/.claude/mcp/. Active = .json,
        // disabled = .json.disabled (we own the convention).
        if let Some(mcp_dir) = claude_mcp_dir() {
            if let Ok(entries) = fs::read_dir(&mcp_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let fname = match path.file_name().and_then(|s| s.to_str()) {
                        Some(s) => s.to_string(),
                        None => continue,
                    };
                    let (stem, enabled) = if let Some(s) = fname.strip_suffix(".json") {
                        (s.to_string(), true)
                    } else if let Some(s) = fname.strip_suffix(".json.disabled") {
                        (s.to_string(), false)
                    } else {
                        continue;
                    };
                    let body = fs::read_to_string(&path).unwrap_or_default();
                    let parsed: serde_json::Value =
                        serde_json::from_str(&body).unwrap_or_else(|_| serde_json::json!({}));
                    let command = parsed
                        .get("command")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string();
                    let args: Vec<String> = parsed
                        .get("args")
                        .and_then(|v| v.as_array())
                        .map(|a| {
                            a.iter()
                                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                                .collect()
                        })
                        .unwrap_or_default();
                    servers.push(McpServer {
                        name: stem,
                        command,
                        args,
                        source: "config".to_string(),
                        enabled,
                        path: path.to_string_lossy().to_string(),
                    });
                }
            }
        }

        // 2. Plugin-bundled MCPs from settings.json#/enabledPlugins.
        // Format: { "engram@engram": true, ... }. The key is plugin@source.
        if let Some(settings_path) = claude_settings_path() {
            if let Ok(body) = fs::read_to_string(&settings_path) {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    if let Some(plugins) = json.get("enabledPlugins").and_then(|v| v.as_object()) {
                        for (key, val) in plugins {
                            servers.push(McpServer {
                                name: key.clone(),
                                command: String::new(),
                                args: vec![],
                                source: "plugin".to_string(),
                                enabled: val.as_bool().unwrap_or(false),
                                path: settings_path.to_string_lossy().to_string(),
                            });
                        }
                    }
                }
            }
        }

        servers.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(servers)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn toggle_mcp_server(name: String, source: String, enabled: bool) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        match source.as_str() {
            "config" => {
                let mcp_dir = claude_mcp_dir().ok_or("home dir unavailable")?;
                let active = mcp_dir.join(format!("{name}.json"));
                let disabled = mcp_dir.join(format!("{name}.json.disabled"));
                if enabled {
                    if disabled.exists() {
                        fs::rename(&disabled, &active)
                            .map_err(|e| format!("rename to enable: {e}"))?;
                    }
                } else if active.exists() {
                    fs::rename(&active, &disabled)
                        .map_err(|e| format!("rename to disable: {e}"))?;
                }
                Ok(())
            }
            "plugin" => {
                let settings_path = claude_settings_path().ok_or("home dir unavailable")?;
                let body = fs::read_to_string(&settings_path)
                    .map_err(|e| format!("read settings.json: {e}"))?;
                let mut json: serde_json::Value = serde_json::from_str(&body)
                    .map_err(|e| format!("parse settings.json: {e}"))?;
                let plugins = json
                    .as_object_mut()
                    .ok_or("settings.json is not an object")?
                    .entry("enabledPlugins")
                    .or_insert_with(|| serde_json::json!({}));
                // Surface the type mismatch instead of silently no-opping —
                // otherwise the rewrite below would persist `enabledPlugins`
                // unmodified and the renderer would think the toggle worked.
                let Some(map) = plugins.as_object_mut() else {
                    return Err("enabledPlugins is not an object".to_string());
                };
                map.insert(name, serde_json::Value::Bool(enabled));
                let pretty = serde_json::to_string_pretty(&json)
                    .map_err(|e| format!("serialize settings.json: {e}"))?;
                fs::write(&settings_path, pretty)
                    .map_err(|e| format!("write settings.json: {e}"))?;
                Ok(())
            }
            other => Err(format!("unknown MCP source: {other}")),
        }
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

// ─── Update channel ──────────────────────────────────────────────────────
//
// We don't ship a signed Tauri auto-updater bundle yet (no signing keys, no
// release pipeline). Instead, both update channels (this app and the
// gentle-ai CLI) hit the GitHub Releases REST API, compare semver, and let
// the renderer surface a banner. "Apply" for the app opens the release page;
// "apply" for gentle-ai shells out to the upstream PowerShell installer
// exactly the way the legacy SessionStart hook used to.
//
// When we eventually want true auto-update with atomic install + restart,
// swap in tauri-plugin-updater + signed release artifacts. The IPC contract
// below should stay stable so the frontend doesn't need to change.

const APP_RELEASES_REPO: &str = "IP-Mattos/claude-startup-kit";
const GENTLE_AI_RELEASES_REPO: &str = "Gentleman-Programming/gentle-ai";
// TODO(security): pin install.ps1 to a commit SHA — see engram #875 WARN-tier item 6.
// Today this fetches HEAD of `main`, so an upstream compromise (or a forced
// branch reset) lands directly in `irm <url> | iex` on the user's box.
const GENTLE_AI_INSTALLER_URL: &str =
    "https://raw.githubusercontent.com/Gentleman-Programming/gentle-ai/main/scripts/install.ps1";

#[derive(Serialize, Clone)]
pub struct UpdateStatus {
    pub available: bool,
    pub current: String,
    pub latest: String,
    pub release_url: String,
    pub notes: String,
    pub configured: bool,
}

#[derive(serde::Deserialize)]
struct GhRelease {
    tag_name: String,
    html_url: String,
    #[serde(default)]
    body: String,
}

// Strips a leading "v" so "v0.1.2" and "0.1.2" compare equal.
fn strip_v(s: &str) -> &str {
    s.strip_prefix('v').unwrap_or(s)
}

// Naive semver lex compare. Good enough for tag_name vs CARGO_PKG_VERSION
// where both sides are dotted numerics with optional leading "v".
fn version_is_newer(latest: &str, current: &str) -> bool {
    let parse = |v: &str| -> Vec<u32> {
        strip_v(v)
            .split(|c: char| !c.is_ascii_digit())
            .filter(|p| !p.is_empty())
            .filter_map(|p| p.parse::<u32>().ok())
            .collect()
    };
    let l = parse(latest);
    let c = parse(current);
    for i in 0..l.len().max(c.len()) {
        let li = l.get(i).copied().unwrap_or(0);
        let ci = c.get(i).copied().unwrap_or(0);
        if li != ci {
            return li > ci;
        }
    }
    false
}

async fn fetch_latest_release(repo: &str) -> Result<GhRelease, String> {
    // Use the gh CLI's authenticated API channel instead of an anonymous
    // HTTP fetch. Anonymous requests share a tight 60/hour rate limit per
    // IP and routinely 403 when other tools on the machine (engram itself,
    // for example) have already burned the budget. Authenticated calls get
    // 5000/hour, which is effectively unlimited for our use case.
    let endpoint = format!("repos/{repo}/releases/latest");
    let out = tokio::task::spawn_blocking(move || -> Result<std::process::Output, String> {
        silent_command("gh")
            .args(["api", &endpoint, "-H", "Accept: application/vnd.github+json"])
            .output()
            .map_err(|e| format!("spawn gh: {e}"))
    })
    .await
    .map_err(|e| format!("task join: {e}"))??;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("gh api {repo}: {stderr}").trim().to_string());
    }
    serde_json::from_slice::<GhRelease>(&out.stdout)
        .map_err(|e| format!("parse release json: {e}"))
}

#[tauri::command]
async fn check_app_update() -> Result<UpdateStatus, String> {
    let current = env!("CARGO_PKG_VERSION").to_string();
    match fetch_latest_release(APP_RELEASES_REPO).await {
        Ok(rel) => {
            let latest = strip_v(&rel.tag_name).to_string();
            Ok(UpdateStatus {
                available: version_is_newer(&latest, &current),
                current,
                latest,
                release_url: rel.html_url,
                notes: rel.body,
                configured: true,
            })
        }
        Err(_) => {
            // No releases published yet (404) or network failure — treat as
            // "not configured" rather than an error so the UI degrades cleanly.
            Ok(UpdateStatus {
                available: false,
                current,
                latest: String::new(),
                release_url: String::new(),
                notes: String::new(),
                configured: false,
            })
        }
    }
}

/// Atomic auto-update of the app itself.
///
/// Uses `tauri-plugin-updater` against the `latest.json` manifest published
/// by the release workflow. The plugin downloads the new bundle, verifies
/// its signature against the public key embedded in `tauri.conf.json`,
/// replaces the running binary, and restarts the app. The function never
/// actually returns to the renderer on the happy path — `app.restart()`
/// swaps the process. The `Result<(), String>` signature is for the error
/// path (network failure, signature mismatch, "no update available").
#[tauri::command]
async fn apply_app_update(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;
    let updater = app
        .updater()
        .map_err(|e| format!("updater unavailable: {e}"))?;
    let update = updater
        .check()
        .await
        .map_err(|e| format!("update check failed: {e}"))?
        .ok_or_else(|| "no update available".to_string())?;
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| format!("download/install failed: {e}"))?;
    app.restart()
}

// Locate the gentle-ai binary. Why this isn't just `silent_command("gentle-ai")`:
// after a Tauri auto-update, the new app instance can inherit a PATH that
// excludes user-scoped install dirs (`%LOCALAPPDATA%\gentle-ai\bin\` etc.),
// so `gentle-ai` resolves nowhere even though the binary is installed.
// We check the PATH ourselves first, then fall back to well-known install
// locations the upstream installer drops the binary into. Returns the program
// argument to pass to `silent_command` — either the bare name (when PATH
// resolves it) or an absolute path.
fn resolve_gentle_ai() -> Option<String> {
    // 1. Check PATH manually so we don't depend on the inherited PATH being
    //    fully expanded. If `where gentle-ai` would find it, return the bare
    //    name — Command::new will resolve it the same way.
    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            for candidate in ["gentle-ai.exe", "gentle-ai"] {
                if dir.join(candidate).is_file() {
                    return Some("gentle-ai".to_string());
                }
            }
        }
    }
    // 2. Fall back to known install dirs the gentle-ai installer writes to.
    //    These are the locations the upstream `irm | iex` PowerShell installer
    //    targets (LOCALAPPDATA primary, USERPROFILE-scoped alternatives).
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(&local).join("gentle-ai\\bin\\gentle-ai.exe"));
    }
    if let Some(home) = dirs_home() {
        candidates.push(home.join(".local").join("bin").join("gentle-ai.exe"));
        candidates.push(home.join("go").join("bin").join("gentle-ai.exe"));
        candidates.push(home.join("AppData").join("Local").join("gentle-ai").join("bin").join("gentle-ai.exe"));
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

fn read_gentle_ai_version() -> String {
    // No binary found anywhere — propagate as empty so the UI surfaces
    // "not configured" with the install hint instead of a noisy error.
    let Some(program) = resolve_gentle_ai() else {
        return String::new();
    };
    let out = silent_command(&program).arg("version").output();
    let bytes = match out {
        Ok(o) if o.status.success() => o.stdout,
        _ => return String::new(),
    };
    extract_semver(&String::from_utf8_lossy(&bytes)).unwrap_or_default()
}

/// First semver-shaped triplet (M.m.p) in the input wins. Used to scrape
/// `--version` / `version` output without depending on the layout being
/// stable across upstream tools.
fn extract_semver(text: &str) -> Option<String> {
    for token in text.split(|c: char| !c.is_ascii_digit() && c != '.') {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() == 3 && parts.iter().all(|p| p.parse::<u32>().is_ok()) {
            return Some(token.to_string());
        }
    }
    None
}

/// File extensions a managed tool can present on Windows. `.exe` is native;
/// `.cmd` / `.bat` are typical npm-global wrappers; `.ps1` is what
/// gentle-ai's installer drops next to bash scripts so PowerShell can drive
/// them through Git Bash. Order matters — first match wins, prefer native.
const MANAGED_TOOL_EXTENSIONS: &[&str] = &["exe", "cmd", "bat", "ps1"];

/// Locate a managed CLI tool (engram, gga, …) the same way `resolve_gentle_ai`
/// locates gentle-ai itself: PATH first, then well-known install dirs the
/// upstream installers drop binaries into.
///
/// Returns the absolute path so `read_managed_tool_version` can pick the
/// right invocation strategy (cmd /c for .cmd/.bat, powershell for .ps1).
///
/// Why this exists: gentle-ai's `update` table is the source of truth for
/// versions, but its detector occasionally lies about installation state on
/// Windows — for example reporting `engram` as `[--]` or `gga` as `[--]`
/// even when both are reachable from a fresh terminal. We use this resolver
/// in `check_stack_update` to override the false negative locally.
fn resolve_managed_tool(name: &str) -> Option<String> {
    let try_dir = |dir: &Path| -> Option<PathBuf> {
        for ext in MANAGED_TOOL_EXTENSIONS {
            let candidate = dir.join(format!("{name}.{ext}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        None
    };

    if let Some(path_var) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path_var) {
            if let Some(found) = try_dir(&dir) {
                return Some(found.to_string_lossy().into_owned());
            }
        }
    }

    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        dirs.push(PathBuf::from(&local).join(name).join("bin"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        // npm install -g target on Windows.
        dirs.push(PathBuf::from(&appdata).join("npm"));
    }
    if let Some(home) = dirs_home() {
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join("go").join("bin"));
        // Where gentle-ai's installer drops gga.ps1 + the bash script.
        dirs.push(home.join("bin"));
        dirs.push(
            home.join("AppData")
                .join("Local")
                .join(name)
                .join("bin"),
        );
    }

    for dir in dirs {
        if let Some(found) = try_dir(&dir) {
            return Some(found.to_string_lossy().into_owned());
        }
    }
    None
}

/// Best-effort version probe. Picks the right invocation strategy from the
/// resolved file extension:
///   .cmd / .bat → `cmd /c <path> <arg>`        (Windows shell needed)
///   .ps1        → `powershell -NoProfile -Command "& '<path>' <arg>"`
///   else        → `<path> <arg>`               (native exe)
///
/// Tries `--version` first, then `version`. Scans stdout then stderr for the
/// first semver-shaped triplet. Used to confirm a tool is *actually*
/// installed when gentle-ai's detector reports otherwise.
fn read_managed_tool_version(program: &str) -> Option<String> {
    let lower = program.to_lowercase();
    let is_shell_wrapper = lower.ends_with(".cmd") || lower.ends_with(".bat");
    let is_powershell_wrapper = lower.ends_with(".ps1");

    for arg in ["--version", "version"] {
        let result = if is_shell_wrapper {
            silent_command("cmd").args(["/c", program, arg]).output()
        } else if is_powershell_wrapper {
            // Single-quote the path for PowerShell — escape embedded
            // quotes by doubling per PS string literal rules.
            let escaped = program.replace('\'', "''");
            let line = format!("& '{escaped}' {arg}");
            silent_command("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &line])
                .output()
        } else {
            silent_command(program).arg(arg).output()
        };

        if let Ok(out) = result {
            if out.status.success() {
                let text = String::from_utf8_lossy(&out.stdout);
                if let Some(v) = extract_semver(&text) {
                    return Some(v);
                }
                let stderr = String::from_utf8_lossy(&out.stderr);
                if let Some(v) = extract_semver(&stderr) {
                    return Some(v);
                }
            }
        }
    }
    None
}

#[tauri::command]
async fn check_gentle_ai_update() -> Result<UpdateStatus, String> {
    let current = tokio::task::spawn_blocking(read_gentle_ai_version)
        .await
        .map_err(|e| format!("task join: {e}"))?;
    if current.is_empty() {
        // gentle-ai not installed (or not on PATH). Surface as not-configured
        // so the UI can show a CTA to install it instead of a noisy error.
        return Ok(UpdateStatus {
            available: false,
            current: String::new(),
            latest: String::new(),
            release_url: String::new(),
            notes: String::new(),
            configured: false,
        });
    }
    let rel = fetch_latest_release(GENTLE_AI_RELEASES_REPO).await?;
    let latest = strip_v(&rel.tag_name).to_string();
    Ok(UpdateStatus {
        available: version_is_newer(&latest, &current),
        current,
        latest,
        release_url: rel.html_url,
        notes: rel.body,
        configured: true,
    })
}

// ─── Workspace summary ───────────────────────────────────────────────────
//
// Powers the right-panel Workspace card. Returns the four signals the user
// wanted in one round trip: app version, gentle-ai version, engram memory
// stats, and skill utilization (skills with any recorded usage in the last
// 7 days vs the total skills installed). Unreachable sources degrade to
// `None` instead of erroring so the card always renders.

#[derive(Serialize, Clone)]
pub struct WorkspaceSummary {
    pub app_version: String,
    pub gentle_ai_version: Option<String>,
    pub engram_sessions: Option<u32>,
    pub engram_observations: Option<u32>,
    pub skills_total: u32,
    pub skills_used: u32,
}

// 5-minute TTL cache. Mirrors KNOWN_PROJECTS_CACHE — every WorkspaceCard mount
// hits engram + scans up to 200 JSONLs for skill counts (3-5s wall time) so
// caching the assembled summary keeps repeated navigations cheap.
struct WorkspaceSummaryCache {
    value: WorkspaceSummary,
    fetched_at: Instant,
}

static WORKSPACE_SUMMARY_CACHE: Lazy<Mutex<Option<WorkspaceSummaryCache>>> =
    Lazy::new(|| Mutex::new(None));

const WORKSPACE_SUMMARY_TTL: Duration = Duration::from_secs(5 * 60);

// `engram stats` prints lines like:
//   Engram Memory Stats
//     Sessions:     20
//     Observations: 421
// We grep for those two labels and pull the first integer that follows.
fn read_engram_stats() -> (Option<u32>, Option<u32>) {
    let out = match silent_command("engram").arg("stats").output() {
        Ok(o) if o.status.success() => o,
        _ => return (None, None),
    };
    let text = String::from_utf8_lossy(&out.stdout);
    let extract = |label: &str| -> Option<u32> {
        text.lines()
            .find(|l| l.trim_start().starts_with(label))
            .and_then(|line| {
                line.split_whitespace()
                    .filter_map(|tok| tok.parse::<u32>().ok())
                    .next()
            })
    };
    (extract("Sessions:"), extract("Observations:"))
}

#[tauri::command]
async fn workspace_summary() -> Result<WorkspaceSummary, String> {
    {
        let guard = WORKSPACE_SUMMARY_CACHE.lock().unwrap();
        if let Some(entry) = guard.as_ref() {
            if entry.fetched_at.elapsed() < WORKSPACE_SUMMARY_TTL {
                return Ok(entry.value.clone());
            }
        }
    }
    let summary = tokio::task::spawn_blocking(|| -> Result<WorkspaceSummary, String> {
        let app_version = env!("CARGO_PKG_VERSION").to_string();
        let gentle_ai_version = {
            let v = read_gentle_ai_version();
            if v.is_empty() {
                None
            } else {
                Some(v)
            }
        };
        let (engram_sessions, engram_observations) = read_engram_stats();

        // Skills: enumerate folders under ~/.claude/skills/, then run the
        // shared count_skill_usage so the card and the Claude tab agree.
        let mut skills_total: u32 = 0;
        let mut skill_names: Vec<String> = Vec::new();
        if let Some(dir) = claude_skills_dir() {
            if let Ok(entries) = fs::read_dir(&dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if !path.is_dir() {
                        continue;
                    }
                    let name = match path.file_name().and_then(|s| s.to_str()) {
                        Some(s) => s.to_string(),
                        None => continue,
                    };
                    if name.starts_with('_') {
                        continue;
                    }
                    let skill_md = path.join("SKILL.md");
                    let body = fs::read_to_string(&skill_md).unwrap_or_default();
                    let (fm_name, _) = parse_skill_frontmatter(&body);
                    skills_total = skills_total.saturating_add(1);
                    skill_names.push(if fm_name.is_empty() { name } else { fm_name });
                }
            }
        }
        let counts = count_skill_usage_cached(&skill_names);
        let skills_used = counts.values().filter(|&&v| v > 0).count() as u32;

        Ok(WorkspaceSummary {
            app_version,
            gentle_ai_version,
            engram_sessions,
            engram_observations,
            skills_total,
            skills_used,
        })
    })
    .await
    .map_err(|e| format!("task join: {e}"))??;
    let mut guard = WORKSPACE_SUMMARY_CACHE.lock().unwrap();
    *guard = Some(WorkspaceSummaryCache {
        value: summary.clone(),
        fetched_at: Instant::now(),
    });
    Ok(summary)
}

#[tauri::command]
async fn apply_gentle_ai_update() -> Result<String, String> {
    // Mirrors the legacy SessionStart hook: irm <installer> | iex via
    // PowerShell. We capture combined stdout+stderr so the renderer can show
    // a useful tail if something goes wrong.
    let cmd = format!("irm {GENTLE_AI_INSTALLER_URL} | iex");
    let out = tokio::task::spawn_blocking(move || -> Result<std::process::Output, String> {
        silent_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
            .output()
            .map_err(|e| format!("spawn powershell: {e}"))
    })
    .await
    .map_err(|e| format!("task join: {e}"))??;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        let stdout = String::from_utf8_lossy(&out.stdout);
        return Err(format!(
            "installer exited {}:\n{stderr}\n{stdout}",
            out.status
        ));
    }
    // Re-read installed version so the UI can confirm the upgrade.
    let after = tokio::task::spawn_blocking(read_gentle_ai_version)
        .await
        .map_err(|e| format!("task join: {e}"))?;
    Ok(after)
}

// ─── Stack updates via gentle-ai (single source of truth) ────────────────
//
// gentle-ai already manages every CLI tool in the Gentle stack (engram, gga,
// opencode-*, gentle-ai itself). Instead of having CSK reimplement each
// channel separately we delegate: parse `gentle-ai update` for state and
// fire `gentle-ai upgrade` to apply. New tools added by gentle-ai upstream
// show up here automatically with no app changes — that's the whole point.
//
// CSK's own self-update stays separate (Tauri updater plugin), since it has
// to swap the running binary atomically with signature verification.

#[derive(Serialize, Clone)]
pub struct StackToolStatus {
    pub name: String,
    /// `None` when gentle-ai prints "-" (tool isn't installed locally).
    pub installed: Option<String>,
    pub latest: String,
    /// `up_to_date` | `update_available` | `not_installed`. We stringify so
    /// the renderer can render unknown variants without breaking if gentle-ai
    /// adds a new state down the line.
    pub state: String,
}

/// Parse one line of `gentle-ai update`. Returns `None` for header / footer
/// lines or anything that doesn't match `[STATE] NAME ... installed: X ... latest: Y`.
///
/// Examples accepted:
///   `  [ok] gentle-ai     installed: 1.25.4      latest: 1.25.4`
///   `  [--] gga           installed: -           latest: 2.8.1`
///   `  [!]  engram        installed: 1.15.0      latest: 1.15.4`
///
/// We avoid the `regex` crate (no extra dep) — the format is regular enough
/// for byte-level parsing.
fn parse_gentle_ai_update_line(line: &str) -> Option<StackToolStatus> {
    let trimmed = line.trim_start();
    if !trimmed.starts_with('[') {
        return None;
    }
    let close = trimmed.find(']')?;
    let marker = trimmed[1..close].trim();
    let rest = trimmed[close + 1..].trim_start();
    let installed_idx = rest.find("installed:")?;
    let name = rest[..installed_idx].trim();
    if name.is_empty() {
        return None;
    }
    // gentle-ai update line looks like:
    //   `installed: 1.25.5    latest: 1.25.6 irm https://.../install.ps1 | iex`
    // After "installed:" we want the first whitespace-delimited token (the
    // version); same for "latest:". Greedy trim-to-end captured the whole
    // install hint as the "latest" version and rendered it in the UI as
    // "v1.25.6 irm https://...".
    let after_installed = &rest[installed_idx + "installed:".len()..];
    let latest_idx = after_installed.find("latest:")?;
    let installed_raw = after_installed[..latest_idx]
        .split_whitespace()
        .next()
        .unwrap_or("");
    let latest = after_installed[latest_idx + "latest:".len()..]
        .split_whitespace()
        .next()
        .unwrap_or("");
    if latest.is_empty() {
        return None;
    }
    let installed = if installed_raw == "-" || installed_raw.is_empty() {
        None
    } else {
        Some(installed_raw.to_string())
    };
    // Marker semantics. `ok` = up to date, `--` = not installed.
    // Anything else (`!`, `up`, `↑`, etc.) we conservatively treat as
    // "update available" so the UI surfaces an actionable row.
    let state = match marker {
        "ok" => "up_to_date",
        "--" => "not_installed",
        _ => "update_available",
    };
    Some(StackToolStatus {
        name: name.to_string(),
        installed,
        latest: latest.to_string(),
        state: state.to_string(),
    })
}

/// Run `gentle-ai update` and parse the table into structured rows.
/// Returns an empty vec (not an error) if `gentle-ai` isn't on PATH so the UI
/// can render "stack tooling not configured" without surfacing a noisy error.
///
/// Uses `resolve_gentle_ai()` instead of bare `gentle-ai` because the Tauri
/// auto-updater can hand the new app instance a PATH that's missing
/// `%LOCALAPPDATA%\gentle-ai\bin\`. Without this, the spawn errors and the
/// UI shows "No managed tools detected" even when gentle-ai is fully
/// installed and reachable from a fresh terminal.
#[tauri::command]
async fn check_stack_update() -> Result<Vec<StackToolStatus>, String> {
    tokio::task::spawn_blocking(|| -> Result<Vec<StackToolStatus>, String> {
        let Some(program) = resolve_gentle_ai() else {
            // gentle-ai genuinely missing — soft-fail with empty list.
            return Ok(Vec::new());
        };
        let out = match silent_command(&program).arg("update").output() {
            Ok(o) => o,
            Err(_) => return Ok(Vec::new()),
        };
        if !out.status.success() {
            // gentle-ai exited non-zero — usually a transient network issue
            // when checking remote releases. Surface as error so the renderer
            // can show a "Reintentar" affordance.
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Err(format!("gentle-ai update failed: {}", stderr.trim()));
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut rows = stdout
            .lines()
            .filter_map(parse_gentle_ai_update_line)
            .collect::<Vec<_>>();
        // Detection-override: gentle-ai's installation detector occasionally
        // reports a tool as `[--]` (not installed) when the binary is in
        // fact reachable on the user's machine. When that happens we fall
        // back to our own resolver — same PATH + well-known-dirs walk we
        // already use for gentle-ai itself — and probe `--version`/`version`
        // to confirm. If we find a real version, we re-derive `state` from
        // the installed-vs-latest comparison so the UI stops lying.
        for row in rows.iter_mut() {
            if row.state != "not_installed" {
                continue;
            }
            let Some(program) = resolve_managed_tool(&row.name) else {
                continue;
            };
            let Some(installed) = read_managed_tool_version(&program) else {
                continue;
            };
            row.state = if version_is_newer(&row.latest, &installed) {
                "update_available".to_string()
            } else {
                "up_to_date".to_string()
            };
            row.installed = Some(installed);
        }
        Ok(rows)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

/// Tools whose binaries can be live when the upgrade runs. On Windows a
/// running .exe can't be renamed/replaced, so `gentle-ai upgrade` fails with
/// "rename ...engram-upgrade-NNN" errors. We taskkill these before delegating
/// to gentle-ai. The upstream tool doesn't do this dance itself; CSK fills
/// the gap so the user gets a clean single-click "update all" experience.
///
/// Claude Code re-spawns its MCP servers (engram, etc.) on the next session,
/// so killing them mid-app is recoverable — the user just won't have engram
/// available in *currently open* Claude Code instances until they reload.
const STACK_TOOL_PROCESS_NAMES: &[&str] = &["engram", "gga"];

/// Run `gentle-ai upgrade` (applies updates to ALL managed tools in one call).
///
/// Pre-step: kill known managed tool processes so Windows doesn't block the
/// rename-then-replace inside the upgrade.
///
/// Post-step: detect gentle-ai's "manual update required" self-skip and run
/// the upstream PowerShell installer directly to actually bring gentle-ai
/// itself up to date. gentle-ai upstream can't replace its own running
/// binary on Windows; it logs "manual update required" and exits 0 with
/// "1 skipped". Without this branch, "Update all" silently does nothing
/// when the only thing pending IS gentle-ai itself.
///
/// Returns the upgrade output as a string so the renderer can display the
/// post-run summary. `gentle-ai upgrade` is idempotent — running it when
/// everything's already current is a no-op.
#[tauri::command]
async fn apply_stack_update() -> Result<String, String> {
    tokio::task::spawn_blocking(|| -> Result<String, String> {
        // Kill any live instances of managed tool binaries. Errors here are
        // best-effort (process might already be gone, or `taskkill` might
        // need admin for some) — they don't block the upgrade attempt.
        for name in STACK_TOOL_PROCESS_NAMES {
            let _ = silent_command("taskkill")
                .args(["/IM", &format!("{}.exe", name), "/F"])
                .output();
        }
        // Tiny delay so Windows fully releases the file handles before
        // gentle-ai tries to write.
        std::thread::sleep(Duration::from_millis(800));

        // Resolve gentle-ai's actual install location — same PATH-inheritance
        // dance as check_stack_update / read_gentle_ai_version. Without this,
        // the upgrade silently no-ops on auto-updated app instances.
        let program = resolve_gentle_ai()
            .ok_or_else(|| "gentle-ai not installed on this machine".to_string())?;

        // Phase 1 — `gentle-ai upgrade` for everything except gentle-ai itself.
        let out = silent_command(&program)
            .arg("upgrade")
            .output()
            .map_err(|e| format!("spawn gentle-ai: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            return Err(format!("gentle-ai upgrade exited {}:\n{stderr}\n{stdout}", out.status));
        }
        let mut log = String::from_utf8_lossy(&out.stdout).into_owned();

        // Phase 2 — if gentle-ai self-skipped (Windows can't replace the
        // running .exe), bootstrap it via the upstream installer. Detected by
        // the literal phrase the upstream prints; if upstream rewords it
        // someday this branch becomes a no-op (we just don't self-upgrade —
        // not a regression).
        let needs_self_upgrade = log.contains("manual update required")
            && log.contains("gentle-ai");
        if needs_self_upgrade {
            let installer_cmd = format!("irm {GENTLE_AI_INSTALLER_URL} | iex");
            let installer_out = silent_command("powershell")
                .args(["-NoProfile", "-NonInteractive", "-Command", &installer_cmd])
                .output()
                .map_err(|e| format!("spawn powershell: {e}"))?;
            let installer_stdout = String::from_utf8_lossy(&installer_out.stdout);
            let installer_stderr = String::from_utf8_lossy(&installer_out.stderr);
            log.push_str("\n--- gentle-ai self-upgrade via installer ---\n");
            log.push_str(&installer_stdout);
            if !installer_out.status.success() {
                log.push_str("\n[stderr]\n");
                log.push_str(&installer_stderr);
                return Err(format!(
                    "gentle-ai installer exited {}: see log\n{log}",
                    installer_out.status
                ));
            }
        }

        Ok(log)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

/// Open gentle-ai's interactive install wizard in a NEW visible console
/// window. The wizard is the only path upstream offers to install managed
/// tools that aren't on the machine yet (engram, gga, opencode-*) — there's
/// no `gentle-ai install <name>` for non-interactive use, and we won't
/// hardcode per-tool installer URLs (fragile when upstream moves them).
///
/// Spawn shape: `cmd /c <gentle-ai> install & timeout /t 8 /nobreak` with
/// `CREATE_NEW_CONSOLE`. The wizard runs in the new console; after it
/// exits, `timeout` shows a visible 8-second countdown so the user reads
/// the final summary; then the window auto-closes. `/nobreak` ignores
/// Ctrl-C so the countdown can't be skipped accidentally.
///
/// Args are passed individually (not via a quoted shell line) so Rust's
/// command-line escaping handles spaces in the gentle-ai path correctly
/// without us hand-rolling cmd.exe's quoting rules.
#[tauri::command]
fn open_stack_install_wizard() -> Result<(), String> {
    let program = resolve_gentle_ai()
        .ok_or_else(|| "gentle-ai not installed on this machine".to_string())?;
    let mut cmd = std::process::Command::new("cmd");
    cmd.args([
        "/c", &program, "install", "&", "timeout", "/t", "8", "/nobreak",
    ]);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
        cmd.creation_flags(CREATE_NEW_CONSOLE);
    }
    cmd.spawn()
        .map_err(|e| format!("spawn install wizard: {e}"))?;
    Ok(())
}

// ─── Workspace sync (Engram-only over a private GitHub repo) ─────────────
//
// Sync only the engram export — not Claude Code's raw JSONL transcripts.
// JSONLs are append-only and grow fast; engram is the distilled memory.
// Repo holds a single file (engram-export.json) and we squash history each
// sync via `git commit --amend` + `--force-with-lease` so the repo never
// bloats. Single-author single-file means no merge conflicts in practice.
//
// Local state lives at ~/.claude/.csk-sync/state.json (per-machine, not
// synced). The clone lives at ~/.claude/.csk-sync/repo/.

const SYNC_FILE_NAME: &str = "engram-export.json";
const SYNC_PROJECTS_FILE: &str = "projects.json";

#[derive(Serialize, serde::Deserialize, Clone)]
pub struct SyncedProject {
    /// Folder name extracted from the cwd path.
    pub name: String,
    /// Git remote (origin). Stored stripped of trailing newlines.
    pub remote_url: String,
}

/// Walk ~/.claude/projects/<hash>/, resolve each project's cwd via the
/// first JSONL entry, then ask git for the origin remote. Projects
/// without a git remote (no .git, or local-only) are skipped — the sync
/// catalogue is GitHub-clone-driven.
fn list_local_projects_with_remote() -> Vec<SyncedProject> {
    let dir = match claude_projects_dir() {
        Some(d) => d,
        None => return vec![],
    };
    let mut out: Vec<SyncedProject> = Vec::new();
    let mut seen_remotes: std::collections::HashSet<String> = Default::default();
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return out,
    };
    for entry in entries.flatten() {
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        // Reuse the existing helper that pulls cwd from a list of JSONLs.
        let jsonls: Vec<PathBuf> = match fs::read_dir(&project_dir) {
            Ok(entries) => entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().and_then(|s| s.to_str()) == Some("jsonl"))
                .collect(),
            Err(_) => continue,
        };
        if jsonls.is_empty() {
            continue;
        }
        let cwd = match first_cwd_in_jsonls(&jsonls) {
            Some(c) => c,
            None => continue,
        };
        let cwd_path = Path::new(&cwd);
        if !cwd_path.exists() {
            // Project's source folder was moved or deleted — skip.
            continue;
        }
        let remote = match silent_command("git")
            .args(["-C"])
            .arg(&cwd)
            .args(["remote", "get-url", "origin"])
            .output()
        {
            Ok(o) if o.status.success() => {
                String::from_utf8_lossy(&o.stdout).trim().to_string()
            }
            _ => continue,
        };
        if remote.is_empty() {
            continue;
        }
        if !seen_remotes.insert(remote.clone()) {
            // Multiple JSONL projects can point at the same repo; dedupe.
            continue;
        }
        let name = cwd_path
            .file_name()
            .and_then(|s| s.to_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| "project".to_string());
        out.push(SyncedProject {
            name,
            remote_url: remote,
        });
    }
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

#[derive(Serialize, Clone, serde::Deserialize, Default)]
pub struct SyncState {
    pub configured: bool,
    pub remote_url: String,
    pub repo_full_name: String, // "user/repo"
    pub last_sync_at: Option<u64>,
    pub last_sync_kind: Option<String>, // "export" | "import"
    pub last_error: Option<String>,
}

fn sync_dir() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".claude").join(".csk-sync"))
}

fn sync_state_path() -> Option<PathBuf> {
    sync_dir().map(|d| d.join("state.json"))
}

fn sync_repo_dir() -> Option<PathBuf> {
    sync_dir().map(|d| d.join("repo"))
}

fn read_sync_state() -> SyncState {
    let path = match sync_state_path() {
        Some(p) => p,
        None => return SyncState::default(),
    };
    let body = match fs::read_to_string(&path) {
        Ok(b) => b,
        Err(_) => return SyncState::default(),
    };
    serde_json::from_str(&body).unwrap_or_default()
}

fn write_sync_state(state: &SyncState) -> Result<(), String> {
    let dir = sync_dir().ok_or("home dir unavailable")?;
    fs::create_dir_all(&dir).map_err(|e| format!("create sync dir: {e}"))?;
    let path = dir.join("state.json");
    let body = serde_json::to_string_pretty(state)
        .map_err(|e| format!("serialize sync state: {e}"))?;
    fs::write(&path, body).map_err(|e| format!("write sync state: {e}"))
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[tauri::command]
fn sync_status() -> Result<SyncState, String> {
    Ok(read_sync_state())
}

// Run a `git` subcommand inside the sync repo. Returns combined output
// trimmed of trailing whitespace. Used to keep call sites short.
fn git_in(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = silent_command("git")
        .current_dir(repo)
        .args(args)
        .output()
        .map_err(|e| format!("spawn git: {e}"))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git {} failed: {stderr}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

// Returns the authenticated `gh` user's login. Used in SyncView to preview
// the full repo path the user is about to create (`<login>/<repo_name>`)
// without having to run the actual `sync_setup` first. Returns an empty
// string if `gh` isn't authenticated — the renderer falls back to a
// generic placeholder rather than surfacing a noisy error.
#[tauri::command]
async fn gh_username() -> Result<String, String> {
    tokio::task::spawn_blocking(|| -> Result<String, String> {
        let out = silent_command("gh")
            .args(["api", "user", "--jq", ".login"])
            .output()
            .map_err(|e| format!("spawn gh: {e}"))?;
        if !out.status.success() {
            return Ok(String::new());
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

// `gh repo create` runs through the user's existing gh auth.
#[tauri::command]
async fn sync_setup(repo_name: String) -> Result<SyncState, String> {
    tokio::task::spawn_blocking(move || -> Result<SyncState, String> {
        // Resolve the gh user so the user only types the bare repo name.
        let owner_out = silent_command("gh")
            .args(["api", "user", "--jq", ".login"])
            .output()
            .map_err(|e| format!("spawn gh: {e}"))?;
        if !owner_out.status.success() {
            let stderr = String::from_utf8_lossy(&owner_out.stderr);
            return Err(format!(
                "gh not authenticated. Run `gh auth login`.\n{stderr}"
            ));
        }
        let owner = String::from_utf8_lossy(&owner_out.stdout).trim().to_string();
        if owner.is_empty() {
            return Err("gh returned an empty user".to_string());
        }
        let bare_name = repo_name.trim();
        if bare_name.is_empty() {
            return Err("repository name cannot be empty".to_string());
        }
        // Reject any owner-prefixed input (`org/name`) or flag-shaped input
        // (`-foo`). Without this guard a renderer-typed `org/name` overrides
        // the resolved gh user — confused-deputy with the user's stored PAT,
        // and a leading `-` could be parsed as a `gh repo create` flag.
        // Same shape as `clone_project`'s name validation.
        if bare_name.contains('/')
            || bare_name.contains('\\')
            || bare_name.starts_with('-')
        {
            return Err(format!(
                "rejected unsafe repo name '{bare_name}' — must be a plain repo name (no owner prefix, no leading dash)"
            ));
        }
        let full_name = format!("{owner}/{bare_name}");

        let repo_dir = sync_repo_dir().ok_or("home dir unavailable")?;
        if repo_dir.exists() {
            // Idempotency: tear down any stale half-setup before retrying.
            let _ = fs::remove_dir_all(&repo_dir);
        }
        fs::create_dir_all(repo_dir.parent().unwrap())
            .map_err(|e| format!("create sync parent: {e}"))?;

        // Try to create the repo. If it already exists (re-setup), continue.
        let create = silent_command("gh")
            .args([
                "repo",
                "create",
                &full_name,
                "--private",
                "--description",
                "Claude Startup Kit — engram memory sync",
            ])
            .output()
            .map_err(|e| format!("spawn gh repo create: {e}"))?;
        if !create.status.success() {
            let stderr = String::from_utf8_lossy(&create.stderr);
            // If the repo already exists, gh exits non-zero with a helpful
            // message — treat as success and continue to clone.
            if !stderr.contains("already exists") {
                return Err(format!("gh repo create: {stderr}"));
            }
        }

        // Clone over HTTPS so gh auth's stored credentials kick in.
        let remote_url = format!("https://github.com/{full_name}.git");
        let clone = silent_command("git")
            .args(["clone", &remote_url])
            .arg(&repo_dir)
            .output()
            .map_err(|e| format!("spawn git clone: {e}"))?;
        if !clone.status.success() {
            let stderr = String::from_utf8_lossy(&clone.stderr);
            return Err(format!("git clone: {stderr}"));
        }

        // Seed the repo with an empty export so the first push has content.
        let initial = repo_dir.join(SYNC_FILE_NAME);
        if !initial.exists() {
            fs::write(&initial, "{}").map_err(|e| format!("seed export: {e}"))?;
            git_in(&repo_dir, &["add", SYNC_FILE_NAME])?;
            // Ignore commit errors when there's nothing to commit (rare).
            let _ = git_in(&repo_dir, &["commit", "-m", "init: csk sync"]);
            let _ = git_in(&repo_dir, &["push", "-u", "origin", "HEAD"]);
        }

        let state = SyncState {
            configured: true,
            remote_url,
            repo_full_name: full_name,
            last_sync_at: None,
            last_sync_kind: None,
            last_error: None,
        };
        write_sync_state(&state)?;
        Ok(state)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn sync_export() -> Result<SyncState, String> {
    tokio::task::spawn_blocking(move || -> Result<SyncState, String> {
        let mut state = read_sync_state();
        if !state.configured {
            return Err("Workspace sync is not configured".to_string());
        }
        let repo_dir = sync_repo_dir().ok_or("home dir unavailable")?;
        if !repo_dir.exists() {
            return Err("Sync repo missing — run setup again".to_string());
        }
        let target = repo_dir.join(SYNC_FILE_NAME);

        // engram export <path> — overwrites the file in place.
        let out = silent_command("engram")
            .args(["export"])
            .arg(&target)
            .output()
            .map_err(|e| format!("spawn engram: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            state.last_error = Some(format!("engram export: {stderr}"));
            let _ = write_sync_state(&state);
            return Err(stderr.into_owned());
        }

        // Also dump the catalogue of projects with git remotes so the other
        // machine can `git clone` them straight from the sync card.
        let projects = list_local_projects_with_remote();
        let projects_path = repo_dir.join(SYNC_PROJECTS_FILE);
        let projects_json = serde_json::to_string_pretty(&projects)
            .map_err(|e| format!("serialize projects.json: {e}"))?;
        fs::write(&projects_path, projects_json)
            .map_err(|e| format!("write projects.json: {e}"))?;

        // Stage + amend (squash history into a single commit). If there's
        // no prior commit yet, fall back to a regular commit.
        git_in(&repo_dir, &["add", SYNC_FILE_NAME, SYNC_PROJECTS_FILE])?;
        let amend = silent_command("git")
            .current_dir(&repo_dir)
            .args(["commit", "--amend", "-m", "sync"])
            .output()
            .map_err(|e| format!("spawn git: {e}"))?;
        if !amend.status.success() {
            // No commit to amend (fresh repo) — make the first one.
            git_in(&repo_dir, &["commit", "-m", "sync"])?;
        }
        // --force-with-lease refuses if remote moved unexpectedly.
        git_in(&repo_dir, &["push", "--force-with-lease", "origin", "HEAD"])?;

        state.last_sync_at = Some(now_unix());
        state.last_sync_kind = Some("export".to_string());
        state.last_error = None;
        write_sync_state(&state)?;
        Ok(state)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn sync_import() -> Result<SyncState, String> {
    tokio::task::spawn_blocking(move || -> Result<SyncState, String> {
        let mut state = read_sync_state();
        if !state.configured {
            return Err("Workspace sync is not configured".to_string());
        }
        let repo_dir = sync_repo_dir().ok_or("home dir unavailable")?;
        if !repo_dir.exists() {
            return Err("Sync repo missing — run setup again".to_string());
        }

        // Hard-reset to remote HEAD. Local edits in the sync repo are
        // disposable — the engram db is the source of truth, not this file.
        git_in(&repo_dir, &["fetch", "origin"])?;
        // Default branch could be main or master. Use HEAD, which gh
        // populates on creation.
        let default_branch = git_in(
            &repo_dir,
            &["symbolic-ref", "refs/remotes/origin/HEAD"],
        )
        .ok()
        .and_then(|s| s.rsplit('/').next().map(|x| x.to_string()))
        .unwrap_or_else(|| "main".to_string());
        git_in(
            &repo_dir,
            &["reset", "--hard", &format!("origin/{default_branch}")],
        )?;

        let source = repo_dir.join(SYNC_FILE_NAME);
        if !source.exists() {
            return Err(format!("{SYNC_FILE_NAME} missing in remote"));
        }

        let out = silent_command("engram")
            .args(["import"])
            .arg(&source)
            .output()
            .map_err(|e| format!("spawn engram: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            state.last_error = Some(format!("engram import: {stderr}"));
            let _ = write_sync_state(&state);
            return Err(stderr.into_owned());
        }

        state.last_sync_at = Some(now_unix());
        state.last_sync_kind = Some("import".to_string());
        state.last_error = None;
        write_sync_state(&state)?;
        Ok(state)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[derive(Serialize, Clone)]
pub struct ClonedProject {
    pub remote_url: String,
    pub path: String,
    pub status: String, // "cloned" | "exists" | "error"
    pub message: String,
}

/// List of projects in the synced repo's projects.json. Returns empty if
/// not yet synced or if no remotes are tracked.
#[tauri::command]
async fn sync_listed_projects() -> Result<Vec<SyncedProject>, String> {
    tokio::task::spawn_blocking(|| -> Result<Vec<SyncedProject>, String> {
        let repo_dir = sync_repo_dir().ok_or("home dir unavailable")?;
        let path = repo_dir.join(SYNC_PROJECTS_FILE);
        if !path.exists() {
            return Ok(vec![]);
        }
        let body = fs::read_to_string(&path)
            .map_err(|e| format!("read projects.json: {e}"))?;
        let parsed: Vec<SyncedProject> =
            serde_json::from_str(&body).unwrap_or_default();
        Ok(parsed)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

/// Clone one repo into <target_dir>/<name>. If the destination already
/// exists, returns status="exists" instead of erroring (the user can
/// re-run safely). All errors are captured per-row so the frontend can
/// keep iterating through the rest of the list.
#[tauri::command]
async fn clone_project(
    remote_url: String,
    target_dir: String,
    name: String,
) -> Result<ClonedProject, String> {
    tokio::task::spawn_blocking(move || -> Result<ClonedProject, String> {
        let target_root = PathBuf::from(target_dir.trim());
        if target_root.as_os_str().is_empty() {
            return Err("target directory is empty".to_string());
        }
        if !target_root.exists() {
            fs::create_dir_all(&target_root)
                .map_err(|e| format!("create target dir: {e}"))?;
        }

        // Reject path-traversal in `name`: the renderer-supplied repo name
        // is concatenated to `target_root` via `Path::join`, which on Windows
        // *replaces* the base when the appended segment is absolute (`C:\...`)
        // and walks up the tree on `..` segments. A tampered sync mirror
        // could feed `name = "..\\..\\Startup\\foo"` and write outside the
        // user's chosen target dir. Allow only basic basename characters.
        let name_trimmed = name.trim();
        if name_trimmed.is_empty()
            || name_trimmed.contains('/')
            || name_trimmed.contains('\\')
            || name_trimmed.contains("..")
            || name_trimmed.contains(':')
            || name_trimmed.starts_with('-')
        {
            return Err(format!(
                "rejected unsafe project name '{name_trimmed}' — must be a plain folder name"
            ));
        }
        // Reject untrusted clone schemes. `git clone` historically accepted
        // local paths and, with crafted URLs (`ssh://-oProxyCommand=...`,
        // `--upload-pack=evil`), can reach RCE. Restrict to https / git over
        // ssh / git protocol from the start. The `--` separator below is the
        // belt-and-suspenders defense for the URL itself.
        let remote_trimmed = remote_url.trim();
        let allowed_scheme = remote_trimmed.starts_with("https://")
            || remote_trimmed.starts_with("git@")
            || remote_trimmed.starts_with("ssh://")
            || remote_trimmed.starts_with("git://");
        if !allowed_scheme || remote_trimmed.starts_with('-') {
            return Err(format!(
                "rejected remote URL '{remote_trimmed}' — must start with https:// / git@ / ssh:// / git://"
            ));
        }

        let dest = target_root.join(name_trimmed);
        if dest.exists() {
            // Idempotent: if the repo's already there, treat as a no-op.
            // The user can manually pull or move it; we don't second-guess.
            return Ok(ClonedProject {
                remote_url,
                path: dest.to_string_lossy().to_string(),
                status: "exists".to_string(),
                message: "destination already exists, skipped".to_string(),
            });
        }
        // `--` ends `git clone`'s flag parsing so a URL beginning with `-`
        // is treated verbatim and never as an option. Combined with the
        // scheme allowlist above, this rules out every documented git-URL
        // RCE we know of.
        let out = silent_command("git")
            .args(["clone", "--", remote_trimmed])
            .arg(&dest)
            .output()
            .map_err(|e| format!("spawn git clone: {e}"))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            return Ok(ClonedProject {
                remote_url,
                path: dest.to_string_lossy().to_string(),
                status: "error".to_string(),
                message: stderr.into_owned(),
            });
        }
        Ok(ClonedProject {
            remote_url,
            path: dest.to_string_lossy().to_string(),
            status: "cloned".to_string(),
            message: String::new(),
        })
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn sync_disconnect() -> Result<(), String> {
    tokio::task::spawn_blocking(|| -> Result<(), String> {
        if let Some(dir) = sync_dir() {
            // Remove local clone + state. The remote repo on GitHub stays —
            // user may want to re-attach later or manually delete.
            if dir.exists() {
                fs::remove_dir_all(&dir)
                    .map_err(|e| format!("remove sync dir: {e}"))?;
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Autostart: persists to HKCU\Software\Microsoft\Windows\CurrentVersion\Run on
        // Windows. The toggle is exposed in Settings; disabled by default so the user
        // opts in explicitly. `MacosLauncher::LaunchAgent` is a no-op on Windows but
        // the API requires the variant. `args = None` runs the app with no extra flags.
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .invoke_handler(tauri::generate_handler![
            scan_projects,
            git_last_commit,
            engram_known_projects,
            engram_project_goal,
            enrich_projects,
            run_audit,
            kill_process,
            restore_settings_backup,
            github_review_queue,
            cleanup_plan,
            cleanup_apply,
            open_in_vscode,
            open_path_in_explorer,
            open_url,
            check_app_update,
            apply_app_update,
            check_gentle_ai_update,
            apply_gentle_ai_update,
            check_stack_update,
            apply_stack_update,
            open_stack_install_wizard,
            workspace_summary,
            sync_status,
            sync_setup,
            gh_username,
            sync_export,
            sync_import,
            sync_disconnect,
            sync_listed_projects,
            clone_project,
            list_claude_skills,
            count_claude_skill_usage,
            list_mcp_servers,
            toggle_mcp_server
        ])
        .setup(|app| {
            let show_i = MenuItem::with_id(app, "show", "Mostrar ventana", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Salir", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let mut tray_builder = TrayIconBuilder::new();
            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }
            let _tray = tray_builder
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
