use chrono::{DateTime, Local, Utc};
use once_cell::sync::Lazy;
use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
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
async fn scan_projects(window_days: u64) -> Vec<Project> {
    tokio::task::spawn_blocking(move || scan_projects_blocking(window_days))
        .await
        .unwrap_or_default()
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

#[derive(Serialize, Clone)]
pub struct AuditFinding {
    pub level: String,
    pub category: String,
    pub title: String,
    pub detail: String,
}

fn run_audit_blocking() -> Result<Vec<AuditFinding>, String> {
    let script = dirs_home()
        .map(|h| h.join(".claude").join("scripts").join("claude-audit.ps1"))
        .ok_or_else(|| "no home directory".to_string())?;
    if !script.exists() {
        return Err(format!("audit script not found at {}", script.display()));
    }
    let output = silent_command("powershell")
        .args([
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            &script.to_string_lossy(),
            "-Json",
            "-NoNetwork",
        ])
        .output()
        .map_err(|e| format!("failed to run audit: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "audit exited with status {}",
            output.status.code().unwrap_or(-1)
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    // PowerShell JSON uses PascalCase fields; deserialize into a generic Value first.
    let raw: serde_json::Value =
        serde_json::from_str(trimmed).map_err(|e| format!("audit JSON parse: {e}"))?;
    let arr = raw.as_array().ok_or("audit output is not an array")?;
    let findings = arr
        .iter()
        .map(|item| AuditFinding {
            level: item
                .get("Level")
                .and_then(|v| v.as_str())
                .unwrap_or("INFO")
                .to_string(),
            category: item
                .get("Category")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            title: item
                .get("Title")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
            detail: item
                .get("Detail")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string(),
        })
        .collect();
    Ok(findings)
}

#[tauri::command]
async fn run_audit() -> Result<Vec<AuditFinding>, String> {
    tokio::task::spawn_blocking(run_audit_blocking)
        .await
        .map_err(|e| format!("audit task join error: {e}"))?
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
async fn enrich_projects(paths: Vec<String>) -> Vec<EnrichedProject> {
    // Resolve known engram projects ONCE for the whole batch (cached for 5min).
    let known = tokio::task::spawn_blocking(known_projects_cached)
        .await
        .unwrap_or_default();

    // Fan out: each path runs git+engram in parallel inside spawn_blocking.
    let mut handles = Vec::with_capacity(paths.len());
    for path in paths {
        let known_clone = known.clone();
        handles.push(tokio::task::spawn_blocking(move || {
            let git = git_last_commit_blocking(&path);
            let goal = engram_project_goal_blocking(&path, &known_clone);
            EnrichedProject { path, git, goal }
        }));
    }

    let mut out = Vec::with_capacity(handles.len());
    for h in handles {
        if let Ok(item) = h.await {
            out.push(item);
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
    tokio::task::spawn_blocking(move || count_skill_usage(&names))
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
                if let Some(map) = plugins.as_object_mut() {
                    map.insert(name, serde_json::Value::Bool(enabled));
                }
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

fn read_gentle_ai_version() -> String {
    let out = silent_command("gentle-ai").arg("version").output();
    let bytes = match out {
        Ok(o) if o.status.success() => o.stdout,
        _ => return String::new(),
    };
    let text = String::from_utf8_lossy(&bytes);
    // First semver-shaped triplet wins.
    for token in text.split(|c: char| !c.is_ascii_digit() && c != '.') {
        let parts: Vec<&str> = token.split('.').collect();
        if parts.len() == 3 && parts.iter().all(|p| p.parse::<u32>().is_ok()) {
            return token.to_string();
        }
    }
    String::new()
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
    tokio::task::spawn_blocking(|| -> Result<WorkspaceSummary, String> {
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
        let counts = count_skill_usage(&skill_names);
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
    .map_err(|e| format!("task join: {e}"))?
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
        let bare_name = repo_name.trim().trim_matches('/');
        if bare_name.is_empty() {
            return Err("repository name cannot be empty".to_string());
        }
        // Allow either "name" or "user/name". Normalize to user/name.
        let full_name = if bare_name.contains('/') {
            bare_name.to_string()
        } else {
            format!("{owner}/{bare_name}")
        };

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
        let dest = target_root.join(&name);
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
        let out = silent_command("git")
            .args(["clone", &remote_url])
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
