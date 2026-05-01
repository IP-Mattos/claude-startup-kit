@echo off
REM Claude Startup Kit — tray daemon launcher.
REM Starts the persistent tray icon process. Uses a hidden window so nothing
REM flashes at boot. Single-instance enforced inside tray.ps1 via Mutex.
start "" /B powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%USERPROFILE%\.claude\scripts\tray.ps1"
