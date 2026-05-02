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
