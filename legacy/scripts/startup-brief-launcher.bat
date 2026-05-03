@echo off
REM Claude Code Daily Brief — Windows Startup launcher
REM Starts MINIMIZED so it does NOT steal focus at boot. The PS script then
REM shows it in background (SW_SHOWNOACTIVATE) — visible but not active.
start "Claude Code Daily Brief" /MIN cmd.exe /c "mode con: cols=120 lines=32 && chcp 65001 > nul && powershell.exe -NoProfile -ExecutionPolicy Bypass -File ""%USERPROFILE%\.claude\scripts\startup-brief.ps1"""
