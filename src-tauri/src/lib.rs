use chrono::{DateTime, Local, Utc};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
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

/// Format a `Command::spawn` / `Command::output` IO error into a renderer-
/// friendly message.
///
/// On Windows the raw "program not found" error reads as `"The system
/// cannot find the file specified. (os error 2)"` — actionable to nobody.
/// We detect `ErrorKind::NotFound` and emit a localized hint instead. All
/// other IO errors fall through unchanged so we don't lose signal.
fn format_spawn_error(program: &str, err: &std::io::Error) -> String {
    if err.kind() == std::io::ErrorKind::NotFound {
        format!(
            "{program} no encontrado en PATH. Si lo instalaste recién, reiniciá Claude Startup Kit para que reconozca el PATH actualizado."
        )
    } else {
        format!("spawn {program}: {err}")
    }
}

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
    // Documentation / build markers — a folder with a README is one
    // someone documented intentionally, not stray junk. Same for a
    // Makefile or Dockerfile (build entry points). Catches data /
    // pipeline / research projects that don't have a code package
    // manager file.
    "README.md",
    "README.txt",
    "README.rst",
    "README",
    "Makefile",
    "Dockerfile",
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

/// Like `has_project_marker` but also accepts the **monorepo** shape: the
/// folder itself has no marker, but at least one immediate subfolder does.
/// User reported their `PetsNew` folder (a Laravel + landing-page meta
/// project) didn't show up because the parent had no marker even though
/// `pets/composer.json` and `landing/index.html` exist. Looking one level
/// deep catches that case without descending into deep recursion.
fn has_project_marker_or_monorepo(dir: &Path) -> bool {
    if has_project_marker(dir) {
        return true;
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return false;
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.is_dir() && has_project_marker(&p) {
            return true;
        }
    }
    false
}

/// Hardcoded blocklist of well-known umbrella directories that are NEVER
/// real projects, even if `has_project_marker_or_monorepo` would otherwise
/// accept them (Desktop is the worst offender — every dev folder under it
/// is a "subdirectory with marker", so without an explicit reject the
/// monorepo check would let Desktop through).
///
/// All paths derive from `dirs_home()` so they're universal across users.
fn is_known_umbrella_dir(path: &Path) -> bool {
    let Some(home) = dirs_home() else {
        return false;
    };
    let onedrive = home.join("OneDrive");
    let umbrellas: [PathBuf; 15] = [
        home.clone(),
        home.join("Desktop"),
        home.join("Documents"),
        home.join("Downloads"),
        home.join("Music"),
        home.join("Pictures"),
        home.join("Videos"),
        onedrive.clone(),
        onedrive.join("Desktop"),
        onedrive.join("Documents"),
        onedrive.join("Downloads"),
        onedrive.join("Music"),
        onedrive.join("Pictures"),
        onedrive.join("Videos"),
        // Common dev parent that the user runs Claude Code in occasionally
        // but isn't itself a project — the children are.
        home.join("OneDrive").join("Desktop").join("Code"),
    ];
    umbrellas.iter().any(|u| u == path)
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
        // like `C:\Users\<user>\OneDrive\Desktop` (or `~`) shows up here
        // because Claude Code recorded a session at that cwd. Two-step
        // check:
        //   1. Hard-reject if the path matches a well-known umbrella
        //      (Desktop, Documents, OneDrive\Desktop, etc.). Necessary
        //      because step 2 would otherwise admit Desktop as a "monorepo"
        //      since every subfolder has a marker.
        //   2. Accept if the folder itself has a marker, OR (monorepo case)
        //      at least one immediate subfolder does. Catches cases like
        //      `PetsNew/{landing,pets}` where the parent is the
        //      Claude-Code-recorded cwd but each child carries the marker.
        if is_known_umbrella_dir(&canonical) {
            continue;
        }
        if !has_project_marker_or_monorepo(&canonical) {
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

/// One row returned by `disk_scan_git_repos` — a real `.git` directory
/// found on disk via filesystem walk, regardless of Claude Code activity.
#[derive(Serialize, Clone)]
pub struct DiskGitRepo {
    pub path: String,
    pub name: String,
    /// `origin` remote URL if the repo has one; empty string otherwise.
    pub remote: String,
}

/// Directory names we never recurse into — keep the walk fast and avoid
/// false-positive "git repo" hits inside vendor / build / cache trees.
const DISK_SCAN_PRUNE: &[&str] = &[
    "node_modules",
    "target",          // Rust / Cargo
    "dist",
    "build",
    ".next",
    ".nuxt",
    "out",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    ".idea",
    ".vscode",
    "vendor",          // PHP / Go
    "Library",         // macOS / WSL artifacts under home
    "AppData",         // Windows: massive subtree, never user code
];

fn disk_scan_walk(
    dir: &Path,
    depth: u32,
    max_depth: u32,
    out: &mut Vec<DiskGitRepo>,
) {
    if depth > max_depth {
        return;
    }
    // If this directory IS a git repo (has `.git`), record it and STOP
    // recursing into subdirs — we don't want to surface every submodule
    // as its own project.
    let dot_git = dir.join(".git");
    if dot_git.exists() {
        let name = dir
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("repo")
            .to_string();
        let remote = silent_command("git")
            .args(["-C"])
            .arg(dir)
            .args(["remote", "get-url", "origin"])
            .output()
            .ok()
            .filter(|o| o.status.success())
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        out.push(DiskGitRepo {
            path: dir.to_string_lossy().into_owned(),
            name,
            remote,
        });
        return;
    }
    // Otherwise descend into subdirs (bounded by max_depth + prune list).
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        if name.starts_with('.') && name != ".git" {
            // Skip hidden dirs (.config, .ssh, etc.) — too much noise and
            // user code rarely lives behind a leading dot. The .git case
            // is handled above before recursion.
            continue;
        }
        if DISK_SCAN_PRUNE.iter().any(|p| *p == name) {
            continue;
        }
        disk_scan_walk(&path, depth + 1, max_depth, out);
    }
}

fn disk_scan_git_repos_blocking(
    roots: Vec<String>,
    max_depth: u32,
) -> Vec<DiskGitRepo> {
    let mut out: Vec<DiskGitRepo> = Vec::new();
    let mut seen: std::collections::HashSet<String> = Default::default();
    for raw in roots {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let root = Path::new(trimmed);
        if !root.is_dir() {
            continue;
        }
        let canonical = match fs::canonicalize(root) {
            Ok(c) => strip_unc_prefix(c),
            Err(_) => root.to_path_buf(),
        };
        if !seen.insert(canonical.to_string_lossy().into_owned()) {
            continue;
        }
        disk_scan_walk(&canonical, 0, max_depth, &mut out);
    }
    // Sort by name for stable rendering.
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Sensible starting points for `disk_scan_git_repos`. Returns the
/// well-known dev parent dirs that ALSO exist on the user's machine
/// (no point sending the renderer a path that doesn't resolve). All
/// paths derive from `dirs_home()` so this is universal across users.
#[tauri::command]
async fn default_disk_scan_roots() -> Vec<String> {
    tokio::task::spawn_blocking(|| {
        let mut out: Vec<String> = Vec::new();
        let Some(home) = dirs_home() else {
            return out;
        };
        let onedrive = home.join("OneDrive");
        let candidates: [PathBuf; 8] = [
            home.join("Desktop").join("Code"),
            home.join("Desktop"),
            onedrive.join("Desktop").join("Code"),
            onedrive.join("Desktop"),
            home.join("Documents").join("Code"),
            home.join("Documents").join("GitHub"),
            home.join("Code"),
            home.join("dev"),
        ];
        for p in candidates {
            if p.is_dir() {
                let s = p.to_string_lossy().into_owned();
                if !out.contains(&s) {
                    out.push(s);
                }
            }
        }
        out
    })
    .await
    .unwrap_or_default()
}

/// Walk a list of root directories looking for `.git` folders. Returns
/// every git repo found, with optional remote URL.
///
/// Used by ProjectsView to surface repos the user has on disk but hasn't
/// touched with Claude Code recently — those don't appear in the
/// JSONL-driven `scan_projects` list.
///
/// Why bounded `max_depth` (default 4): unbounded walks of a `~` tree
/// hit `node_modules`, `AppData`, etc. and become unusable. Combined
/// with `DISK_SCAN_PRUNE` we keep the walk under a couple of seconds
/// even on a populated `~/Code` tree.
///
/// Why we stop descending once `.git` is found: avoids treating
/// submodules as separate projects.
#[tauri::command]
async fn disk_scan_git_repos(
    roots: Vec<String>,
    max_depth: Option<u32>,
) -> Result<Vec<DiskGitRepo>, String> {
    let depth = max_depth.unwrap_or(4).min(8);
    tokio::task::spawn_blocking(move || disk_scan_git_repos_blocking(roots, depth))
        .await
        .map_err(|e| format!("disk_scan_git_repos task join: {e}"))
}

/// List every folder VS Code has open in its workspace storage. Each
/// workspace storage subdir contains a `workspace.json` with a `folder`
/// field as a `file:///` URL — we decode that back to a Windows path
/// and return the unique set.
///
/// Why this exists: the user's main complaint with the JSONL-driven
/// project list is that it only includes folders where `claude` ran —
/// projects they edit in VS Code without claude don't show up. VS Code
/// keeps a perfect list right here. This IPC surfaces it so the
/// renderer can union it into Projects view.
///
/// File system, not SQLite — modern VS Code does also write to a
/// `state.vscdb` SQLite store, but the per-workspace `workspace.json`
/// files are still maintained and require no extra dependency to read.
#[tauri::command]
async fn vscode_workspace_folders() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| -> Vec<String> {
        // %APPDATA%\Code\User\workspaceStorage\<hash>\workspace.json
        let Some(appdata) = std::env::var_os("APPDATA") else {
            return vec![];
        };
        let root = PathBuf::from(appdata)
            .join("Code")
            .join("User")
            .join("workspaceStorage");
        if !root.is_dir() {
            return vec![];
        }
        let entries = match fs::read_dir(&root) {
            Ok(e) => e,
            Err(_) => return vec![],
        };
        let mut seen: std::collections::HashSet<String> = Default::default();
        let mut out: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            let workspace_json = entry.path().join("workspace.json");
            if !workspace_json.is_file() {
                continue;
            }
            let body = match fs::read_to_string(&workspace_json) {
                Ok(b) => b,
                Err(_) => continue,
            };
            // Quick parse — we only need the `folder` field.
            let parsed: serde_json::Value = match serde_json::from_str(&body) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let Some(folder_url) = parsed.get("folder").and_then(|v| v.as_str())
            else {
                continue;
            };
            // file:///c%3A/Users/... → C:\Users\...
            let path = match decode_file_url(folder_url) {
                Some(p) => p,
                None => continue,
            };
            // Confirm the folder still exists on disk (VS Code keeps
            // stale entries forever).
            if !PathBuf::from(&path).is_dir() {
                continue;
            }
            if seen.insert(path.clone()) {
                out.push(path);
            }
        }
        out.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        out
    })
    .await
    .map_err(|e| format!("vscode_workspace_folders task join: {e}"))
}

/// Convert a `file:///c%3A/Users/...` URL back into a Windows path.
/// Returns None for non-file URLs or unparseable inputs.
fn decode_file_url(url: &str) -> Option<String> {
    let stripped = url.strip_prefix("file:///")?;
    // Percent-decode the most common escapes — full RFC 3986 isn't
    // needed for VS Code's outputs in practice (just `%3A` for `:`,
    // `%20` for space, `%5C` for `\`).
    let decoded = stripped
        .replace("%3A", ":")
        .replace("%3a", ":")
        .replace("%20", " ")
        .replace("%5C", "\\")
        .replace("%5c", "\\")
        .replace('/', "\\");
    Some(decoded)
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
    /// User explicitly muted this finding via the "Ignorar" button. The
    /// audit still emits it (so the count is accurate and the user can
    /// unignore from the "Ignorados" filter chip) but the UI hides it
    /// from the default view.
    #[serde(default)]
    pub ignored: bool,
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
                // Was OpenInVscode (user reported: clicking Resolver opened
                // VS Code, showed a "Done" badge, but the finding kept
                // re-appearing on every audit run because nothing changed).
                // The actionable resolution is to DELETE the local override —
                // returns the user to the shared settings.json baseline. The
                // confirm modal explains the trade-off; user can still bail
                // and inspect manually if they want to keep local overrides.
                Some(AuditAction::DeleteFile {
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
            // Both SCRIPTS findings now route to DeleteFile. The button used
            // to OpenInExplorer (just opened the folder) — useful for review
            // but useless for actually resolving the warning. The user has to
            // click somewhere else to make the finding go away.
            //
            // DeleteFile is safe here because:
            //  - audit_resolve_delete moves to ~/.claude/backups/audit-<ts>/,
            //    not a permanent rm — fully recoverable
            //  - the confirm modal previews the exact path before action
            //  - the audit only emits these findings for files NOT in
            //    KIT_WHITELIST / LIB_WHITELIST (i.e. they're already
            //    user-added or stale legacy files by definition)
            //
            // Title shape: "Non-kit file in lib/: foo.ps1"
            let prefix_lib = "Non-kit file in lib/:";
            if let Some(rest) = title.strip_prefix(prefix_lib) {
                let filename = rest.trim();
                if !filename.is_empty() {
                    let full = claude_path_string(&format!("scripts/lib/{filename}"));
                    return Some(AuditAction::DeleteFile { path: full });
                }
            }
            // Title shape: "Non-kit file in ~/.claude/scripts/: foo.ps1"
            let prefix_scripts = "Non-kit file in ~/.claude/scripts/:";
            if let Some(rest) = title.strip_prefix(prefix_scripts) {
                let filename = rest.trim();
                if !filename.is_empty() {
                    let full = claude_path_string(&format!("scripts/{filename}"));
                    return Some(AuditAction::DeleteFile { path: full });
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
        ignored: false,
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

/// Files in ~/.claude/scripts/ that the kit installs or its scripts write at
/// runtime. Module-level so `audit_resolve_delete` can reuse the same list to
/// decide which non-kit files are safe to move to backup (anything under
/// scripts/ that is NOT in this whitelist is by definition non-kit).
const KIT_WHITELIST: &[&str] = &[
    "check-gentle-ai.sh", "daily-brief.sh",
    "startup-brief.ps1", "startup-brief-launcher.bat",
    "health-check.ps1", "standup.ps1", "claude-audit.ps1", "cleanup.ps1",
    "brief.cmd",
    "startup-kit-config.json",
    ".gentle-ai-last-check", ".daily-brief-last-date",
    ".gentle-ai-last-seen-version", ".kit-version",
    // State files written by legacy kit scripts (still installed via hooks
    // on existing setups). Audit was self-flagging these as "non-kit"
    // because the whitelist only listed inputs, not outputs.
    ".audit-summary.json", ".audit-alerted-crit",
    ".snoozed.json", ".kit-last-auto-update",
    "lib",
];

const LIB_WHITELIST: &[&str] = &[
    "config.ps1", "logging.ps1", "scan-projects.ps1", "engram.ps1",
    "themes.ps1", "git-recent.ps1", "github-prs.ps1", "self-update.ps1",
    "screen-adapt.ps1", "render-layout.ps1",
];

/// 4. SCRIPTS — flag files in ~/.claude/scripts/ and lib/ that aren't kit-installed.
fn audit_scripts(out: &mut Vec<AuditFinding>, claude_dir: &Path) {

    let scripts_dir = claude_dir.join("scripts");
    if !scripts_dir.exists() {
        return;
    }
    if let Ok(entries) = fs::read_dir(&scripts_dir) {
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            // Skip directories at scripts/ root. The DeleteFile action this
            // finding routes to refuses directories (defense in depth in
            // audit_resolve_delete), so emitting a finding the user can't
            // resolve is just noise. The "lib" directory is already covered
            // by KIT_WHITELIST; this catches any ad-hoc subfolder a user
            // might create (e.g. scripts/experiments/).
            let is_file = entry.file_type().map(|t| t.is_file()).unwrap_or(false);
            if is_file && !KIT_WHITELIST.contains(&name.as_str()) {
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
    // Auto-resolve transient errors. Right now: gentle-ai upgrade failures
    // (`[ERROR] [check-gentle-ai] Upgrade FAILED ...`) are suppressed if a
    // LATER line says `[check-gentle-ai] Up to date` — the system caught
    // up and the historical error no longer needs the user's attention.
    let has_gentle_ai_recovery = tail
        .iter()
        .any(|l| l.contains("[check-gentle-ai] Up to date"));
    let errors: Vec<&String> = tail
        .iter()
        .enumerate()
        .filter(|(_, l)| l.contains("[ERROR]"))
        .filter(|(idx, l)| {
            // Suppress only if a recovery line appears AFTER this error.
            if has_gentle_ai_recovery && l.contains("[check-gentle-ai]") {
                return !tail
                    .iter()
                    .skip(idx + 1)
                    .any(|later| later.contains("[check-gentle-ai] Up to date"));
            }
            true
        })
        .map(|(_, l)| l)
        .collect();
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

    // Mark findings the user previously ignored. The UI hides them by
    // default but a "Ignorados" filter chip can show them so the user can
    // un-mute. We never DROP findings — accuracy matters, especially for
    // crit counts.
    let ignored = read_ignored_findings_file().findings;
    if !ignored.is_empty() {
        for f in out.iter_mut() {
            if ignored
                .iter()
                .any(|ig| ig.title == f.title && ig.category == f.category && ig.detail == f.detail)
            {
                f.ignored = true;
            }
        }
    }

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
    .map_err(|e| format!("restore task join error: {e}"))
    .and_then(|res| {
        // settings.json was just rewritten — workspace_summary parses it
        // for hook/permission counts, so bust the cache.
        invalidate_workspace_summary_cache();
        res
    })
}

// ---------- engram known-projects cache (5-minute TTL) ----------

struct KnownProjectsCache {
    value: Vec<String>,
    fetched_at: Instant,
}

static KNOWN_PROJECTS_CACHE: Lazy<Mutex<Option<KnownProjectsCache>>> =
    Lazy::new(|| Mutex::new(None));

const KNOWN_PROJECTS_TTL: Duration = Duration::from_secs(5 * 60);

/// Bust the engram-projects cache so the next read re-fetches. Call from
/// IPCs that mutate engram state (sync_import, sync_export, etc.) — without
/// this, the renderer can show stale projects for up to 5 minutes after
/// the user just imported a fresh set.
fn invalidate_known_projects_cache() {
    if let Ok(mut guard) = KNOWN_PROJECTS_CACHE.lock() {
        *guard = None;
    }
}

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
async fn engram_known_projects() -> Vec<String> {
    // Wrap in spawn_blocking so a cold cache (which shells out to
    // `engram projects list`, ~1-3s on slow disk / engram first run)
    // doesn't block the Tauri IPC thread. Without this, AppV3's
    // mount-time fetch could freeze the UI for the duration. Returns
    // an empty Vec on join error — caller already treats "no projects"
    // as a benign empty state.
    tokio::task::spawn_blocking(known_projects_cached)
        .await
        .unwrap_or_default()
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
    // Strip the `\\?\` UNC long-path prefix that `canonicalize` adds on
    // Windows. Without this, every consumer of validate_open_path (most
    // notably `open_in_vscode`) hands VS Code a path like
    // `\\?\C:\Users\foo\bar`. VS Code stores that verbatim in its
    // workspace state — when the Claude Code extension's activation
    // iterates `vscode.workspace.workspaceFolders` it crashes with
    // `TypeError: V is not iterable` and the sidebar (`claudeVSCodeSidebar*`)
    // refuses to load. The user reported this was a regression from
    // opening projects via CSK vs Explorer — Explorer's "Open with Code"
    // never produces UNC-prefixed paths.
    Ok(strip_unc_prefix(canonical))
}

/// Locate `Code.exe` the same way Windows resolves "Open with Code" —
/// query the user's registered handler at
/// `HKCU\Software\Classes\Applications\Code.exe\shell\open\command`,
/// extract the executable path, fall back to well-known install dirs.
///
/// Why we want the absolute Code.exe path (not bare `code.cmd`):
/// `code.cmd` is a CLI wrapper that runs `Code.exe cli.js …` and flashes a
/// cmd console window during dispatch. On some setups the cmd window
/// stays visible until cli.js exits — looks unprofessional and can stick
/// indefinitely if cli.js' IPC handshake stalls. Code.exe is a pure GUI
/// app: no console, no flash, no leftover window.
fn resolve_vscode_exe() -> Option<String> {
    if let Ok(out) = silent_command("reg")
        .args([
            "query",
            r"HKCU\Software\Classes\Applications\Code.exe\shell\open\command",
        ])
        .output()
    {
        if out.status.success() {
            let text = String::from_utf8_lossy(&out.stdout);
            // Default value line looks like:
            //   (Predeterminado)/(Default)  REG_SZ  "C:\…\Code.exe" "%1"
            // Extract the first quoted token — the binary path.
            if let Some(start) = text.find('"') {
                if let Some(rel_end) = text[start + 1..].find('"') {
                    let candidate = &text[start + 1..start + 1 + rel_end];
                    if Path::new(candidate).is_file() {
                        return Some(candidate.to_string());
                    }
                }
            }
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        candidates.push(PathBuf::from(&local).join("Programs\\Microsoft VS Code\\Code.exe"));
    }
    if let Some(pf) = std::env::var_os("PROGRAMFILES") {
        candidates.push(PathBuf::from(&pf).join("Microsoft VS Code\\Code.exe"));
    }
    if let Some(pfx86) = std::env::var_os("PROGRAMFILES(X86)") {
        candidates.push(PathBuf::from(&pfx86).join("Microsoft VS Code\\Code.exe"));
    }
    candidates
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// Audit-Resolver-only delete helper for files outside `cleanup_apply`'s
/// confinement (`~/.claude/{logs,backups,projects}`).
///
/// Why this exists: the DRIFT finding "settings.local.json exists — overrides
/// settings.json" used to map to OpenInVscode (the user reported it never
/// actually resolved — Resolver opened the file, showed Done, finding kept
/// reappearing). Now it maps to DeleteFile, but `cleanup_apply` would reject
/// `~/.claude/settings.local.json` because it's outside the cleanup roots.
///
/// Security: explicit hardcoded allowlist of paths the audit is allowed to
/// resolve via deletion. A renderer-supplied `path` MUST canonicalize to
/// one of the allowlisted entries, otherwise we reject. We do NOT just trust
/// the path matches — paths from JSONL or settings can carry `\\?\` UNC
/// prefixes or symlink games.
///
/// Recoverability: the file isn't permanently deleted — it's MOVED to
/// `~/.claude/backups/audit-<unix-ts>/<filename>` so the user can pull it
/// back if they regret the resolution. Same backups dir Claude Code uses
/// for settings backups.
#[tauri::command]
async fn audit_resolve_delete(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let home = dirs_home().ok_or_else(|| "home dir unavailable".to_string())?;
        let claude_root = home.join(".claude");
        let scripts_dir = claude_root.join("scripts");
        let lib_dir = scripts_dir.join("lib");
        let explicit_allowed: Vec<PathBuf> = vec![claude_root.join("settings.local.json")];

        let target = Path::new(&path);
        if !target.exists() {
            // Idempotent: if the file is already gone we treat as success
            // so the audit refresh reflects reality without spurious errors.
            return Ok(());
        }
        let canonical_target = target
            .canonicalize()
            .map_err(|e| format!("canonicalize target: {e}"))?;

        // Defense in depth: reject directories outright. The audit dir scan
        // (audit_scripts) only iterates entries by name without filtering by
        // file_type at the scripts/ root level, so if a user ever creates a
        // subdirectory under ~/.claude/scripts/ that isn't in KIT_WHITELIST
        // (e.g. an ad-hoc 'experiments/' folder), it would emit a finding
        // and the SCRIPTS allowlist branch below would otherwise accept it.
        // fs::rename of a directory works on Windows but moves the entire
        // tree — way too sharp an edge for an audit "resolver". Force the
        // user to handle directories manually.
        if canonical_target.is_dir() {
            return Err(format!(
                "audit_resolve_delete: refusing to move directory: {path}"
            ));
        }

        // Three acceptance paths — each canonicalises before comparing so
        // symlink games / UNC prefixes can't trick the check.
        //
        // 1. Explicit allowlist (settings.local.json today).
        // 2. Non-kit file directly under ~/.claude/scripts/. Parent must be
        //    scripts_dir itself, filename must NOT be in KIT_WHITELIST. This
        //    is what the SCRIPTS audit findings route here.
        // 3. Non-kit file under ~/.claude/scripts/lib/. Parent must be
        //    lib_dir, filename must NOT be in LIB_WHITELIST.
        let canonical_explicit: Vec<PathBuf> = explicit_allowed
            .iter()
            .filter_map(|p| fs::canonicalize(p).ok())
            .collect();
        let canonical_scripts = fs::canonicalize(&scripts_dir).ok();
        let canonical_lib = fs::canonicalize(&lib_dir).ok();

        let in_explicit = canonical_explicit
            .iter()
            .any(|a| a == &canonical_target);

        let in_scripts_non_kit = canonical_scripts
            .as_ref()
            .zip(canonical_target.parent())
            .map(|(scripts, parent)| parent == scripts.as_path())
            .unwrap_or(false)
            && canonical_target
                .file_name()
                .map(|n| !KIT_WHITELIST.contains(&n.to_string_lossy().as_ref()))
                .unwrap_or(false);

        let in_lib_non_kit = canonical_lib
            .as_ref()
            .zip(canonical_target.parent())
            .map(|(lib, parent)| parent == lib.as_path())
            .unwrap_or(false)
            && canonical_target
                .file_name()
                .map(|n| !LIB_WHITELIST.contains(&n.to_string_lossy().as_ref()))
                .unwrap_or(false);

        if !(in_explicit || in_scripts_non_kit || in_lib_non_kit) {
            return Err(format!(
                "audit_resolve_delete: path not in allowlist: {path}"
            ));
        }

        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".to_string());
        let backup_dir = claude_root.join("backups").join(format!("audit-{ts}"));
        fs::create_dir_all(&backup_dir).map_err(|e| format!("create backup dir: {e}"))?;
        let filename = canonical_target
            .file_name()
            .ok_or_else(|| "target has no filename".to_string())?;
        let dest = backup_dir.join(filename);
        fs::rename(&canonical_target, &dest).map_err(|e| format!("move to backup: {e}"))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

// ============================================================================
// ENGRAM SYNC — wrap `engram sync` (push/pull/status) so users can move
// memories between PCs through any transport (git repo, USB, OneDrive, etc.).
//
// Engram already does the heavy lifting:
//   `engram sync --all`     → exports a compressed chunk to .engram/chunks/
//   `engram sync --import`  → imports new chunks from .engram/chunks/
//   `engram sync --status`  → reports local/remote/pending counts
//
// Our job is just to run the binary with cwd = user-picked sync directory and
// surface stdout/stderr to the renderer. No parsing — the UI shows the raw
// output verbatim so future engram CLI changes don't require app updates.
// ============================================================================

fn run_engram_sync(sync_dir: &str, args: &[&str]) -> Result<String, String> {
    let dir = Path::new(sync_dir);
    if !dir.exists() {
        return Err(format!("sync directory not found: {sync_dir}"));
    }
    if !dir.is_dir() {
        return Err(format!("sync path is not a directory: {sync_dir}"));
    }
    let output = silent_command("engram")
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| format_spawn_error("engram", &e))?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
    if !output.status.success() {
        // engram prints user-facing errors to stderr; surface both streams so
        // the user can see whatever the CLI said.
        let combined = if stderr.trim().is_empty() {
            stdout
        } else if stdout.trim().is_empty() {
            stderr
        } else {
            format!("{stdout}\n{stderr}")
        };
        return Err(combined.trim().to_string());
    }
    // Some success paths still print informational text to stderr (the GH
    // rate-limit warning, for example). Concat both so nothing is lost.
    if stderr.trim().is_empty() {
        Ok(stdout)
    } else {
        Ok(format!("{stdout}\n{stderr}"))
    }
}

#[tauri::command]
async fn engram_sync_push(sync_dir: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_engram_sync(&sync_dir, &["sync", "--all"]))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn engram_sync_pull(sync_dir: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_engram_sync(&sync_dir, &["sync", "--import"]))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn engram_sync_status(sync_dir: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || run_engram_sync(&sync_dir, &["sync", "--status"]))
        .await
        .map_err(|e| format!("task join: {e}"))?
}

// ─── Output style / persona ───────────────────────────────────────────────
//
// gentle-ai writes a top-level `outputStyle` key into `~/.claude/settings.json`
// (e.g. `"Gentleman"`) to pin Claude's persona. CSK surfaces it read-only in
// Settings so the user knows what persona is active without opening the file.
#[tauri::command]
async fn read_output_style() -> Result<Option<String>, String> {
    tokio::task::spawn_blocking(move || -> Result<Option<String>, String> {
        let home = dirs_home().ok_or_else(|| "no home dir".to_string())?;
        let claude_dir = home.join(".claude");
        let settings = load_settings(&claude_dir)?;
        Ok(settings
            .as_ref()
            .and_then(|v| v.get("outputStyle"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()))
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

// ─── Engram search → file → VS Code ───────────────────────────────────────
//
// Cmd+K palette wants to surface "Search engram for '<query>'" as a fallback
// when nothing else matches the query. Shelling out to `engram search` from
// the renderer, parsing in JS, then writing a file from the renderer would
// require 3 IPC round-trips and exposing FS write to the webview. Do it all
// here: run `engram search`, write a markdown file with the raw output, open
// VS Code at it. Same handoff pattern as `audit_open_in_claude`.
#[tauri::command]
async fn engram_search_to_file(query: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || -> Result<String, String> {
        let q = query.trim();
        if q.is_empty() {
            return Err("empty query".to_string());
        }
        let home = dirs_home().ok_or_else(|| "no home dir".to_string())?;
        let claude_dir = home.join(".claude");
        if !claude_dir.exists() {
            return Err(format!(
                "~/.claude directory missing at {}",
                claude_dir.display()
            ));
        }

        let output = silent_command("engram")
            .args(["search", q, "--limit", "10"])
            .output()
            .map_err(|e| format_spawn_error("engram", &e))?;
        let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&output.stderr).into_owned();
        if !output.status.success() {
            let combined = if stderr.trim().is_empty() {
                stdout
            } else if stdout.trim().is_empty() {
                stderr
            } else {
                format!("{stdout}\n{stderr}")
            };
            return Err(combined.trim().to_string());
        }

        let body = if stdout.trim().is_empty() {
            "_(no results)_".to_string()
        } else {
            format!("```\n{}\n```", stdout.trim_end())
        };
        let mut md = String::new();
        md.push_str("# Engram search\n\n");
        md.push_str(&format!("Query: `{q}`\n\n"));
        md.push_str(&body);
        if !stderr.trim().is_empty() {
            md.push_str("\n\n---\n\n");
            md.push_str("**stderr**\n\n```\n");
            md.push_str(stderr.trim_end());
            md.push_str("\n```\n");
        }

        let out_path = claude_dir.join("engram-search-result.md");
        fs::write(&out_path, &md).map_err(|e| format!("write result file: {e}"))?;

        let program = resolve_vscode_exe().ok_or_else(|| {
            "VS Code no encontrado. Instalalo desde https://code.visualstudio.com/."
                .to_string()
        })?;
        silent_command(&program)
            .arg(&out_path)
            .spawn()
            .map_err(|e| format_spawn_error("VS Code (Code.exe)", &e))?;

        Ok(out_path.to_string_lossy().to_string())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

// ─── Skill registry per project ───────────────────────────────────────────
//
// gentle-ai's `UserPromptSubmit` hook writes `.atl/skill-registry.md` into
// each project's cwd. Surface it from the Projects view via a single IPC
// that validates the project path, joins the registry file, and either
// opens it in VS Code or returns a hint message the renderer can show.
#[tauri::command]
async fn open_skill_registry(project_path: String) -> Result<(), String> {
    let canonical = validate_open_path(&project_path)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let registry = canonical.join(".atl").join("skill-registry.md");
        if !registry.exists() {
            // Renderer keys off this exact prefix to swap in the localized
            // hint. Don't reword without updating ProjectsView.
            return Err("missing".to_string());
        }
        let program = resolve_vscode_exe().ok_or_else(|| {
            "VS Code no encontrado. Instalalo desde https://code.visualstudio.com/."
                .to_string()
        })?;
        silent_command(&program)
            .arg(&registry)
            .spawn()
            .map_err(|e| format_spawn_error("VS Code (Code.exe)", &e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn open_in_vscode(path: String) -> Result<(), String> {
    let canonical = validate_open_path(&path)?;
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        // Spawn `Code.exe` directly — no `code.cmd`, no `cmd /c start`.
        // Mirrors Explorer's "Open with Code" registered handler at
        // HKCU\Software\Classes\Applications\Code.exe\shell\open\command,
        // which is `"…\\Code.exe" "%1"`. Direct GUI launch — no console
        // flash, no leftover cmd window if the .cmd wrapper's cli.js
        // hangs. `validate_open_path` already rejects leading-`-`
        // paths, so we don't need a `--` separator.
        let program = resolve_vscode_exe().ok_or_else(|| {
            "VS Code no encontrado. Instalalo desde https://code.visualstudio.com/."
                .to_string()
        })?;
        silent_command(&program)
            .arg(&canonical)
            .spawn()
            .map_err(|e| format_spawn_error("VS Code (Code.exe)", &e))?;
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

// ─── Fix Claude VS Code extension ─────────────────────────────────────────
//
// The Anthropic Claude Code extension ships with a hardcoded Linux CI path
// inside `extension.js` (`file:///home/runner/work/.../sdk.mjs`). On Windows
// the VS Code activation throws "command 'claude-vscode.editor.openLast'
// not found". The PowerShell script bundled below patches every installed
// `anthropic.claude-code-*` extension (under `.vscode`, `.vscode-insiders`,
// `.cursor`, `.windsurf`) by replacing the bad URL with a local
// file://<this-extension>/extension.js. Backs up to `extension.js.bak`
// and is idempotent: re-running on an already-patched install is a no-op.
//
// We embed the script via include_str! so the binary is self-contained;
// at call time we drop it to a temp file and run with PowerShell.

const FIX_VSCODE_SCRIPT: &str =
    include_str!("../scripts/fix-claude-vscode-extension.ps1");

#[tauri::command]
async fn fix_claude_vscode_extension() -> Result<String, String> {
    tokio::task::spawn_blocking(|| -> Result<String, String> {
        let mut tmp = std::env::temp_dir();
        // Unique-ish name so re-runs don't clobber if the script lingers.
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        tmp.push(format!("csk-fix-claude-vscode-{stamp}.ps1"));
        fs::write(&tmp, FIX_VSCODE_SCRIPT)
            .map_err(|e| format!("write temp script: {e}"))?;

        let out = Command::new("powershell")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
            ])
            .arg(&tmp)
            .output()
            .map_err(|e| format!("spawn powershell: {e}"))?;

        // Best-effort cleanup; ignore failure (Windows sometimes holds the
        // handle for a tick).
        let _ = fs::remove_file(&tmp);

        let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
        let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
        if !out.status.success() {
            return Err(format!(
                "fix script exited {}:\n{stderr}\n{stdout}",
                out.status
            ));
        }
        let combined = if stderr.trim().is_empty() {
            stdout
        } else {
            format!("{stdout}\n{stderr}")
        };
        Ok(combined.trim().to_string())
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
    .map_err(|e| format!("task join: {e}"))
    .and_then(|res| {
        // workspace_summary surfaces enabled-MCP counts; bust so the
        // right-panel widget reflects the toggle immediately.
        invalidate_workspace_summary_cache();
        res
    })
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
            .map_err(|e| format_spawn_error("gh", &e))
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
        .map_err(|e| format!("update check failed: {e}"))?;
    // Mirror-skew guard. The banner shown by `check_app_update` (GitHub
    // Releases REST API) and `apply_app_update` (`tauri-plugin-updater`
    // hitting `latest.json` on the public mirror repo) are TWO different
    // sources of truth. They desync any time the release workflow publishes
    // the GH Release before pushing `latest.json` to the mirror — the
    // window where a user sees "v0.1.x → v0.1.y" but Apply returns None.
    // Surface a distinct, actionable error instead of the cryptic "no
    // update available" so the user knows to retry instead of opening a
    // bug.
    let update = update.ok_or_else(|| {
        "MIRROR_LAG: el espejo todavía no publicó esta versión. Probá de nuevo en 1-2 min."
            .to_string()
    })?;
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

/// Bust the workspace summary cache. Call from IPCs that change anything
/// the WorkspaceCard reads (gentle-ai version after upgrade, MCP toggles,
/// settings restore). Without this the right-panel widget can show stale
/// counts/versions for up to 5 minutes after the user takes action.
fn invalidate_workspace_summary_cache() {
    if let Ok(mut guard) = WORKSPACE_SUMMARY_CACHE.lock() {
        *guard = None;
    }
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
            .map_err(|e| format_spawn_error("powershell", &e))
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
    // The WorkspaceCard surfaces gentle-ai version via workspace_summary;
    // without this bust it would keep showing the pre-upgrade version for
    // up to 5 minutes.
    invalidate_workspace_summary_cache();
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
        // Sentinel: if gentle-ai printed lines that LOOK like the table
        // shape (`[ok] foo …`, `[--] bar …`, `[!] baz …`) but our parser
        // matched zero rows, the upstream format probably changed. Surface
        // it loudly instead of silently claiming "no managed tools" — a
        // silent format drift would gaslight users about what's installed.
        let bracket_lines = stdout
            .lines()
            .filter(|l| {
                let t = l.trim_start();
                t.starts_with('[') && t.find(']').is_some_and(|i| i < 8)
            })
            .count();
        if bracket_lines > 0 && rows.is_empty() {
            return Err(format!(
                "gentle-ai update output unrecognized: {bracket_lines} bracketed lines but parser matched 0. \
                 Upstream probably changed the format — actualizá gentle-ai (gentle-ai upgrade) y/o reportá si persiste."
            ));
        }
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

/// Fallback list of managed tool process names we know about — used only
/// when `discover_stack_tool_names()` can't reach `gentle-ai update`. The
/// runtime discovery path is preferred so new tools added by upstream
/// (opencode-*, future additions) participate automatically without code
/// changes here. On Windows a running .exe can't be renamed/replaced, so
/// `gentle-ai upgrade` fails with "rename ...engram-upgrade-NNN" errors —
/// we taskkill these before delegating to gentle-ai.
///
/// Claude Code re-spawns its MCP servers (engram, etc.) on the next session,
/// so killing them mid-app is recoverable — the user just won't have engram
/// available in *currently open* Claude Code instances until they reload.
const STACK_TOOL_PROCESS_NAMES_FALLBACK: &[&str] = &["engram", "gga"];

/// Discover which managed-tool binaries are currently installed by parsing
/// `gentle-ai update`. Returns the names of every tool whose state isn't
/// `not_installed` — those are the ones that could have a live process
/// holding their .exe and need a taskkill before the upgrade. Falls back
/// to the hardcoded list on any failure (gentle-ai missing, format drift,
/// network issue).
fn discover_stack_tool_names(program: &str) -> Vec<String> {
    let output = match silent_command(program).arg("update").output() {
        Ok(o) if o.status.success() => o,
        _ => return STACK_TOOL_PROCESS_NAMES_FALLBACK
            .iter()
            .map(|s| s.to_string())
            .collect(),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let names: Vec<String> = stdout
        .lines()
        .filter_map(parse_gentle_ai_update_line)
        .filter(|row| row.state != "not_installed")
        .map(|row| row.name)
        .collect();
    if names.is_empty() {
        STACK_TOOL_PROCESS_NAMES_FALLBACK
            .iter()
            .map(|s| s.to_string())
            .collect()
    } else {
        names
    }
}

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
        // Resolve gentle-ai first so we can both discover the runtime
        // process-name list AND run the upgrade with the same binary.
        let program = resolve_gentle_ai()
            .ok_or_else(|| "gentle-ai not installed on this machine".to_string())?;

        // Kill any live instances of managed tool binaries. Names come
        // from `gentle-ai update` so new upstream tools participate
        // automatically — falls back to the hardcoded list if discovery
        // fails. Errors are best-effort (process might already be gone,
        // or `taskkill` might need admin for some).
        let process_names = discover_stack_tool_names(&program);
        for name in &process_names {
            let _ = silent_command("taskkill")
                .args(["/IM", &format!("{}.exe", name), "/F"])
                .output();
        }
        // Bumped from 800ms — Defender's real-time scan has been observed
        // holding handles to just-killed binaries on slow/contended
        // machines, causing the rename-then-replace inside `gentle-ai
        // upgrade` to fail with "Access is denied". 1.5s is empirically
        // enough without making the user wait noticeably.
        std::thread::sleep(Duration::from_millis(1500));

        // Phase 1 — `gentle-ai upgrade` for everything except gentle-ai itself.
        // Reuses the `program` resolved at the top of the function (same
        // PATH-inheritance dance as check_stack_update / read_gentle_ai_version
        // — without it, the upgrade silently no-ops on auto-updated app
        // instances).
        let out = silent_command(&program)
            .arg("upgrade")
            .output()
            .map_err(|e| format_spawn_error("gentle-ai", &e))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            let stdout = String::from_utf8_lossy(&out.stdout);
            // Friendly hint when Windows refused the rename-and-replace
            // because something held a binary handle (Defender / running
            // process / open VS Code window). The raw stderr alone says
            // "Access is denied" with the temp filename — uninformative.
            let combined = format!("{stderr}\n{stdout}");
            let lower = combined.to_lowercase();
            if lower.contains("access is denied")
                || lower.contains("rename")
                    && lower.contains("upgrade")
            {
                return Err(format!(
                    "Una herramienta del stack tenía un binario bloqueado durante el upgrade. \
                     Cerrá Claude Code y todas las terminales abiertas, y dale 'Actualizar todo' otra vez.\n\n\
                     Detalle:\n{stderr}{stdout}"
                ));
            }
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
                .map_err(|e| format_spawn_error("powershell", &e))?;
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
    .map_err(|e| format!("task join: {e}"))
    .and_then(|res| {
        // Stack upgrade can change every managed-tool version, including
        // gentle-ai itself which is surfaced in workspace_summary. Bust the
        // cache so the next render fetches fresh.
        invalidate_workspace_summary_cache();
        res
    })
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

/// State of the local sync mirror vs the remote — the user's "another
/// machine has pushed; you should pull" awareness. Returned by
/// `sync_remote_status` IPC so SyncView can surface a banner without the
/// user having to remember to import periodically.
#[derive(Serialize, Clone)]
pub struct SyncRemoteStatus {
    pub configured: bool,
    /// True if the remote HEAD points at a different commit than ours.
    pub behind: bool,
    pub remote_sha: String,
    pub local_sha: String,
    /// Empty on the happy path. Populated when we couldn't reach the
    /// remote (offline, auth dropped, etc.) so the renderer can surface
    /// a passive hint instead of a hard error — sync still works
    /// manually if the user wants to retry.
    pub error: String,
}

/// Compare the local sync mirror's HEAD against the remote's `HEAD` ref
/// without pulling anything. Used by SyncView to nudge the user when
/// another machine has pushed since our last import — without this, the
/// user has to remember to click Import on a schedule.
///
/// `git ls-remote origin HEAD` is the cheap path: a single round-trip to
/// the remote, no fetch, no working-tree update. Comparing the returned
/// SHA against our local `git rev-parse HEAD` tells us whether we're
/// behind.
///
/// Errors are non-fatal: if `ls-remote` fails (offline, transient gh
/// auth issue), we surface it via the `error` field but keep
/// `configured=true` so the UI doesn't pretend sync is broken.
#[tauri::command]
async fn sync_remote_status() -> Result<SyncRemoteStatus, String> {
    tokio::task::spawn_blocking(|| -> Result<SyncRemoteStatus, String> {
        let state = read_sync_state();
        if !state.configured {
            return Ok(SyncRemoteStatus {
                configured: false,
                behind: false,
                remote_sha: String::new(),
                local_sha: String::new(),
                error: String::new(),
            });
        }
        let repo_dir = sync_repo_dir()
            .ok_or_else(|| "home dir unavailable".to_string())?;
        if !repo_dir.exists() {
            return Ok(SyncRemoteStatus {
                configured: true,
                behind: false,
                remote_sha: String::new(),
                local_sha: String::new(),
                error: "Sync repo missing — run setup again".to_string(),
            });
        }
        let local_sha = git_in(&repo_dir, &["rev-parse", "HEAD"]).unwrap_or_default();
        let remote_out = silent_command("git")
            .current_dir(&repo_dir)
            .args(["ls-remote", "origin", "HEAD"])
            .output()
            .map_err(|e| format_spawn_error("git", &e))?;
        if !remote_out.status.success() {
            let stderr = String::from_utf8_lossy(&remote_out.stderr);
            return Ok(SyncRemoteStatus {
                configured: true,
                behind: false,
                remote_sha: String::new(),
                local_sha,
                error: format!("git ls-remote: {}", stderr.trim()),
            });
        }
        let remote_text = String::from_utf8_lossy(&remote_out.stdout);
        let remote_sha = remote_text
            .split_whitespace()
            .next()
            .unwrap_or("")
            .to_string();
        let behind = !remote_sha.is_empty()
            && !local_sha.is_empty()
            && remote_sha != local_sha;
        Ok(SyncRemoteStatus {
            configured: true,
            behind,
            remote_sha,
            local_sha,
            error: String::new(),
        })
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

// Run a `git` subcommand inside the sync repo. Returns combined output
// trimmed of trailing whitespace. Used to keep call sites short.
fn git_in(repo: &Path, args: &[&str]) -> Result<String, String> {
    let out = silent_command("git")
        .current_dir(repo)
        .args(args)
        .output()
        .map_err(|e| format_spawn_error("git", &e))?;
    if !out.status.success() {
        let stderr = String::from_utf8_lossy(&out.stderr);
        return Err(format!("git {} failed: {stderr}", args.join(" ")));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Run a `git commit` (or any identity-requiring git command) without
/// depending on the user having `user.name` / `user.email` set globally.
///
/// Why: on a fresh Windows install or a dev machine where the user uses
/// CSK before configuring git, plain `git commit` fails with `Author
/// identity unknown — Please tell me who you are`. We refuse to touch
/// the user's global git config (per project policy — see CLAUDE.md and
/// the global rule "NEVER update the git config"), so we pass the
/// identity inline via `-c` flags instead.
///
/// The identity is a CSK-bot value, not the user's real name/email. Sync
/// commits get squash-amended on every push so author history isn't
/// useful anyway; the only thing that matters is that `git commit`
/// succeeds.
fn git_commit_in(repo: &Path, args: &[&str]) -> Result<String, String> {
    let mut prefixed: Vec<&str> = vec![
        "-c",
        "user.name=Claude Startup Kit Sync",
        "-c",
        "user.email=csk-sync@local",
    ];
    prefixed.extend_from_slice(args);
    git_in(repo, &prefixed)
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
            .map_err(|e| format_spawn_error("gh", &e))?;
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
            .map_err(|e| format_spawn_error("gh", &e))?;
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
            .map_err(|e| format_spawn_error("gh repo create", &e))?;
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
            .map_err(|e| format_spawn_error("git clone", &e))?;
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
            let _ = git_commit_in(&repo_dir, &["commit", "-m", "init: csk sync"]);
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
            .map_err(|e| format_spawn_error("engram", &e))?;
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
        // Both branches need identity injected — without it, `git commit`
        // fails with "Author identity unknown" on machines where the user
        // never set `user.name` / `user.email` globally.
        let amend = silent_command("git")
            .current_dir(&repo_dir)
            .args([
                "-c",
                "user.name=Claude Startup Kit Sync",
                "-c",
                "user.email=csk-sync@local",
                "commit",
                "--amend",
                "-m",
                "sync",
            ])
            .output()
            .map_err(|e| format_spawn_error("git", &e))?;
        if !amend.status.success() {
            // No commit to amend (fresh repo) — make the first one.
            git_commit_in(&repo_dir, &["commit", "-m", "sync"])?;
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
            .map_err(|e| format_spawn_error("engram", &e))?;
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
        // engram now has new project records — bust the cache so
        // enrich_projects re-resolves goals against the fresh dataset
        // instead of the pre-import snapshot.
        invalidate_known_projects_cache();
        invalidate_workspace_summary_cache();
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

/// One row returned by `gh_list_repos` — every repo the authenticated `gh`
/// user owns or is a collaborator on. Renderer-friendly subset of what
/// `gh repo list --json` returns.
#[derive(Serialize, Clone)]
pub struct GhRepo {
    pub name: String,
    /// `owner/name` form — matches Sync's `repo_full_name`.
    pub full_name: String,
    pub description: String,
    pub url: String,
    /// `https://github.com/<owner>/<name>.git` — what we hand to `git clone`.
    pub clone_url: String,
    pub updated_at: String,
    pub is_private: bool,
}

/// List every repo the authenticated `gh` user can see (own + collaborator).
/// Used by SyncView to surface a "Tus repos en GitHub" picker so the user
/// can clone any of them, not just the small subset already tracked in
/// the sync mirror.
///
/// Bare `gh` shell-out — fails with a friendly hint if the CLI isn't
/// authenticated. Limit 100 because `gh repo list` paginates beyond that
/// and we don't want to chain pages today; if the user has more than 100
/// repos we'll need `--paginate` and a streaming loop later.
#[tauri::command]
async fn gh_list_repos() -> Result<Vec<GhRepo>, String> {
    tokio::task::spawn_blocking(|| -> Result<Vec<GhRepo>, String> {
        // `--limit 1000` plays nicer than `--paginate` here: gh's
        // pagination flag streams JSON arrays per page, requiring extra
        // glue to merge. With a flat 1000 cap we cover virtually every
        // user (typical accounts have a few hundred repos) in a single
        // round trip and a single JSON parse. If a user has more than
        // 1000 repos, an explicit `--paginate` rewrite is the next step.
        let out = silent_command("gh")
            .args([
                "repo",
                "list",
                "--limit",
                "1000",
                "--json",
                "name,nameWithOwner,description,url,updatedAt,isPrivate",
            ])
            .output()
            .map_err(|e| format_spawn_error("gh", &e))?;
        if !out.status.success() {
            let stderr = String::from_utf8_lossy(&out.stderr);
            // gh's "not authenticated" message is multi-line; flatten + hint.
            if stderr.to_lowercase().contains("not logged") {
                return Err(
                    "gh CLI no autenticado. Corré 'gh auth login' en una terminal y volvé a darle Buscar.".to_string()
                );
            }
            return Err(format!("gh repo list: {}", stderr.trim()));
        }
        let stdout = String::from_utf8_lossy(&out.stdout);
        let raw: Vec<serde_json::Value> = serde_json::from_str(&stdout)
            .map_err(|e| format!("parse gh output: {e}"))?;
        let result: Vec<GhRepo> = raw
            .into_iter()
            .filter_map(|v| {
                let name = v.get("name")?.as_str()?.to_string();
                let full = v.get("nameWithOwner")?.as_str()?.to_string();
                let url = v.get("url")?.as_str()?.to_string();
                let description = v
                    .get("description")
                    .and_then(|d| d.as_str())
                    .unwrap_or("")
                    .to_string();
                let updated = v
                    .get("updatedAt")
                    .and_then(|d| d.as_str())
                    .unwrap_or("")
                    .to_string();
                let is_private = v
                    .get("isPrivate")
                    .and_then(|p| p.as_bool())
                    .unwrap_or(false);
                let clone_url = format!("https://github.com/{full}.git");
                Some(GhRepo {
                    name,
                    full_name: full,
                    description,
                    url,
                    clone_url,
                    updated_at: updated,
                    is_private,
                })
            })
            .collect();
        Ok(result)
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
            .map_err(|e| format_spawn_error("git clone", &e))?;
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

/// Prepend well-known user-scoped bin dirs to the process `PATH` so every
/// `Command::new(<bare-name>)` downstream resolves correctly.
///
/// Why this exists: after a Tauri auto-update the new app instance can
/// inherit a `PATH` that's missing per-user install dirs (`%LOCALAPPDATA%\
/// engram\bin`, `%LOCALAPPDATA%\Programs\Microsoft VS Code\bin`, `~\go\bin`,
/// `~\bin`, `%APPDATA%\npm`). Each shell-out — `engram`, `code.cmd`,
/// `gentle-ai`, `gh`, `git`, `bash` — can then fail with "program not
/// found" even though the same command works from a fresh terminal. We
/// were patching this per-tool (`resolve_gentle_ai`, `resolve_managed_tool`)
/// but new shell-outs kept regressing — sync's `engram` and audit/projects'
/// `code.cmd` are the latest. One central fix here neutralizes the whole
/// class.
///
/// Every dir is derived from environment variables (`LOCALAPPDATA`,
/// `APPDATA`, `USERPROFILE`/`HOME`, `PROGRAMFILES`) — universal across
/// machines. We only prepend dirs that exist AND aren't already in `PATH`,
/// so this is a no-op on a fully-configured shell environment.
fn augment_path_with_user_bin_dirs() {
    let mut to_add: Vec<PathBuf> = Vec::new();

    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        // Per-tool installer destinations (gentle-ai, engram, …).
        to_add.push(local.join("gentle-ai\\bin"));
        to_add.push(local.join("engram\\bin"));
        // VS Code default per-user install drops `code.cmd` here.
        to_add.push(local.join("Programs\\Microsoft VS Code\\bin"));
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        // npm install -g target on Windows.
        to_add.push(PathBuf::from(appdata).join("npm"));
    }
    if let Some(home) = dirs_home() {
        to_add.push(home.join("go").join("bin"));
        to_add.push(home.join("bin"));
        to_add.push(home.join(".local").join("bin"));
    }
    if let Some(pf) = std::env::var_os("PROGRAMFILES") {
        let pf = PathBuf::from(pf);
        to_add.push(pf.join("Microsoft VS Code\\bin"));
        // GitHub CLI default install — used by sync, PR queue, update-check.
        to_add.push(pf.join("GitHub CLI"));
        // Git for Windows — used by clone_project, git_last_commit, gentle-ai
        // self-upgrade. Both `cmd` (where git.exe lives for shell-out) and
        // `bin` (where bash.exe lives — gga.ps1 wrapper depends on it).
        to_add.push(pf.join("Git\\cmd"));
        to_add.push(pf.join("Git\\bin"));
    }
    if let Some(pfx86) = std::env::var_os("PROGRAMFILES(X86)") {
        let pfx86 = PathBuf::from(pfx86);
        to_add.push(pfx86.join("Microsoft VS Code\\bin"));
        to_add.push(pfx86.join("GitHub CLI"));
        to_add.push(pfx86.join("Git\\cmd"));
        to_add.push(pfx86.join("Git\\bin"));
    }
    // PowerShell + System32 — usually inherited but a stripped post-update
    // PATH has been observed to lose them. Cheap to insert defensively.
    if let Some(windir) = std::env::var_os("WINDIR") {
        let windir = PathBuf::from(windir);
        to_add.push(windir.join("System32"));
        to_add.push(windir.join("System32\\WindowsPowerShell\\v1.0"));
    }

    let current_path = std::env::var_os("PATH").unwrap_or_default();
    let existing: Vec<PathBuf> = std::env::split_paths(&current_path).collect();

    let prepend: Vec<PathBuf> = to_add
        .into_iter()
        .filter(|p| p.is_dir() && !existing.iter().any(|e| e == p))
        .collect();

    if prepend.is_empty() {
        return;
    }

    let combined: Vec<PathBuf> = prepend
        .into_iter()
        .chain(existing.into_iter())
        .collect();
    if let Ok(joined) = std::env::join_paths(combined) {
        std::env::set_var("PATH", joined);
    }
}

// ============================================================
// Todos — per-project todo list persisted to ~/.claude/csk-todos.json
// Single flat array keyed by absolute project path. File auto-creates
// on first write. No DB, no schema migrations.
// ============================================================

#[derive(Debug, Serialize, Deserialize, Clone)]
struct Todo {
    id: String,
    project: String,
    text: String,
    done: bool,
    created_at: u64,
    updated_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct TodosFile {
    #[serde(default = "default_todos_version")]
    version: u32,
    #[serde(default)]
    todos: Vec<Todo>,
}

fn default_todos_version() -> u32 {
    1
}

fn todos_path() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".claude").join("csk-todos.json"))
}

fn read_todos_file() -> Result<TodosFile, String> {
    let path = todos_path().ok_or_else(|| "no home dir".to_string())?;
    if !path.exists() {
        return Ok(TodosFile {
            version: 1,
            todos: Vec::new(),
        });
    }
    let body = fs::read_to_string(&path).map_err(|e| format!("read todos: {e}"))?;
    if body.trim().is_empty() {
        return Ok(TodosFile {
            version: 1,
            todos: Vec::new(),
        });
    }
    serde_json::from_str(&body).map_err(|e| format!("parse todos: {e}"))
}

fn write_todos_file(file: &TodosFile) -> Result<(), String> {
    let path = todos_path().ok_or_else(|| "no home dir".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let body = serde_json::to_string_pretty(file).map_err(|e| format!("serialize todos: {e}"))?;
    fs::write(&path, body).map_err(|e| format!("write todos: {e}"))?;
    Ok(())
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn gen_todo_id() -> String {
    // Nano timestamp is unique enough for single-user local data.
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("t-{nanos:x}")
}

#[tauri::command]
async fn list_todos(project: Option<String>) -> Result<Vec<Todo>, String> {
    tokio::task::spawn_blocking(move || -> Result<Vec<Todo>, String> {
        let f = read_todos_file()?;
        let mut out: Vec<Todo> = match project {
            Some(p) if !p.is_empty() => f.todos.into_iter().filter(|t| t.project == p).collect(),
            _ => f.todos,
        };
        // Pending first; within each group, newest update first.
        out.sort_by(|a, b| {
            a.done
                .cmp(&b.done)
                .then(b.updated_at.cmp(&a.updated_at))
        });
        Ok(out)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn add_todo(project: String, text: String) -> Result<Todo, String> {
    let project = project.trim().to_string();
    let text = text.trim().to_string();
    if project.is_empty() {
        return Err("project required".to_string());
    }
    if text.is_empty() {
        return Err("text required".to_string());
    }
    tokio::task::spawn_blocking(move || -> Result<Todo, String> {
        let mut f = read_todos_file()?;
        let now = now_secs();
        let todo = Todo {
            id: gen_todo_id(),
            project,
            text,
            done: false,
            created_at: now,
            updated_at: now,
        };
        f.todos.push(todo.clone());
        if f.version == 0 {
            f.version = 1;
        }
        write_todos_file(&f)?;
        Ok(todo)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn toggle_todo(id: String) -> Result<Todo, String> {
    tokio::task::spawn_blocking(move || -> Result<Todo, String> {
        let mut f = read_todos_file()?;
        let now = now_secs();
        let item = f
            .todos
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| "todo not found".to_string())?;
        item.done = !item.done;
        item.updated_at = now;
        let snapshot = item.clone();
        write_todos_file(&f)?;
        Ok(snapshot)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn delete_todo(id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut f = read_todos_file()?;
        let before = f.todos.len();
        f.todos.retain(|t| t.id != id);
        if f.todos.len() == before {
            return Err("todo not found".to_string());
        }
        write_todos_file(&f)?;
        Ok(())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn update_todo(id: String, text: String) -> Result<Todo, String> {
    let text = text.trim().to_string();
    if text.is_empty() {
        return Err("text required".to_string());
    }
    tokio::task::spawn_blocking(move || -> Result<Todo, String> {
        let mut f = read_todos_file()?;
        let now = now_secs();
        let item = f
            .todos
            .iter_mut()
            .find(|t| t.id == id)
            .ok_or_else(|| "todo not found".to_string())?;
        item.text = text;
        item.updated_at = now;
        let snapshot = item.clone();
        write_todos_file(&f)?;
        Ok(snapshot)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

// ============================================================
// Daily Standup — combines `git log` of the last N hours across known
// projects + recently-completed todos + best-effort engram session
// summaries. Produces a structured report the frontend formats into a
// punchy "yesterday / today / blockers" message.
// ============================================================

#[derive(Debug, Serialize, Clone)]
struct StandupCommit {
    project_path: String,
    project_name: String,
    sha: String,
    subject: String,
    branch: Option<String>,
    timestamp: String,
}

#[derive(Debug, Serialize, Clone)]
struct StandupTodo {
    project_path: String,
    project_name: String,
    text: String,
    completed_at: String,
}

#[derive(Debug, Serialize, Clone)]
struct StandupReport {
    generated_at: String,
    window_hours: u32,
    commits: Vec<StandupCommit>,
    completed_todos: Vec<StandupTodo>,
    open_todos: Vec<StandupTodo>,
    engram_summary_lines: Vec<String>,
    projects_touched: Vec<String>,
}

/// Best-effort: read the current branch name. Returns None if the project
/// isn't a git repo, git isn't on PATH, or the command fails. We never
/// surface this as an error to the caller — the standup is "as much info
/// as I can scrape, never blocking".
fn git_current_branch_blocking(path: &str) -> Option<String> {
    let output = silent_command("git")
        .args(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() || raw == "HEAD" {
        // Detached HEAD — surface nothing rather than a confusing "HEAD".
        return None;
    }
    Some(raw)
}

/// `git log --since=<ISO> --pretty=format:%H%x00%ct%x00%s --no-merges`
/// parsed into commits. NUL byte (\x00) separator avoids subject-line
/// collisions with `|` or other pipe-friendly delimiters.
fn git_commits_since_blocking(path: &str, since_iso: &str) -> Vec<(String, i64, String)> {
    let project = Path::new(path);
    if !project.is_dir() || !project.join(".git").exists() {
        return Vec::new();
    }
    let output = match silent_command("git")
        .args([
            "-C",
            path,
            "log",
            &format!("--since={since_iso}"),
            "--pretty=format:%H%x00%ct%x00%s",
            "--no-merges",
        ])
        .output()
    {
        Ok(o) => o,
        Err(_) => return Vec::new(),
    };
    if !output.status.success() {
        return Vec::new();
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut out = Vec::new();
    for line in stdout.lines() {
        if line.trim().is_empty() {
            continue;
        }
        let mut parts = line.splitn(3, '\x00');
        let hash = match parts.next() {
            Some(h) if !h.is_empty() => h.to_string(),
            _ => continue,
        };
        let ts: i64 = parts
            .next()
            .and_then(|s| s.parse::<i64>().ok())
            .unwrap_or(0);
        let subject = parts.next().unwrap_or("").to_string();
        out.push((hash, ts, subject));
        if out.len() >= 20 {
            break;
        }
    }
    out
}

/// Best-effort engram recent memory. Pulls the latest session summary
/// observations via `engram search`. Returns trimmed non-empty lines.
/// NEVER errors — a missing `engram` binary or non-zero exit produces
/// an empty Vec, the view degrades to "no memory entries".
fn engram_timeline_lines_blocking(_window_hours: u32) -> Vec<String> {
    // Real engram v1.x: `engram search <query> --type <kind> --limit N`.
    // We bias the query to session summaries since those are the highest-
    // signal recent observations; fall back to a bare recent search if
    // that returns nothing.
    let summary = silent_command("engram")
        .args([
            "search",
            "session summary",
            "--type",
            "session_summary",
            "--limit",
            "10",
        ])
        .output();
    if let Ok(out) = summary {
        if out.status.success() {
            let lines = parse_engram_lines(&String::from_utf8_lossy(&out.stdout));
            if !lines.is_empty() {
                return lines;
            }
        }
    }
    // Fallback: any recent observation. Query is intentionally generic so
    // the search returns the most-recently-updated entries regardless of
    // topic.
    let recent = silent_command("engram")
        .args(["search", "recent", "--limit", "10"])
        .output();
    if let Ok(out) = recent {
        if out.status.success() {
            return parse_engram_lines(&String::from_utf8_lossy(&out.stdout));
        }
    }
    Vec::new()
}

fn parse_engram_lines(raw: &str) -> Vec<String> {
    raw.lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .take(20)
        .collect()
}

fn standup_project_name(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .unwrap_or_else(|| path.to_string())
}

fn daily_standup_blocking(window_hours: u32) -> StandupReport {
    let window_hours = window_hours.clamp(1, 168);
    let now = Utc::now();
    let since = now - chrono::Duration::hours(window_hours as i64);
    let since_secs = since.timestamp();
    let since_iso = since.to_rfc3339();

    // Project list: enumerate via scan_projects with a window wide enough
    // to cover anything that could plausibly have commits in the standup
    // window. 14 days mirrors the AppV3 default; a project untouched for
    // 2+ weeks won't have commits in the last 1-week window anyway.
    let projects = scan_projects_blocking(14);

    let mut commits: Vec<StandupCommit> = Vec::new();
    for p in &projects {
        let branch = git_current_branch_blocking(&p.path);
        let entries = git_commits_since_blocking(&p.path, &since_iso);
        if entries.is_empty() {
            continue;
        }
        let project_name = standup_project_name(&p.path);
        for (hash, ts, subject) in entries {
            let sha: String = hash.chars().take(7).collect();
            let timestamp = DateTime::<Utc>::from_timestamp(ts, 0)
                .map(|d| d.to_rfc3339())
                .unwrap_or_default();
            commits.push(StandupCommit {
                project_path: p.path.clone(),
                project_name: project_name.clone(),
                sha,
                subject,
                branch: branch.clone(),
                timestamp,
            });
        }
    }
    // Sort commits newest-first across all projects so the rendered list
    // reads as a single chronological feed.
    commits.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));

    // Todos: completed in window + currently open (top 10 by updated_at).
    let mut completed_todos: Vec<StandupTodo> = Vec::new();
    let mut open_todos: Vec<StandupTodo> = Vec::new();
    if let Ok(file) = read_todos_file() {
        let mut open_pool: Vec<(u64, Todo)> = Vec::new();
        for t in file.todos {
            let project_name = standup_project_name(&t.project);
            if t.done && (t.updated_at as i64) >= since_secs {
                let completed_at = DateTime::<Utc>::from_timestamp(t.updated_at as i64, 0)
                    .map(|d| d.to_rfc3339())
                    .unwrap_or_default();
                completed_todos.push(StandupTodo {
                    project_path: t.project.clone(),
                    project_name: project_name.clone(),
                    text: t.text.clone(),
                    completed_at,
                });
            } else if !t.done {
                open_pool.push((t.updated_at, t));
            }
        }
        // Newest-touched open todos first.
        open_pool.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, t) in open_pool.into_iter().take(10) {
            let project_name = standup_project_name(&t.project);
            let completed_at = DateTime::<Utc>::from_timestamp(t.updated_at as i64, 0)
                .map(|d| d.to_rfc3339())
                .unwrap_or_default();
            open_todos.push(StandupTodo {
                project_path: t.project,
                project_name,
                text: t.text,
                completed_at,
            });
        }
        // Completed todos: newest-first.
        completed_todos.sort_by(|a, b| b.completed_at.cmp(&a.completed_at));
    }

    let engram_summary_lines = engram_timeline_lines_blocking(window_hours);

    // Union of project_paths from any signal.
    let mut projects_touched: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for c in &commits {
        if seen.insert(c.project_path.clone()) {
            projects_touched.push(c.project_path.clone());
        }
    }
    for t in completed_todos.iter().chain(open_todos.iter()) {
        if seen.insert(t.project_path.clone()) {
            projects_touched.push(t.project_path.clone());
        }
    }

    StandupReport {
        generated_at: now.to_rfc3339(),
        window_hours,
        commits,
        completed_todos,
        open_todos,
        engram_summary_lines,
        projects_touched,
    }
}

#[tauri::command]
async fn daily_standup(window_hours: Option<u32>) -> Result<StandupReport, String> {
    let hours = window_hours.unwrap_or(24);
    tokio::task::spawn_blocking(move || daily_standup_blocking(hours))
        .await
        .map_err(|e| format!("daily_standup task join: {e}"))
}

// ─── Audit auto-resolver ──────────────────────────────────────────────────
//
// Applies known-safe fixes the audit found, without user intervention.
// Currently:
//   1. Trims `[ERROR] [check-gentle-ai] Upgrade FAILED` lines from
//      startup-kit.log when a later line shows the system recovered.
//   2. Deletes audit backup folders older than 30 days.
// Other findings (DRIFT, HOOKS, PERMS) need user judgment — not auto-fixed.

#[derive(Debug, Serialize)]
struct AutoResolveReport {
    trimmed_gentle_ai_errors: u32,
    deleted_backups: u32,
    notes: Vec<String>,
}

#[tauri::command]
async fn audit_auto_resolve() -> Result<AutoResolveReport, String> {
    tokio::task::spawn_blocking(|| -> Result<AutoResolveReport, String> {
        let home = dirs_home().ok_or_else(|| "no home dir".to_string())?;
        let claude_dir = home.join(".claude");
        let mut report = AutoResolveReport {
            trimmed_gentle_ai_errors: 0,
            deleted_backups: 0,
            notes: Vec::new(),
        };

        // 1. Trim resolved gentle-ai errors from startup-kit.log.
        let log_path = claude_dir.join("logs").join("startup-kit.log");
        if log_path.exists() {
            let content = fs::read_to_string(&log_path).unwrap_or_default();
            let lines: Vec<&str> = content.lines().collect();
            let has_recovery = lines
                .iter()
                .any(|l| l.contains("[check-gentle-ai] Up to date"));
            if has_recovery {
                let mut kept: Vec<&str> = Vec::with_capacity(lines.len());
                let mut trimmed: u32 = 0;
                for (i, line) in lines.iter().enumerate() {
                    let is_gentle_ai_error =
                        line.contains("[ERROR]") && line.contains("[check-gentle-ai]");
                    if is_gentle_ai_error {
                        let later_recovery = lines
                            .iter()
                            .skip(i + 1)
                            .any(|l| l.contains("[check-gentle-ai] Up to date"));
                        if later_recovery {
                            trimmed += 1;
                            continue;
                        }
                    }
                    kept.push(line);
                }
                if trimmed > 0 {
                    let mut new_content = kept.join("\n");
                    if !new_content.is_empty() {
                        new_content.push('\n');
                    }
                    fs::write(&log_path, new_content)
                        .map_err(|e| format!("rewrite log: {e}"))?;
                    report.trimmed_gentle_ai_errors = trimmed;
                    report.notes.push(format!(
                        "Trimmed {trimmed} resolved gentle-ai error line(s) from startup-kit.log"
                    ));
                }
            }
        }

        // 2. Delete audit backups older than 30 days.
        let backups_dir = claude_dir.join("backups");
        if backups_dir.exists() {
            let cutoff = SystemTime::now() - Duration::from_secs(30 * 24 * 3600);
            if let Ok(entries) = fs::read_dir(&backups_dir) {
                for entry in entries.flatten() {
                    let p = entry.path();
                    let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
                        continue;
                    };
                    if !name.starts_with("audit-") {
                        continue;
                    }
                    let Ok(meta) = entry.metadata() else {
                        continue;
                    };
                    let Ok(modified) = meta.modified() else {
                        continue;
                    };
                    if modified < cutoff && fs::remove_dir_all(&p).is_ok() {
                        report.deleted_backups += 1;
                    }
                }
                if report.deleted_backups > 0 {
                    report.notes.push(format!(
                        "Deleted {} audit backup(s) older than 30 days",
                        report.deleted_backups
                    ));
                }
            }
        }

        if report.notes.is_empty() {
            report.notes.push("Nothing to resolve.".to_string());
        }
        Ok(report)
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

// ─── Audit ignore list ────────────────────────────────────────────────────
//
// Persists user-muted findings to `~/.claude/csk-audit-ignored.json`. The
// key is (title, category, detail) — uniquely identifies a finding
// instance. `run_audit` marks matching findings with `ignored: true`
// instead of dropping them, so the UI can offer a "Ignorados" filter
// chip to un-mute later.

#[derive(Debug, Serialize, Deserialize, Clone)]
struct IgnoredFinding {
    title: String,
    category: String,
    detail: String,
    ignored_at: u64,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct IgnoredFindingsFile {
    #[serde(default = "default_ignored_version")]
    version: u32,
    #[serde(default)]
    findings: Vec<IgnoredFinding>,
}

fn default_ignored_version() -> u32 {
    1
}

fn ignored_findings_path() -> Option<PathBuf> {
    dirs_home().map(|h| h.join(".claude").join("csk-audit-ignored.json"))
}

fn read_ignored_findings_file() -> IgnoredFindingsFile {
    let Some(path) = ignored_findings_path() else {
        return IgnoredFindingsFile::default();
    };
    if !path.exists() {
        return IgnoredFindingsFile {
            version: 1,
            findings: Vec::new(),
        };
    }
    let body = fs::read_to_string(&path).unwrap_or_default();
    if body.trim().is_empty() {
        return IgnoredFindingsFile {
            version: 1,
            findings: Vec::new(),
        };
    }
    serde_json::from_str(&body).unwrap_or_default()
}

fn write_ignored_findings_file(file: &IgnoredFindingsFile) -> Result<(), String> {
    let path = ignored_findings_path().ok_or_else(|| "no home dir".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("create dir: {e}"))?;
    }
    let body = serde_json::to_string_pretty(file).map_err(|e| format!("serialize: {e}"))?;
    fs::write(&path, body).map_err(|e| format!("write: {e}"))
}

#[tauri::command]
async fn ignore_audit_finding(
    title: String,
    category: String,
    detail: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut file = read_ignored_findings_file();
        let already = file
            .findings
            .iter()
            .any(|f| f.title == title && f.category == category && f.detail == detail);
        if !already {
            file.findings.push(IgnoredFinding {
                title,
                category,
                detail,
                ignored_at: now_secs(),
            });
            if file.version == 0 {
                file.version = 1;
            }
            write_ignored_findings_file(&file)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

#[tauri::command]
async fn unignore_audit_finding(
    title: String,
    category: String,
    detail: String,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let mut file = read_ignored_findings_file();
        let before = file.findings.len();
        file.findings
            .retain(|f| !(f.title == title && f.category == category && f.detail == detail));
        if file.findings.len() != before {
            write_ignored_findings_file(&file)?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

// ─── Ask Claude (handoff to Claude Code) ─────────────────────────────────
//
// For findings the auto-resolver can't touch (DRIFT, HOOKS, PERMS, SCRIPTS
// — anything needing human judgment), this command opens VS Code at
// `~/.claude/` and returns a pre-built prompt the frontend writes to the
// clipboard so the user can paste it directly into Claude Code.

#[derive(Debug, Serialize)]
struct AskClaudeContext {
    prompt: String,
    opened_path: String,
}

#[tauri::command]
async fn audit_open_in_claude(
    title: String,
    level: String,
    category: String,
    detail: Option<String>,
    path: Option<String>,
) -> Result<AskClaudeContext, String> {
    tokio::task::spawn_blocking(move || -> Result<AskClaudeContext, String> {
        let home = dirs_home().ok_or_else(|| "no home dir".to_string())?;
        let claude_dir = home.join(".claude");
        if !claude_dir.exists() {
            return Err(format!(
                "~/.claude directory missing at {}",
                claude_dir.display()
            ));
        }

        // Build a Claude Code-friendly prompt with the full finding context.
        let mut prompt = String::new();
        prompt.push_str("# Audit fix — handoff to Claude Code\n\n");
        prompt.push_str("Paste the block below into the Claude Code panel.\n\n");
        prompt.push_str("---\n\n");
        prompt.push_str(
            "The Claude Startup Kit audit flagged this issue under `~/.claude/`:\n\n",
        );
        prompt.push_str(&format!("- **Severity**: {level}\n"));
        prompt.push_str(&format!("- **Category**: {category}\n"));
        prompt.push_str(&format!("- **Finding**: {title}\n"));
        if let Some(d) = detail.as_deref() {
            if !d.trim().is_empty() {
                prompt.push_str(&format!("- **Detail**: {d}\n"));
            }
        }
        if let Some(p) = path.as_deref() {
            if !p.trim().is_empty() {
                prompt.push_str(&format!("- **Path**: {p}\n"));
            }
        }
        prompt.push_str(
            "\nInvestigate the relevant files (settings.json, hooks/, scripts/) \
             and propose a fix. Don't apply changes until I confirm.\n",
        );

        // Write the prompt to a file inside ~/.claude/ so VS Code can open
        // it directly. Beats clipboard — Tauri webview clipboard can fail
        // silently and the user has no idea what happened.
        let prompt_path = claude_dir.join("audit-fix-prompt.md");
        fs::write(&prompt_path, &prompt)
            .map_err(|e| format!("write prompt file: {e}"))?;
        let opened_path = prompt_path.to_string_lossy().to_string();

        // Open VS Code AT the prompt file (not just the directory) so the
        // user sees it immediately and can copy with Ctrl+A / Ctrl+C.
        let program = resolve_vscode_exe().ok_or_else(|| {
            "VS Code no encontrado. Instalalo desde https://code.visualstudio.com/."
                .to_string()
        })?;
        silent_command(&program)
            .arg(&prompt_path)
            .spawn()
            .map_err(|e| format_spawn_error("VS Code (Code.exe)", &e))?;

        Ok(AskClaudeContext {
            prompt,
            opened_path,
        })
    })
    .await
    .map_err(|e| format!("task join: {e}"))?
}

// ─── Conversation search ──────────────────────────────────────────────────
//
// Full-text search across `~/.claude/projects/*/*.jsonl`. Returns user/
// assistant messages whose extracted text contains the query (case-
// insensitive) with a ~200-char snippet centered on the first match.
//
// Performance: each line is first fast-rejected via a lowercase substring
// scan over the raw JSONL line (much cheaper than parsing JSON for every
// line). Lines that pass the fast filter are JSON-parsed, the text content
// is extracted, and the query is re-checked against the extracted text to
// drop false positives (uuid / sessionId / file-path matches).

#[derive(Debug, Serialize, Clone)]
pub struct ConversationMatch {
    pub project_path: String,
    pub project_name: String,
    pub session_id: String,
    pub file_path: String,
    pub timestamp: String,
    pub role: String,
    pub snippet: String,
    pub git_branch: Option<String>,
}

/// Extract text content from a `message.content` JSON value. The content
/// can be a string (legacy shape) or an array of typed parts; we
/// concatenate text from the `{ "type": "text", "text": "..." }` parts.
fn extract_message_text(content: &serde_json::Value) -> String {
    if let Some(s) = content.as_str() {
        return s.to_string();
    }
    let Some(arr) = content.as_array() else {
        return String::new();
    };
    let mut parts: Vec<&str> = Vec::with_capacity(arr.len());
    for item in arr {
        if item.get("type").and_then(|v| v.as_str()) != Some("text") {
            continue;
        }
        if let Some(t) = item.get("text").and_then(|v| v.as_str()) {
            if !t.is_empty() {
                parts.push(t);
            }
        }
    }
    parts.join("\n")
}

/// Build a `~200 char` window centered on the first match in `text`. The
/// returned snippet keeps the original casing; `lower_text` and
/// `query_lower` are used to find the offset only. Newlines collapse to
/// single spaces so the renderer doesn't have to handle them.
///
/// Note: `text.to_lowercase()` can change byte length (e.g. ß → ss), so
/// the byte index returned by `lower_text.find()` is NOT guaranteed to be
/// a valid boundary in `text`. We clamp to `text.len()` and snap to the
/// nearest char boundary before slicing — worst case the snippet shifts
/// by a few bytes, never panics.
fn build_snippet(text: &str, lower_text: &str, query_lower: &str) -> String {
    let Some(byte_idx_in_lower) = lower_text.find(query_lower) else {
        // Caller should have already confirmed a match; defensively trim.
        return clamp_snippet(text, 200);
    };
    let before = 80usize;
    let after = 120usize;
    // Clamp the lower-text offset into the original-text byte range.
    let approx_idx = byte_idx_in_lower.min(text.len());
    let start_raw = approx_idx.saturating_sub(before);
    let end_raw = (approx_idx + query_lower.len() + after).min(text.len());
    // Snap to char boundaries on the ORIGINAL text (safe slicing).
    let start = floor_char_boundary(text, start_raw);
    let end = ceil_char_boundary(text, end_raw);
    let mut slice = text[start..end].replace(['\n', '\r'], " ").trim().to_string();
    if start > 0 {
        slice = format!("…{slice}");
    }
    if end < text.len() {
        slice.push('…');
    }
    slice
}

fn clamp_snippet(text: &str, max: usize) -> String {
    let collapsed = text.replace(['\n', '\r'], " ");
    if collapsed.len() <= max {
        return collapsed.trim().to_string();
    }
    let end = ceil_char_boundary(&collapsed, max);
    let mut s = collapsed[..end].trim().to_string();
    s.push('…');
    s
}

fn floor_char_boundary(s: &str, mut idx: usize) -> usize {
    if idx >= s.len() {
        return s.len();
    }
    while idx > 0 && !s.is_char_boundary(idx) {
        idx -= 1;
    }
    idx
}

fn ceil_char_boundary(s: &str, mut idx: usize) -> usize {
    let len = s.len();
    if idx >= len {
        return len;
    }
    while idx < len && !s.is_char_boundary(idx) {
        idx += 1;
    }
    idx
}

fn search_conversations_blocking(
    query: String,
    project_filter: Option<String>,
    limit: usize,
) -> Vec<ConversationMatch> {
    let q = query.trim();
    if q.is_empty() {
        return vec![];
    }
    let query_lower = q.to_lowercase();
    let Some(root) = claude_projects_dir() else {
        return vec![];
    };
    if !root.exists() {
        return vec![];
    }
    let project_filter_norm: Option<String> = project_filter
        .as_deref()
        .map(|s| s.replace('\\', "/").trim_end_matches('/').to_lowercase());

    let mut out: Vec<ConversationMatch> = Vec::new();

    let Ok(entries) = fs::read_dir(&root) else {
        return out;
    };

    'outer: for entry in entries.flatten() {
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let jsonls: Vec<PathBuf> = match fs::read_dir(&project_dir) {
            Ok(es) => es
                .flatten()
                .map(|e| e.path())
                .filter(|p| {
                    p.extension().and_then(|s| s.to_str()) == Some("jsonl")
                        && p.is_file()
                })
                .collect(),
            Err(_) => continue,
        };
        if jsonls.is_empty() {
            continue;
        }
        // Resolve the project's real cwd once per directory (cheap — reads
        // until the first cwd-bearing line).
        let cwd = match first_cwd_in_jsonls(&jsonls) {
            Some(c) => c,
            None => continue,
        };
        if let Some(filter) = &project_filter_norm {
            let cwd_norm = cwd.replace('\\', "/").trim_end_matches('/').to_lowercase();
            if &cwd_norm != filter {
                continue;
            }
        }
        let project_name = Path::new(&cwd)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or(&cwd)
            .to_string();

        for jsonl in &jsonls {
            // Fast skip if file is smaller than the query — can't possibly match.
            if let Ok(meta) = fs::metadata(jsonl) {
                if meta.len() < query_lower.len() as u64 {
                    continue;
                }
            }
            let session_id = jsonl
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_string();
            let file_path_str = jsonl.to_string_lossy().to_string();
            let Ok(file) = File::open(jsonl) else {
                continue;
            };
            let reader = BufReader::new(file);
            for line in reader.lines().map_while(Result::ok) {
                if line.is_empty() {
                    continue;
                }
                // Fast filter: raw lowercase substring check before JSON parse.
                let line_lower = line.to_lowercase();
                if !line_lower.contains(&query_lower) {
                    continue;
                }
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                let kind = val.get("type").and_then(|v| v.as_str()).unwrap_or("");
                if kind != "user" && kind != "assistant" {
                    continue;
                }
                let message = match val.get("message") {
                    Some(m) => m,
                    None => continue,
                };
                let content = match message.get("content") {
                    Some(c) => c,
                    None => continue,
                };
                let text = extract_message_text(content);
                if text.is_empty() {
                    continue;
                }
                let lower_text = text.to_lowercase();
                if !lower_text.contains(&query_lower) {
                    // Substring match was on metadata (uuid, path, etc.) — drop.
                    continue;
                }
                let role = message
                    .get("role")
                    .and_then(|v| v.as_str())
                    .unwrap_or(kind)
                    .to_string();
                let timestamp = val
                    .get("timestamp")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let git_branch = val
                    .get("gitBranch")
                    .and_then(|v| v.as_str())
                    .filter(|s| !s.is_empty())
                    .map(|s| s.to_string());
                let snippet = build_snippet(&text, &lower_text, &query_lower);

                out.push(ConversationMatch {
                    project_path: cwd.clone(),
                    project_name: project_name.clone(),
                    session_id: session_id.clone(),
                    file_path: file_path_str.clone(),
                    timestamp,
                    role,
                    snippet,
                    git_branch,
                });

                if out.len() >= limit {
                    break 'outer;
                }
            }
        }
    }

    // Newest first. Empty timestamps sort to the bottom.
    out.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    out
}

#[tauri::command]
async fn search_conversations(
    query: String,
    project: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<ConversationMatch>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(vec![]);
    }
    // Default 100, hard cap 500.
    let limit = limit.unwrap_or(100).min(500);
    let q = trimmed.to_string();
    tokio::task::spawn_blocking(move || search_conversations_blocking(q, project, limit))
        .await
        .map_err(|e| format!("search_conversations task join: {e}"))
}

// ── Token usage tracker ──────────────────────────────────────────
// Walks every `.jsonl` under `~/.claude/projects/`, accumulates
// `message.usage` fields from `type == "assistant"` rows into per-day
// buckets, and returns a windowed summary. UTC-based date math so the
// numbers don't shift around with the user's local DST.

#[derive(Debug, Serialize, Clone)]
struct DayUsage {
    date: String,
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    total: u64,
    sessions: u32,
}

#[derive(Debug, Serialize, Clone)]
struct TokenStats {
    by_day: Vec<DayUsage>,
    range_start: String,
    range_end: String,
    window_days: u32,
    total_input: u64,
    total_output: u64,
    total_cache_read: u64,
    total_cache_creation: u64,
    total_all: u64,
    sessions: u32,
    files_scanned: u32,
    lines_with_usage: u32,
}

#[derive(Default)]
struct DayAccum {
    input: u64,
    output: u64,
    cache_read: u64,
    cache_creation: u64,
    sessions: std::collections::HashSet<String>,
}

fn token_usage_blocking(window_days: u32) -> TokenStats {
    use chrono::NaiveDate;
    use std::collections::{HashMap, HashSet};

    // Clamp the window: at least 1 day, hard-capped at 365 to avoid runaway
    // scans on machines with years of JSONL history.
    let window_days = window_days.max(1).min(365);

    let today: NaiveDate = Utc::now().date_naive();
    // window_days inclusive of today — e.g. 30 days = today + 29 prior days.
    let range_start: NaiveDate = today
        .checked_sub_days(chrono::Days::new((window_days - 1) as u64))
        .unwrap_or(today);

    let empty = TokenStats {
        by_day: Vec::new(),
        range_start: range_start.format("%Y-%m-%d").to_string(),
        range_end: today.format("%Y-%m-%d").to_string(),
        window_days,
        total_input: 0,
        total_output: 0,
        total_cache_read: 0,
        total_cache_creation: 0,
        total_all: 0,
        sessions: 0,
        files_scanned: 0,
        lines_with_usage: 0,
    };

    let Some(root) = claude_projects_dir() else {
        return empty;
    };
    if !root.exists() {
        return empty;
    }

    let mut per_day: HashMap<NaiveDate, DayAccum> = HashMap::new();
    let mut all_sessions: HashSet<String> = HashSet::new();
    let mut files_scanned: u32 = 0;
    let mut lines_with_usage: u32 = 0;

    let Ok(entries) = fs::read_dir(&root) else {
        return empty;
    };
    for entry in entries.flatten() {
        let project_dir = entry.path();
        if !project_dir.is_dir() {
            continue;
        }
        let Ok(es) = fs::read_dir(&project_dir) else {
            continue;
        };
        for e in es.flatten() {
            let path = e.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            if !path.is_file() {
                continue;
            }
            // Cheap pre-skip: jsonl file mtime older than range_start by a
            // long margin can be skipped entirely. We still read the file if
            // mtime is within range OR if we can't tell. Most files are
            // tiny so the cost is mainly disk-bound IO.
            if let Ok(meta) = e.metadata() {
                if let Ok(mtime) = meta.modified() {
                    if let Ok(dur) = mtime.duration_since(UNIX_EPOCH) {
                        let secs = dur.as_secs() as i64;
                        if let Some(dt) = DateTime::<Utc>::from_timestamp(secs, 0) {
                            let mtime_date = dt.date_naive();
                            if mtime_date < range_start {
                                // File hasn't been touched within the window — but a
                                // JSONL whose last assistant message is older than
                                // range_start can still contain in-window rows if
                                // appended weirdly. In practice mtime ≈ last write,
                                // so skipping is safe and shaves a lot of IO.
                                continue;
                            }
                        }
                    }
                }
            }
            files_scanned += 1;
            let Ok(file) = File::open(&path) else {
                continue;
            };
            let reader = BufReader::new(file);
            for line in reader.lines().map_while(Result::ok) {
                if line.is_empty() {
                    continue;
                }
                // Fast filter: every assistant-with-usage row contains the
                // literal substring "usage". Skipping lines without it saves
                // a JSON parse on user messages and partial streams.
                if !line.contains("\"usage\"") {
                    continue;
                }
                let Ok(val) = serde_json::from_str::<serde_json::Value>(&line) else {
                    continue;
                };
                if val.get("type").and_then(|v| v.as_str()) != Some("assistant") {
                    continue;
                }
                let Some(usage) = val.get("message").and_then(|m| m.get("usage")) else {
                    continue;
                };
                let ts = match val.get("timestamp").and_then(|v| v.as_str()) {
                    Some(s) if !s.is_empty() => s,
                    _ => continue,
                };
                let Ok(parsed) = DateTime::parse_from_rfc3339(ts) else {
                    continue;
                };
                let date_utc = parsed.with_timezone(&Utc).date_naive();
                if date_utc < range_start || date_utc > today {
                    continue;
                }
                let input = usage.get("input_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let output = usage.get("output_tokens").and_then(|v| v.as_u64()).unwrap_or(0);
                let cache_read = usage
                    .get("cache_read_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                let cache_creation = usage
                    .get("cache_creation_input_tokens")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(0);
                if input == 0 && output == 0 && cache_read == 0 && cache_creation == 0 {
                    // Empty usage record — count it as "lines_with_usage" since the
                    // shape is there, but skip accumulation. The user-visible total
                    // doesn't move and the row still contributes a session.
                }
                let session_id = val
                    .get("sessionId")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                lines_with_usage = lines_with_usage.saturating_add(1);
                let bucket = per_day.entry(date_utc).or_default();
                bucket.input = bucket.input.saturating_add(input);
                bucket.output = bucket.output.saturating_add(output);
                bucket.cache_read = bucket.cache_read.saturating_add(cache_read);
                bucket.cache_creation = bucket.cache_creation.saturating_add(cache_creation);
                if !session_id.is_empty() {
                    bucket.sessions.insert(session_id.clone());
                    all_sessions.insert(session_id);
                }
            }
        }
    }

    // Build the contiguous `by_day` array — zero rows for gap-fill so the
    // sparkline reads cleanly without holes.
    let mut by_day: Vec<DayUsage> = Vec::with_capacity(window_days as usize);
    let mut cursor = range_start;
    let mut total_input = 0u64;
    let mut total_output = 0u64;
    let mut total_cache_read = 0u64;
    let mut total_cache_creation = 0u64;
    while cursor <= today {
        let entry = per_day.remove(&cursor).unwrap_or_default();
        let total = entry.input
            + entry.output
            + entry.cache_read
            + entry.cache_creation;
        total_input = total_input.saturating_add(entry.input);
        total_output = total_output.saturating_add(entry.output);
        total_cache_read = total_cache_read.saturating_add(entry.cache_read);
        total_cache_creation = total_cache_creation.saturating_add(entry.cache_creation);
        by_day.push(DayUsage {
            date: cursor.format("%Y-%m-%d").to_string(),
            input: entry.input,
            output: entry.output,
            cache_read: entry.cache_read,
            cache_creation: entry.cache_creation,
            total,
            sessions: entry.sessions.len() as u32,
        });
        cursor = match cursor.succ_opt() {
            Some(d) => d,
            None => break,
        };
    }

    let total_all = total_input
        .saturating_add(total_output)
        .saturating_add(total_cache_read)
        .saturating_add(total_cache_creation);

    TokenStats {
        by_day,
        range_start: range_start.format("%Y-%m-%d").to_string(),
        range_end: today.format("%Y-%m-%d").to_string(),
        window_days,
        total_input,
        total_output,
        total_cache_read,
        total_cache_creation,
        total_all,
        sessions: all_sessions.len() as u32,
        files_scanned,
        lines_with_usage,
    }
}

#[tauri::command]
async fn token_usage(window_days: Option<u32>) -> Result<TokenStats, String> {
    let w = window_days.unwrap_or(30);
    tokio::task::spawn_blocking(move || token_usage_blocking(w))
        .await
        .map_err(|e| format!("token_usage task join: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    augment_path_with_user_bin_dirs();
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
            disk_scan_git_repos,
            default_disk_scan_roots,
            vscode_workspace_folders,
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
            audit_resolve_delete,
            audit_auto_resolve,
            audit_open_in_claude,
            ignore_audit_finding,
            unignore_audit_finding,
            engram_sync_push,
            engram_sync_pull,
            engram_sync_status,
            read_output_style,
            engram_search_to_file,
            open_skill_registry,
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
            sync_remote_status,
            sync_setup,
            gh_username,
            sync_export,
            sync_import,
            sync_disconnect,
            sync_listed_projects,
            gh_list_repos,
            clone_project,
            list_claude_skills,
            count_claude_skill_usage,
            list_mcp_servers,
            toggle_mcp_server,
            fix_claude_vscode_extension,
            list_todos,
            add_todo,
            toggle_todo,
            delete_todo,
            update_todo,
            search_conversations,
            token_usage,
            daily_standup
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
