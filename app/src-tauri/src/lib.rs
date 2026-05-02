use chrono::{DateTime, Local, Utc};
use serde::Serialize;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

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

#[tauri::command]
fn scan_projects(window_days: u64) -> Vec<Project> {
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
        if !Path::new(&cwd).is_dir() {
            continue;
        }
        let days_ago = (now.saturating_sub(mtime)) / 86_400;
        let last_date = DateTime::<Utc>::from_timestamp(mtime as i64, 0)
            .map(|d| d.with_timezone(&Local).format("%Y-%m-%d").to_string())
            .unwrap_or_default();
        out.push(Project {
            path: cwd,
            mtime,
            days_ago,
            last_date,
        });
    }
    out.sort_by(|a, b| b.mtime.cmp(&a.mtime));
    out
}

#[derive(Serialize, Clone)]
pub struct AuditFinding {
    pub level: String,
    pub category: String,
    pub title: String,
    pub detail: String,
}

#[tauri::command]
fn run_audit() -> Result<Vec<AuditFinding>, String> {
    let script = dirs_home()
        .map(|h| h.join(".claude").join("scripts").join("claude-audit.ps1"))
        .ok_or_else(|| "no home directory".to_string())?;
    if !script.exists() {
        return Err(format!("audit script not found at {}", script.display()));
    }
    let output = Command::new("powershell")
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
    // PowerShell JSON uses PascalCase fields; deserialize into a generic Value first.
    let raw: serde_json::Value =
        serde_json::from_str(text.trim()).map_err(|e| format!("audit JSON parse: {e}"))?;
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
fn engram_known_projects() -> Vec<String> {
    let Ok(output) = Command::new("engram").args(["projects", "list"]).output() else {
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
        if token.len() >= 1 && token.chars().next().unwrap().is_ascii_alphanumeric() {
            let lc = token.to_lowercase();
            if !names.contains(&lc) {
                names.push(lc);
            }
        }
    }
    names
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

#[tauri::command]
fn engram_project_goal(path: String, known: Vec<String>) -> Option<String> {
    let leaf = Path::new(&path).file_name()?.to_str()?.to_string();
    if leaf.is_empty() {
        return None;
    }
    let project_name = resolve_engram_project(&leaf, &known);
    let output = Command::new("engram")
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

#[tauri::command]
fn git_last_commit(path: String) -> Option<GitInfo> {
    let project = Path::new(&path);
    if !project.is_dir() {
        return None;
    }
    if !project.join(".git").exists() {
        return None;
    }
    let output = Command::new("git")
        .args(["-C", &path, "log", "-1", "--pretty=format:%h|%cr|%an|%s"])
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
fn open_in_vscode(path: String) -> Result<(), String> {
    // Use code.cmd explicitly so cmd.exe doesn't pick the MSYS wrapper.
    let status = Command::new("cmd")
        .args(["/c", "code.cmd", &path])
        .status()
        .map_err(|e| format!("failed to launch VS Code: {e}"))?;
    if !status.success() {
        return Err(format!("code.cmd exited with status {status}"));
    }
    Ok(())
}

#[tauri::command]
fn open_path_in_explorer(path: String) -> Result<(), String> {
    Command::new("explorer")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("failed to open explorer: {e}"))?;
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            scan_projects,
            git_last_commit,
            engram_known_projects,
            engram_project_goal,
            run_audit,
            open_in_vscode,
            open_path_in_explorer
        ])
        .setup(|app| {
            let show_i = MenuItem::with_id(app, "show", "Show window", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
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
